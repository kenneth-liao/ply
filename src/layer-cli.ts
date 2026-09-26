#!/usr/bin/env bun
// Layer management CLI: edit, inspect, and list Layers within a Project.
import { parseArgs } from "node:util";
import path from "node:path";
import { inspectLayer, listLayers, editLayer, resolveCoverCanvasTarget, roundEffective, formatGrade, formatGlow, unitEditFactRefusal, UNIT_EDIT_OPTION_KEYS, type ResolvedLayer } from "./layer.js";
import { type AnchorResolution, type ParsedAnchor } from "./layer-anchor.js";
import {
  LAYER_OPTION_PARSE_ARGS,
  anyLayerEditOptionProvided,
  parseLayerUnitTarget,
  applyLayerOption,
  checkEditLayerOptions,
  layerDashNumericFlags,
  layerEditOptionKeys,
  type EditLayerCheck,
  type EditLayerRefusal,
  type LayerOptionArgs,
  type SharedOptionDraft,
  RESIZE_TO_HELP_KINDS,
  SCALE_HELP_KINDS,
  COVER_TO_HELP_KINDS,
  buildRunStyleEdits,
  MASK_REMOVAL_VALUE,
} from "./layer-options.js";
import { reviewRetainedLayer } from "./evidence-review.js";
import { resolveMaskEdit } from "./composition.js";
import { formatFill, normalizeStoredTextFill, type LayerFill } from "./fill.js";
import { parseLayerAddress, resolveLayerToken, LayerAddressSyntaxError, type ResolvedLayerToken } from "./layer-address.js";
import { closeCliBrowser } from "./cli-browser.js";
import { helpResult, usageMessage, joinDashLeadingNumericValues } from "./cli-present.js";

// Exported for the CLI-seam test's HELP pin (#326, the composition-cli.ts
// #289 shape): the published usage lines enumerate the dispatched commands.
export const HELP = `
layer — Layer management and inspection within a Project

Name addressing: wherever a Layer id is accepted — layer edit, layer
inspect, and layer review — a Composition-plus-use name address
"<composition>/<use>" is also accepted. It resolves to the referenced
Layer's id once, at the command boundary; unknown Compositions and uses
are refused listing what exists, and a Layer id continues to work
everywhere. With --fork, the address supplies the target Composition
and use, so --composition/--use need not be repeated (repeating them
must match the address).

  ply layer edit <layer-id> [options]
  ply layer edit <composition>/<use> [options]
      Edit a Layer's content or placement, advancing its current revision.
      Requires --in-place when referenced by multiple Compositions.
      With --fork, publish a new Layer identity and retarget only the
      selected use in --composition; other Compositions are unaffected.
      Resize changes placement, never retained pixels: --resize <factor>
      multiplies the current scale (relative), --resize-to <WxH> sets an
      absolute effective size (image and shape Layers only; one omitted axis
      preserves the aspect ratio), --cover-to <WxH|canvas> scales an image
      Layer to FILL a target box with the aspect preserved (the overflow
      stays outside the canvas), --scale <factor> sets the absolute
      uniform scale, and --scale-to <XxY> sets the absolute per-axis scale
      (one stored fact: either setter replaces the current scale; "1x1"
      removes it) — the
      same command twice keeps the same scale (never compounding).
      --rotate sets an ABSOLUTE rotation in degrees: the
      same command twice is still the same angle (unlike the relative resize
      factor), and 0 removes the rotation. --flip sets an ABSOLUTE reflection
      state (horizontal, vertical, both, or none): it replaces the current
      flip state, and none removes the reflection. --anchor places the
      Layer's visible painted ink at a target position (see below).

  ply layer inspect <layer-id> [options]
  ply layer inspect <composition>/<use> [options]
      Inspect a Layer's identity, current revision, and content details

  ply layer review <layer-id> --out <path> [options]
  ply layer review <composition>/<use> --out <path> [options]
      Build the offline evidence review sheet for a generated or matted
      Layer from retained Project evidence — References (shown only when
      their recorded paths still verify; unavailable ones are labeled, never
      substituted), the candidate, and the associated matte. Evidence only:
      no approval or promotion is implied.

  ply layer list [options]
      List all Layers in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --in-place            Explicitly advance Layer revision in-place across all
                        referring Compositions (required when referrers > 1)
  --fork                Fork instead: publish a new Layer identity with the
                        edited revision and retarget only the selected use.
                        Mutually exclusive with --in-place; --composition and
                        --use are required. A fork always creates a new
                        identity, even when no edit option changes content.
  --fork-unit <name>    With --fork on a unit Layer: the caller-supplied name
                        of the new inner Composition the fork copies (same
                        canvas, the same use list — the member Layers stay
                        shared). Required with --fork on a unit; refused on a
                        non-unit fork; a name clash or a cycle refuses before
                        anything is published (ADR-0026 §3, #341).
  --composition <name>  Target Composition for --fork (required with --fork)
  --use <local-name>    Target use local name for --fork (required with --fork)
  --image <path>        New source image file for an image Layer: a regular
                        local PNG, JPEG, WebP, or SVG file. An SVG keeps its
                        vector format — the intrinsic size comes from the
                        file's own width/height or viewBox, and the bytes
                        are retained unchanged (#213). An SVG referencing
                        anything outside itself is refused naming each
                        reference and the fix (embed the resource as a data
                        URI); scripts never block import and never run.
  --from-generation <jobId>
                        Replace an image Layer's content with the selected
                        output of a published Generation Job (see ply
                        generate) without generating again; the job's
                        provenance is retained with the Project. Mutually
                        exclusive with --image/--text; invalid on text Layers.
  --output <n|sha256|prefix>
                        Which output of the --from-generation job to ingest:
                        a 1-based index (all digits, fewer than 12
                        characters), a sha-256 prefix of at least 12 hex
                        characters, or the full sha-256 content identity.
                        A prefix must be unique; an ambiguous or unknown
                        prefix is refused, naming the candidates.
  --from-matte <matteId>
                        Replace an image Layer's content with the verified
                        output of a published matte (see ply matte) without
                        running inference again; the matte's provenance is
                        retained with the Project (and a generated source's
                        job provenance too). Mutually exclusive with
                        --image/--text/--from-generation; invalid on text
                        Layers.
  --text <str>          New text content for a text Layer
  --font <family>       Bundled font family name for a text Layer
  --font-file <path>    Path to a local TrueType/OpenType font file for a
                        text Layer (#232): the file's bytes are retained
                        with the Layer and its own facts are stored, so
                        rendering, measure, replay, and cross-Project
                        import never need the original file. Mutually
                        exclusive with --font — one font source per edit.
                        Weight/width validate against the file's real axes;
                        a non-font or unresolvable file is refused before
                        anything publishes.
  --font-size <num>     Font size in px for a text Layer
  --tracking <num>      Letter spacing in em for a text Layer (#187,
                        ADR-0021): -0.5 to 1 (0 removes stored tracking —
                        the same look as no tracking)
  --line-height <num|normal>
                        Line height as a unitless multiplier of the font
                        size (#187, ADR-0021): 0.5 to 3; "normal" removes
                        stored line height (the font's own line height
                        applies)
  --wrap-width <num|none>
                        Wrap width for a text Layer in layout px (#294,
                        spec #285 US-015, DEC-001/DEC-005): an ABSOLUTE
                        setter — with a width set, the text soft-wraps at
                        spaces within it (written line breaks still
                        break), and measure/anchor report the wrapped
                        box; "none" removes the width and restores the
                        unwrapped one-line render byte-for-byte. Setting
                        a width is an edit, so a legacy-rule revision
                        becomes natural layout; bounded 1–8192 layout px
  --fit-box <WxH|none>  Fit box for a text Layer in layout px (#295,
                        spec #285 US-016, DEC-010): an ABSOLUTE setter —
                        with a box set, the font size shrinks (only
                        shrinks; never the weight or width) until the
                        laid-out text fits the box, and measure reports
                        the effective font size; text that cannot fit at
                        the 8px minimum is refused, naming the box and
                        the size needed. "none" removes the box and
                        restores the unfitted render byte-for-byte. With
                        a wrap width, the box bounds the WRAPPED block
                        (its width must be at least the wrap width)
  --weight <num>        Text weight for a text Layer (#179, #232):
                        validated against the Layer's font's real weight
                        axis — Archivo 100-900 (default 400); static faces
                        accept only their own weight; a caller font file
                        validates against the file's own fvar ranges
  --width <num>         Text width for a text Layer (#179/#196): variable
                        fonts — Archivo 62-125 (default 100); static faces
                        accept only their implicit width 100
  --color <spec>        Text color or gradient fill (#222): a solid hex
                        color like #ffffff, #fff, or #ffffff80, or a gradient
                        like "linear:90deg,#ff0000,#00ff00" or
                        "radial:#ff0000,#00ff00" (the shared fill grammar)
  --run <text>          Append one run to the Layer's text (#297, ADR-0021
                        amendment): repeatable, each occurrence one run at
                        the Layer defaults. Per-run absolute setters:
                        --run-color <i>=<spec>, --run-font <i>=<family>,
                        --run-font-file <i>=<path>, --run-weight <i>=<num>,
                        --run-width <i>=<num> (1-based run indices; "none"
                        removes that run's override); --run-text <i>=<text>
                        rewrites one run's characters (later boundaries
                        shift); --runs none collapses the Layer to a
                        single run at the Layer defaults. Bare --text is
                        refused on a multi-run Layer (it would discard the
                        runs). No style is synthesized: a static face
                        stores no axes, and an italic look comes from an
                        italic face
  --shape <geometry>    Set a shape Layer's geometry to an ABSOLUTE value:
                        rectangle or ellipse (#209). Omitted keeps the
                        current geometry; switching to ellipse drops a
                        carried corner radius (a rectangle fact with no
                        ellipse meaning), and an explicitly supplied radius
                        on an ellipse is refused. Refused on image and text
                        Layers — a Layer's kind is stable across edits.
  --size <WxH>          Set a shape Layer's geometry size to an ABSOLUTE
                        "<W>x<H>" in canvas px (#209): the shape's intrinsic
                        pixel facts. Omitted keeps the current size. A
                        carried corner radius that exceeds the new range is
                        refused (pass --corner-radius in the same edit).
                        Mutually exclusive with --resize, --resize-to,
                        --cover-to, --scale, and --scale-to in one edit (the
                        effective-size cap and the
                        resize reference read the intrinsic size). Refused
                        on image and text Layers (kind stability).
  --corner-radius <px>  Set a shape rectangle's corner radius to an ABSOLUTE
                        value in px, 0 to half the shorter side (#209):
                        omitted keeps the current radius, 0 removes it (the
                        same look as absent, never stored). Refused on an
                        ellipse and on image and text Layers (kind
                        stability).
  --fill <spec>         Set a shape Layer's fill to an ABSOLUTE value
                        (#209): the same fill grammar as composition add
                        --shape — a solid hex color (#RGB, #RRGGBB,
                        #RRGGBBAA — alpha allowed, optional "solid:" prefix)
                        or a gradient — "linear:45deg,<stop>,<stop>" or
                        "radial:<stop>,<stop>"; a stop is "<color>" or
                        "<color>:<position>" (0–100, % optional). Omitted
                        keeps the current fill. Refused on image and text
                        Layers (kind stability).
  --x <num>             X position on canvas
  --y <num>             Y position on canvas
  --opacity <num>       Layer opacity between 0 and 1
  --anchor <h>[,<v>]    Anchored placement: resolve the Layer's VISIBLE
                        PAINTED INK against the target position instead of
                        targeting the top-left corner. Horizontal values are
                        left|center|right (anchoring --x), vertical values
                        are top|center|bottom (anchoring --y); a pair like
                        "center,center" anchors both, in that order. A
                        single value anchors one axis only (left/right are
                        horizontal, top/bottom vertical; a bare "center" is
                        ambiguous and refused — name both, e.g.
                        "center,center"). A coordinate supplied for the
                        unanchored axis still applies as a plain placement
                        edit, and the report states exactly what publishes.

                        The anchor box is the PAINTED INK box (alpha > 0 /
                        tight glyph ink, unclipped), never the layout
                        content box: transparent padding does not count, so
                        a padded image's visible subject lands at the
                        target while its layout box extends into the
                        padding. A Layer with no visible ink refuses instead
                        of falling back to the layout box. Resolution runs
                        against the Layer's CURRENT transform and the
                        rendering geometry of the referring Composition(s) —
                        or standalone on an unwrapped line when the Layer is
                        unreferenced (legacy text revisions' ink depends on
                        each Composition's canvas width; disagreement across
                        Compositions refuses — modern revisions use
                        position-independent natural layout per the ADR-0017
                        amendment). The ink basis is the PRE-EFFECT painted
                        ink (DEC-002, ADR-0017 amendment #288): the
                        ink-extending effect facts (shadow, outline) never
                        shift a re-anchoring edit — the same shared basis
                        one-command 'composition add' resolves on, so the
                        same --anchor publishes the same stored placement
                        through both surfaces. Resolved through the
                        paint-identical ink measurement, accurate to its
                        pixel grid (~1px).

                        Anchored placement is a ONE-SHOT resolution written
                        into plain placement (x, y) — no anchor facts are
                        stored, and "ply composition measure" verifies where
                        the ink landed. It is its own edit: it cannot be
                        combined with --resize, --scale, --rotate, --flip,
                        shape parameters (--shape, --size, --corner-radius,
                        --fill), or content replacement (the reference ink
                        would be ambiguous);
                        make the transform/content edit first, then anchor.
                        --opacity combines freely. A subsequent content edit
                        keeps the resolved x/y literally.
  --resize <factor>     Scale the Layer by a RELATIVE factor: the new scale
                        is the current scale multiplied by <factor>, so the
                        same command twice keeps enlarging (e.g. 2 then 2
                        gives 4×). Works on image, text, and shape Layers; the aspect
                        ratio is always preserved. Resizing changes placement
                        only: retained source bytes and lineage never change.
                        For an absolute setter use --scale instead.
  --resize-to <WxH>     Set the effective painted size in px
                        (${RESIZE_TO_HELP_KINDS} — text has no
                        intrinsic pixel size; use --resize; a shape's
                        intrinsic size is its --size geometry).
                        "800x600" deliberately changes the aspect ratio; "800x" or "x600" preserves the
                        Layer's current aspect ratio (a deliberate aspect
                        change survives). Mutually exclusive with --resize
                        and with content-replacement options. The Layer's
                        (x, y) stays its top-left corner: it grows/shrinks
                        right and down.
  --cover-to <WxH|canvas>  Cover fit (#293): scale the Layer (uniform,
                        aspect always preserved) so its painted size FILLS
                        the target box — the scale is the max of the cover
                        ratios over the intrinsic size, so the overflow
                        sits outside the canvas and stays editable; the
                        canvas never clips. Works on ${COVER_TO_HELP_KINDS}. "canvas"
                        targets the referring Composition's canvas (all
                        referrers must agree). Centring is a separate
                        anchored-placement edit (on add, --anchor composes:
                        transforms apply before the anchor). Mutually
                        exclusive with --resize, --resize-to, --scale, and
                        --scale-to.
  --scale <factor>      Set the Layer's scale to an ABSOLUTE factor: replaces
                        the current scale (uniform, both axes), so the same
                        command twice keeps the same scale — never compounding
                        (unlike the relative --resize factor). Works on
                        ${SCALE_HELP_KINDS}, writes the one
                        canonical scale (no
                        second scale field), and never changes retained
                        pixels. Mutually exclusive with --resize,
                        --resize-to, --cover-to, and --scale-to.
  --scale-to <XxY>      Set the Layer's scale to ABSOLUTE per-axis factors
                        (e.g. "1.3x0.8" stretches 1.3× horizontally, 0.8×
                        vertically): the same command twice keeps the same
                        scale — never compounding. Works on
                        ${SCALE_HELP_KINDS}. "<X>x" or "x<Y>"
                        sets one axis and keeps the Layer's current scale on
                        the omitted axis. This and --scale are ONE stored
                        fact (the canonical scaleX/scaleY): either setter
                        wholly replaces the current scale, and "1x1"
                        removes it (the render returns to scale 1
                        byte-for-byte). Never changes retained pixels.
                        Mutually exclusive with --resize, --resize-to,
                        --cover-to, and --scale.
  --rotate <deg>        Rotate the Layer to an ABSOLUTE angle in degrees,
                        replacing any previous rotation: --rotate 45 twice is
                        still 45° (never 90° — unlike the relative --resize
                        factor), and --rotate 0 removes the rotation. Positive
                        degrees rotate clockwise. Rotation applies after
                        scale, about the Layer's (x, y) top-left corner, and
                        never changes retained pixels. Combines with other
                        edit options, including --resize and content
                        replacement.
  --flip <mode>         Flip the Layer to an ABSOLUTE reflection state,
                        replacing any previous flip: horizontal mirrors
                        left–right along the content's own vertical axis,
                        vertical mirrors top–bottom, both mirrors both axes,
                        and none removes the reflection (the same command
                        twice keeps the same state — unlike a toggle). Flip
                        applies with scale, before rotation, about the
                        Layer's (x, y) top-left corner, and never changes
                        retained pixels. Combines with other edit options,
                        including --resize and content replacement.
  --skew <XxY>          Skew the Layer to ABSOLUTE shear angles in degrees,
                        replacing any previous skew: "<Xdeg>x<Ydeg>" (e.g.
                        "15x0" shears along the content's x axis), or a
                        one-axis form "<Xdeg>x" / "x<Ydeg>" (the omitted
                        axis keeps its current angle). "0x0" removes the
                        skew. Applies after rotation, before perspective,
                        about the Layer's (x, y) top-left corner, and never
                        changes retained pixels. Combines with other edit
                        options, including --resize and content
                        replacement.
  --perspective <XxY>   Tilt the Layer to ABSOLUTE perspective angles in
                        degrees about the X and Y axes, replacing any
                        previous perspective: "<tiltXdeg>x<tiltYdeg>" (e.g.
                        "0x20" tips the right edge away), or a one-axis form
                        (the omitted tilt keeps its current angle).
                        "0x0" removes the perspective. The tilt pivots
                        about the Layer's own untransformed content centre,
                        projected through a fixed 1000px perspective
                        distance, as the outermost transform after skew.
                        Never changes retained pixels. Combines with other
                        edit options, including --resize and content
                        replacement.
  --shadow <spec>       Apply a shadow to the Layer's content (#139), on
                        image alpha and text glyphs alike: an ABSOLUTE setter
                        "<dx>,<dy>,<blur>,<color>" — e.g. "10,10,4,#000000"
                        or "0,2,6,#00000080" (alpha softens the shadow) —
                        that replaces any previous shadow, and "none"
                        removes it (the same command twice keeps the same
                        shadow). REPEATABLE (#302, ADR-0027): two or more
                        occurrences stack shadows in command order (the
                        first is cast from the content, each later one from
                        the ink accumulated before it); one occurrence is
                        today's single-object form, and "none" cannot
                        combine with value occurrences. Offsets and blur are
                        px (blur 0..256,
                        offsets within ±256); negative offsets are valid.
                        The shadow paints in the Layer's LOCAL coordinate
                        space — the transform (scale/rotation/flip) then
                        maps content and shadow together, and the Layer's
                        opacity fades both. It is a revision fact: sharing
                        propagates it, forks isolate it, and removal is its
                        own edit. Never changes retained pixels. Combines
                        with --resize/--rotate/--flip and content
                        replacement; cannot combine with --anchor (the
                        anchor resolves the pre-effect ink — the shadow's
                        ink never moves a stored placement; make the effect
                        edits separate).
  --outline <spec>      Apply an outline to the Layer's content (#140), on
                        image alpha and text glyphs alike: an ABSOLUTE setter
                        "<width>,<color>" — e.g. "4,#000000" — that replaces
                        any previous outline, and "none" removes it (the
                        same command twice keeps the same outline). Width is
                        px (0..256). REPEATABLE (#302, ADR-0027): two or
                        more occurrences stack outlines in command order —
                        each later dilate hugs everything the earlier ones
                        accumulated, painting nested rings; one occurrence
                        is today's single-object form, and "none" cannot
                        combine with value occurrences. The outline hugs
                        the content in the
                        Layer's LOCAL coordinate space, painted BEFORE the
                        shadow — a shadow on the same Layer is cast from the
                        outlined composite — and the transform then maps
                        content, outline, and shadow together, with the
                        Layer's opacity fading all of it. It is a revision
                        fact: sharing propagates it, forks isolate it, and
                        removal is its own edit. Never changes retained
                        pixels. Combines with --resize/--rotate/--flip and
                        content replacement; cannot combine with --anchor
                        (the anchor resolves the pre-effect ink — the
                        outline's ring is an effect, not anchor ink; make
                        the effect edits separate).
  --inner-shadow <spec>
                        Apply an inner shadow to the Layer's content (#303,
                        ADR-0027), on image alpha and text glyphs alike: an
                        ABSOLUTE setter "<dx>,<dy>,<blur>,<color>" — the
                        same grammar and bounds as --shadow — that replaces
                        any previous stack, and "none" removes it.
                        REPEATABLE (ADR-0027): occurrences stack in command
                        order, one occurrence is the single-object form,
                        and "none" cannot combine with value occurrences.
                        The band darkens pixels JUST INSIDE the alpha edge
                        and never paints outside it: the offset direction
                        follows the CSS inset box-shadow convention (dy +4
                        darkens the TOP inside edge, dx +4 the left — the
                        edge the offset moves away from), 0,0,blur rings
                        all inside edges. Painted in the Layer's LOCAL
                        coordinate space, after the edge glow and before
                        the outlines — an alpha-preserving effect, so the
                        painted extent is unchanged (no reach). It is a
                        revision fact: sharing propagates it, forks
                        isolate it, and removal is its own edit. Never
                        changes retained pixels. Cannot combine with
                        --anchor.
  --vector-color <hex|none>
                        Paint a vector image Layer's shape in one colour
                        (#215, spec #207 US-005): an ABSOLUTE setter taking
                        a hex color like #22c55e, #2c5, or #22c55e80 (alpha
                        allowed) — the same grammar --fill's solid arm and
                        the effects take — that replaces any previous
                        colour, and "none" removes it, restoring the
                        authored colours byte-identically (the same command
                        twice keeps the same colour). The colour is applied
                        at paint time over the vector's own alpha: every
                        pixel the vector covers with alpha renders exactly
                        the requested colour — a multi-colour vector
                        becomes a single-colour silhouette — and alpha
                        edges are preserved. Defined for vector (format
                        svg) image Layers only: refused on a raster image
                        Layer (a raster's colours are its retained pixels),
                        on a text Layer (which takes its colour through
                        --color), and on a shape Layer (whose colour is its
                        fill, through --fill), before anything is published.
                        When the same edit replaces content, the refusal
                        reads the NEW content's format, and a colour carried
                        across a replacement to raster content is refused
                        naming the fix. The retained bytes
                        are never rewritten — the colour is a revision
                        fact: sharing propagates it, forks isolate it, and
                        removal is its own edit. Paint order within the
                        Layer: the colour is content paint, then the visible
                        region, outline, and shadow follow (ADR-0023).
                        Combines with --resize/--rotate/--flip and content
                        replacement; cannot combine with --anchor (anchor
                        first, then the colour — the anchor resolves the
                        ink the edit publishes, and a colour's alpha can
                        change it).
  --visible-region <spec>
                        Show only a rectangular part of the Layer's content
                        (#211), on image, text, and shape Layers alike: an
                        ABSOLUTE setter "<x>,<y>,<width>,<height>" in the
                        Layer's OWN content pixels, relative to the content
                        box's top-left — e.g. "120,80,640,360" frames a face
                        from a wide cutout without touching the file — and
                        "none" removes the region (the same command twice
                        keeps the same region). The region is a revision
                        fact: content outside it is not ink — painted
                        extents, anchored placement, the on-canvas
                        footprint, and clipping follow it, and shadow and
                        outline hug the region's edge instead of the full
                        content edge. The placement point and transform
                        origin stay defined against the FULL content box, so
                        setting or removing a region never moves the
                        remaining pixels. A region outside the content or
                        with zero area is refused before publication. Never
                        changes retained pixels or lineage. Combines with
                        --resize/--rotate/--flip/--shadow/--outline; cannot
                        combine with content edits (the region is validated
                        against the content box) or --anchor (anchor first,
                        then set the region). A region kept across a later
                        content edit is re-validated against the new
                        content box: outside is refused, fitting publishes
                        with a note.
  --visible-region-radius <px>
                        Round the visible region's corners (#212): an
                        ABSOLUTE setter in px — e.g. "12" rounds the corners
                        of the region rectangle, "0" or "none" removes the
                        radius — that edits and removes INDEPENDENTLY of the
                        rectangle (an omitted option preserves the current
                        radius, even when the rectangle is re-set). The
                        radius obeys the SAME rule as a shape Layer's
                        --corner-radius: a radius larger than half the
                        region rectangle's shorter side is REFUSED, never
                        clamped (the paint would silently clamp it, so the
                        stored parameters would not describe the paint),
                        through the same validator; a negative radius is
                        refused. Needs a visible region — a positive radius
                        on a Layer without one, or combined with the
                        region's removal, is refused (0 and none remove
                        nothing). Removing the region removes its
                        radius. Corner pixels outside the radius are
                        transparent, the outline and shadow follow the
                        rounded edge, and painted extents stay the
                        rectangle's. Never changes retained pixels. Combines
                        with --visible-region (rectangle and radius in one
                        edit); a radius kept across a rectangle re-set must
                        still fit the new rectangle.
  --brightness <num>    Set brightness factor for image, text, and shape Layers: an
                        ABSOLUTE setter 0 to 5 (neutral: 1) that replaces any
                        previous brightness, and 1 removes it (the same command
                        twice keeps the same brightness). Values < 1 darken;
                        values > 1 brighten. Applied at paint time to the
                        Layer's content only — never to outline, shadow, or
                        alpha. It is a revision fact: sharing propagates it,
                        forks isolate it, and removal is its own edit. Never
                        changes retained pixels.
  --contrast <num>      Set contrast factor for image, text, and shape Layers: an
                        ABSOLUTE setter 0 to 5 (neutral: 1) that replaces any
                        previous contrast, and 1 removes it. Values < 1 reduce
                        contrast; values > 1 increase contrast. Applied at
                        paint time to the Layer's content only.
  --saturation <num>    Set saturation factor for image, text, and shape Layers: an
                        ABSOLUTE setter 0 to 5 (neutral: 1) that replaces any
                        previous saturation, and 1 removes it. Values < 1
                        desaturate (0 is greyscale); values > 1 oversaturate.
                        Applied at paint time to the Layer's content only.
  --warmth <num>        Set warmth shift for image, text, and shape Layers: an
                        ABSOLUTE setter -1 to 1 (neutral: 0) that replaces any
                        previous warmth, and 0 removes it. Positive values shift
                        toward orange/red; negative values shift toward blue.
                        Applied at paint time via an sRGB colour matrix to the
                        Layer's content only without changing alpha.
  --blend <mode>        Set blend mode for image, text, and shape Layers: an
                        ABSOLUTE setter (normal, multiply, screen, overlay,
                        soft-light, darken, lighten, color-dodge) that replaces
                        any previous mode, and normal removes it. Blends the
                        whole Layer — content, visible region, grade, edge
                        glow, outline, shadow, and opacity — as one unit
                        against everything beneath it. It is a revision fact:
                        sharing propagates it, forks isolate it.
  --glow <spec>         Paint a two-dimensional edge glow — a coloured rim of
                        light just INSIDE the Layer's alpha edge, over the
                        graded content — for image, text, and shape Layers.
                        This is an edge effect on the Layer's own alpha, NOT
                        relighting: it never changes the direction or shape
                        of light on the subject and never extends painted
                        extents. An ABSOLUTE setter
                        "<width>,<softness>,<color>[,<angle>,<strength>]" —
                        width and softness in px (each 0 to 256), colour a hex
                        value like #ff9900 or #ff990080, and an optional
                        direction pair: <angle> in degrees clockwise from top
                        (-360 to 360) with <strength> between 0 and 1, passed
                        together; without the pair the glow is even all
                        round. "none" removes it; an omitted --glow preserves
                        the current glow. It is a revision fact: sharing
                        propagates it, forks isolate it, and removal is its
                        own edit. Never changes retained pixels. A one-sided
                        rim light spells the pair "from <angle>,<strength>"
                        instead: the light comes FROM that angle and the far
                        side's band fades to 1 − strength (at strength 1 the
                        opposite edge is unlit); strength 0 is the even glow,
                        and the two direction forms cannot be combined.
  --blur <px>           Blur the Layer — a Gaussian defocus radius in px
                        (0 to 256) painted as the LAST function of the
                        effects chain, after the edge glow, outline, and
                        shadow: the whole Layer look reads out of focus
                        (defocus, not a glow or grade). The px are
                        Layer-LOCAL: the defocus scales with the Layer's
                        scale/scale-to like the other effects. The blur
                        GROWS painted extents; anchored placement resolves
                        against the pre-effect ink, so the blur never moves
                        a stored placement. An ABSOLUTE setter — 0 removes
                        the blur; an omitted --blur preserves the current
                        radius. It is a revision fact: sharing propagates
                        it, forks isolate it, and removal is its own edit.
                        Never changes retained pixels.
  --choke <px>          Choke the Layer's alpha edge INWARD — erode the
                        alpha by a radius in px (0 to 256) painted as the
                        FIRST function of the effects chain, before the
                        edge glow, outline, and shadow, so a cutout's halo
                        disappears on saturated backdrops and every later
                        effect hugs the choked edge. The px are
                        Layer-LOCAL: the choke scales with the Layer's
                        scale/scale-to like the other effects. The shaped
                        alpha is composited with the source graphic, so the
                        painted ink never exceeds the unchoked ink; choke
                        SHRINKS painted extents, and anchored placement
                        resolves against the pre-effect ink, so the choke
                        never moves a stored placement. An ABSOLUTE setter
                        — 0 removes the choke; an omitted --choke
                        preserves the current radius. It is a revision
                        fact: sharing propagates it, forks isolate it, and
                        removal is its own edit. Never changes retained
                        pixels.
  --feather <px>        Feather the Layer's alpha edge — a Gaussian
                        softening radius in px (0 to 256) applied
                        immediately after the choke in the same first
                        effects-chain function, so the edge softens INWARD
                        only and no ink appears outside the unfeathered
                        ink. The px are Layer-LOCAL like the choke's;
                        painted extents never grow, and anchored placement
                        resolves against the pre-effect ink. An ABSOLUTE
                        setter — 0 removes the feather; an omitted
                        --feather preserves the current radius. It is a
                        revision fact: sharing propagates it, forks
                        isolate it, and removal is its own edit. Never
                        changes retained pixels.
  --mask <use-name>     Clip the Layer to another Layer use's alpha
                        (ADR-0025): <use-name> is a use of the SAME
                        Composition, resolved per Composition, stored as a
                        revision fact. The clip uses the mask use's content
                        alpha after its own transforms and visible region,
                        in canvas space — never its opacity, grade,
                        effects, blend, or any mask of its own — and cuts
                        the masked Layer's FINAL pixels (outline, shadow,
                        and all) after its effects and before the blend. A
                        use serving as a mask does not paint. Unresolved
                        names, self-masks, and cycles are refused; a
                        removal (:none) restores the render
                        byte-for-byte. The removal spelling ":none" can
                        never name a use. On edit, an in-place change
                        resolves the name in EVERY referring Composition
                        (the refusal names each where it does not) and the
                        result reports each resolved use; a --fork change
                        resolves against the fork target.
  --out <path>          Destination for the layer review sheet (required;
                        parent directory must exist; outside the Project an
                        existing file is the documented overwrite case —
                        the sheet is derived evidence, regenerable at any
                        time; reserved Project storage and existing
                        in-Project files are never overwritten)
  --json                Emit machine-readable JSON output on stdout
  --help, -h            Show this help message
`;

function output(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string; [key: string]: unknown },
  isJson: boolean,
  textFormatter?: () => void,
) {
  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    if (textFormatter) {
      textFormatter();
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

/** Compact anchor spec for the edit report: pair form "h,v", single form
 * otherwise. */
function formatAnchorSpec(anchor: ParsedAnchor): string {
  if (anchor.horizontal !== undefined && anchor.vertical !== undefined) {
    return `${anchor.horizontal},${anchor.vertical}`;
  }
  return anchor.horizontal ?? anchor.vertical ?? "";
}

/** Compact target for the edit report, restricted to the anchored axes. */
function formatAnchorTarget(anchored: AnchorResolution): string {
  const { target } = anchored;
  if (target.x !== undefined && target.y !== undefined) return ` at (${target.x}, ${target.y})`;
  if (target.x !== undefined) return ` at x ${target.x}`;
  return ` at y ${target.y}`;
}

/**
 * Name addressing (spec #226 US-003, DEC-003): the ONE command-boundary
 * resolution of the id-accepting commands' target token. A plain Layer id
 * passes through unchanged; a `<composition>/<use>` address resolves into
 * the referenced Layer's id, and downstream sees only that id. A malformed
 * address is a usage error (exit 2); an unknown Composition or use is a
 * semantic refusal (exit 1) listing what exists — either way nothing is
 * published. Returns undefined when the refusal has already been reported.
 */
async function resolveTarget(
  targetProj: string,
  token: string,
  isJson: boolean,
): Promise<ResolvedLayerToken | undefined> {
  try {
    return await resolveLayerToken(targetProj, token);
  } catch (err) {
    if (err instanceof LayerAddressSyntaxError) {
      output({ ok: false, error: usageMessage((err as Error).message, "layer") }, isJson);
      process.exitCode = 2;
    } else {
      output({ ok: false, error: (err as Error).message }, isJson);
      process.exitCode = 1;
    }
    return undefined;
  }
}

/**
 * The one per-command fact the production surface keeps (#326, DEC-003 — the
 * #289 Composition precedent): whether the command takes an existing Layer's
 * id. Test-only arg builders live in test/cli-surface.test.ts, and the
 * table's key set is pinned against HELP by that test, so a command cannot
 * silently opt out of the unknown-id refusal seam. Every id-accepting
 * command resolves through the ONE Layer reader (`readLayerInternalFull`),
 * so a new id-accepting command inherits the refusal — this table and its
 * pin keep the seam enumerated.
 */
export interface LayerCommandMeta {
  takesExistingLayerId: boolean;
}

export const LAYER_COMMANDS: Record<string, LayerCommandMeta> = {
  edit: { takesExistingLayerId: true },
  inspect: { takesExistingLayerId: true },
  review: { takesExistingLayerId: true },
  list: { takesExistingLayerId: false },
};

// Dash-numeric options (#128): the shared join, driven by the ONE option
// definition (DEC-001) — membership, not order, decides the join.
// All argv handling lives inside run() (#326): the module is importable —
// the LAYER_COMMANDS table is read by the CLI-seam test — so nothing here
// may parse argv, print HELP, or exit at module evaluation time.
async function run() {
  const rawArgs = joinDashLeadingNumericValues(process.argv.slice(2), layerDashNumericFlags(layerEditOptionKeys()));
  const isJson = rawArgs.includes("--json");

  let values: LayerOptionArgs & {
    project?: string;
    json?: boolean;
    help?: boolean;
    "in-place"?: boolean;
    fork?: boolean;
    composition?: string;
    use?: string;
    "fork-unit"?: string;
    out?: string;
  };
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: rawArgs,
      allowPositionals: true,
      options: {
        project: { type: "string", short: "p" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        "in-place": { type: "boolean", default: false },
        fork: { type: "boolean", default: false },
        composition: { type: "string" },
        use: { type: "string" },
        "fork-unit": { type: "string" },
        out: { type: "string" },
        // The one declaration of the Layer-editing option surface (DEC-001):
        // composition add shares these entries with layer edit.
        ...LAYER_OPTION_PARSE_ARGS,
      },
    });
    // The repeatable --run occurrences (#297) arrive as a parseArgs array
    // beside the single-string option values; the surface's declared shape
    // narrows them to the ordered occurrence list.
    values = parsed.values as unknown as NonNullable<typeof values>;
    positionals = parsed.positionals;
  } catch (err) {
    output({ ok: false, error: usageMessage((err as Error).message, "layer") }, isJson);
    process.exit(2);
  }

  if (values.help || positionals.length === 0) {
    if (isJson) console.log(JSON.stringify(helpResult(HELP.trim()), null, 2));
    else console.log(HELP);
    process.exit(0);
  }

  const command = positionals[0]!;
  const targetProj = values.project ?? process.cwd();

  try {
    if (command === "edit") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer edit <layer-id> [options]" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve the target token ONCE, at
      // this boundary — everything downstream receives only a Layer id.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;
      const addressComposition = target.address?.composition;
      const addressUse = target.address?.use;

      // The one edit-option enumeration (DEC-001): "is any edit option
      // supplied" reads the shared option table, and the refusal states
      // exactly the options the table declares — so an option added to the
      // definition is automatically an edit option here and automatically
      // named in this list.
      const hasEditOption = anyLayerEditOptionProvided(values);

      // The unit Layer (ADR-0026, #307): --unit is add-only. The boundary
      // parse runs FIRST (the ONE registration — a malformed name refuses
      // with the shared wording, exit 2, identically with `composition add`);
      // a well-formed name then gets the add-only refusal. The reference is
      // set at creation and changed only by the unit fork (#341), so an edit
      // carrying it is never silently dropped.
      if (values.unit !== undefined) {
        const unitTarget = parseLayerUnitTarget(values.unit as string);
        if (!unitTarget.ok) {
          output({ ok: false, error: unitTarget.error }, isJson);
          process.exitCode = 2;
          return;
        }
        output(
          {
            ok: false,
            error: "--unit is add-only: a unit Layer's reference is set by `composition add --unit` and changed only by the unit fork (`layer edit --fork --fork-unit <name>`, #341).",
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // The unit fork's inner-name flag (#341): only meaningful with --fork,
      // and always a Composition name under the ONE name rule.
      if (values["fork-unit"] !== undefined && !values.fork) {
        output(
          { ok: false, error: "--fork-unit is only valid together with --fork." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values["fork-unit"] !== undefined) {
        const forkUnitName = parseLayerUnitTarget(values["fork-unit"], "--fork-unit");
        if (!forkUnitName.ok) {
          output({ ok: false, error: forkUnitName.error }, isJson);
          process.exitCode = 2;
          return;
        }
      }

      if (!hasEditOption && !values.fork) {
        output(
          {
            ok: false,
            error: `No edit options provided: specify at least one of ${layerEditOptionKeys().map((key) => `--${key}`).join(", ")}, or --fork.`,
          },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Fork intent usage contract (#85): --fork and --in-place are mutually
      // exclusive; fork requires an explicit --composition/--use target;
      // those flags are meaningless without --fork. With an address target
      // (#226), the address supplies the target Composition and use, so they
      // need not be repeated — an explicit repetition must match the address.
      if (values.fork && values["in-place"]) {
        output(
          { ok: false, error: "--fork and --in-place are mutually exclusive edit intents." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      if (values.fork) {
        if (addressComposition !== undefined && values.composition !== undefined && values.composition !== addressComposition) {
          output(
            { ok: false, error: `--composition "${values.composition}" conflicts with the address's Composition "${addressComposition}".` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (addressUse !== undefined && values.use !== undefined && values.use !== addressUse) {
          output(
            { ok: false, error: `--use "${values.use}" conflicts with the address's use "${addressUse}".` },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }
      const forkComposition = values.composition ?? addressComposition;
      const forkUse = values.use ?? addressUse;
      if (values.fork) {
        if (!forkComposition || forkComposition.trim() === "") {
          output(
            { ok: false, error: "--composition <comp> is required with --fork: name the Composition whose use is retargeted (or address the Layer as <composition>/<use>)." },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
        if (!forkUse || forkUse.trim() === "") {
          output(
            { ok: false, error: "--use <local-name> is required with --fork: name the use in the target Composition to retarget (or address the Layer as <composition>/<use>)." },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      } else if (values.composition !== undefined || values.use !== undefined) {
        output(
          { ok: false, error: "--composition and --use are only valid together with --fork." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      // Content-kind exclusivity, each option's boundary parse, and the
      // cross-option policy rules are ONE check-order list
      // (EDIT_CHECK_ORDER) dispatched through the shared option table's
      // parse registrations (DEC-001, #263): every option's boundary parse
      // is the table's own validator — the same function composition add
      // runs, so the two boundaries can never disagree — and the policy
      // steps are this surface's cross-option rules at their established
      // positions (#257). Byte-identical refusals and exit statuses; no
      // per-option parse block remains on the edit surface.
      // A loud runtime throw (a table option with no parse registration,
      // #263) must still reach the refusal envelope: the check phase sits
      // inside the same catch as the edit lifecycle — an internal
      // invariant failure reports {ok:false} and exits 1, never an
      // unhandled rejection.
      let checked: EditLayerCheck | EditLayerRefusal;
      try {
        checked = checkEditLayerOptions(values);
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
        return;
      }
      if (!checked.ok) {
        output({ ok: false, error: checked.error }, isJson);
        process.exitCode = checked.exitCode;
        return;
      }
      const parsed = checked.parsed;
      const parsedAnchor = parsed.anchor as ParsedAnchor | undefined;
      const parsedMask = parsed.mask as string | undefined;

      // The unit edit gate at the boundary (ADR-0026 §4, #307): a unit
      // Layer's refused facts are named BEFORE the live-context resolutions
      // run, so an anchor, mask, or cover target is never resolved against a
      // unit. The same key set and refusal builder the domain lifecycle
      // enforces (UNIT_EDIT_OPTION_KEYS / unitEditFactRefusal). The unit
      // fork (#341) is gated here too: forking a unit REQUIRES --fork-unit,
      // and --fork-unit is refused on a non-unit fork.
      {
        // An unknown or unreadable Layer id skips the gate: the edit
        // lifecycle's own validation produces the established refusal, and
        // the boundary must never turn it into a raw throw.
        let targetLayer: Awaited<ReturnType<typeof inspectLayer>> | undefined;
        try {
          targetLayer = await inspectLayer(targetProj, layerId);
        } catch {
          targetLayer = undefined;
        }
        if (targetLayer !== undefined && targetLayer.currentRevision.kind === "unit") {
          if (values.fork && values["fork-unit"] === undefined) {
            output(
              {
                ok: false,
                error: `Forking a unit Layer requires --fork-unit <name> (ADR-0026 §3, #341): name the new inner Composition the fork copies. ` +
                  `Layer "${layerId}" is a unit referencing Composition "${targetLayer.currentRevision.composition}"; nothing was published.`,
              },
              isJson,
            );
            process.exitCode = 2;
            return;
          }
          const refused = Object.entries(parsed)
            .filter(([key, v]) => v !== undefined && !UNIT_EDIT_OPTION_KEYS.includes(key))
            .map(([key]) => key);
          if (refused.length > 0) {
            output(
              { ok: false, error: unitEditFactRefusal(refused, layerId, targetLayer.currentRevision.composition) },
              isJson,
            );
            process.exitCode = 1;
            return;
          }
        } else if (targetLayer !== undefined && values.fork && values["fork-unit"] !== undefined) {
          output(
            {
              ok: false,
              error: `--fork-unit is only valid when forking a unit Layer: Layer "${layerId}" is not a unit — its fork needs no inner Composition copy.`,
            },
            isJson,
          );
          process.exitCode = 2;
          return;
        }
      }

      try {
        // The Layer mask (ADR-0025 §5, #305): the would-be fact resolves ONCE
        // at this boundary against the Composition(s) that use this Layer
        // (read-only, under its own lock acquisition, before the edit
        // lifecycle — the cover-fit/anchor boundary-resolution pattern): a
        // --fork edit resolves against its target Composition, an in-place
        // edit against EVERY referring Composition, and a refusal names
        // each Composition where the name does not resolve. The resolution
        // rides out as the result's blast-radius report. A removal (:none)
        // has nothing to resolve.
        let maskResolutions: Awaited<ReturnType<typeof resolveMaskEdit>> = [];
        if (parsedMask !== undefined && parsedMask !== MASK_REMOVAL_VALUE) {
          try {
            maskResolutions = await resolveMaskEdit(targetProj, layerId, parsedMask, {
              forkComposition: values.fork ? forkComposition : undefined,
              forkUse: values.fork ? forkUse : undefined,
            });
          } catch (err) {
            output({ ok: false, error: (err as Error).message }, isJson);
            process.exitCode = 1;
            return;
          }
        }

        // Cover fit (#293, spec #285 US-007, DEC-011): the "canvas" target
        // resolves ONCE at this boundary against the Layer's referring
        // Composition(s) (read-only, outside the edit's own lock; a --fork
        // edit resolves against its target Composition), then the concrete
        // target publishes through the ONE shared scale resolution — the
        // stored-state resolution never sees the keyword.
        if (parsed["cover-to"] === "canvas") {
          try {
            parsed["cover-to"] = await resolveCoverCanvasTarget(targetProj, layerId, {
              contextComposition: values.fork ? forkComposition : undefined,
            });
          } catch (err) {
            const errObj = err as Error & { referringCompositions?: string[]; referrersCount?: number };
            const result: { ok: false; error: string; [key: string]: unknown } = { ok: false, error: errObj.message };
            if (errObj.referringCompositions !== undefined) result.referringCompositions = errObj.referringCompositions;
            if (errObj.referrersCount !== undefined) result.referrersCount = errObj.referrersCount;
            output(result, isJson);
            process.exitCode = 1;
            return;
          }
        }

        // Anchored placement (#138, ADR-0017): resolve ONCE against the
        // live state's painted ink (read-only), through the anchor's ONE
        // shared application case in the live context (the resolution must
        // run outside the edit's own Project lock), then publish plain x/y
        // through the ordinary edit lifecycle — the edit path never sees an
        // anchor, so no alternate placement representation can exist.
        let anchored: AnchorResolution | undefined;
        let editX = parsed.x as number | undefined;
        let editY = parsed.y as number | undefined;
        if (parsedAnchor !== undefined) {
          try {
            anchored = (await applyLayerOption(
              "anchor",
              { layerId } as SharedOptionDraft,
              parsedAnchor,
              {
                layerId,
                live: {
                  projectPath: targetProj,
                  x: parsed.x as number | undefined,
                  y: parsed.y as number | undefined,
                  contextComposition: values.fork ? forkComposition : undefined,
                  contextUse: values.fork ? forkUse : addressUse,
                },
              },
            )) as AnchorResolution;
          } catch (err) {
            const errObj = err as Error & { referringCompositions?: string[]; referrersCount?: number };
            const result: { ok: false; error: string; [key: string]: unknown } = { ok: false, error: errObj.message };
            if (errObj.referringCompositions !== undefined) result.referringCompositions = errObj.referringCompositions;
            if (errObj.referrersCount !== undefined) result.referrersCount = errObj.referrersCount;
            output(result, isJson);
            process.exitCode = 1;
            return;
          }
          if (parsedAnchor.horizontal !== undefined) editX = anchored.placement.x;
          if (parsedAnchor.vertical !== undefined) editY = anchored.placement.y;
          // The report states what WILL publish: an unanchored axis with a
          // supplied coordinate publishes as a plain placement edit, so the
          // audit report and the published revision can never disagree.
          anchored = {
            ...anchored,
            placement: {
              x: parsedAnchor.horizontal !== undefined ? anchored.placement.x : (editX ?? anchored.placement.x),
              y: parsedAnchor.vertical !== undefined ? anchored.placement.y : (editY ?? anchored.placement.y),
            },
          };
        }

        const buildRunStyleEditsOnce = buildRunStyleEdits(parsed); // parsed once (INT-cli-6)
        const res = await editLayer(targetProj, layerId, {
          inPlace: values["in-place"],
          fork: values.fork,
          // Forwarded only for a fork: the address's Composition/use pair is
          // fork-targeting intent, never a downstream-visible address fact.
          composition: values.fork ? forkComposition : undefined,
          use: values.fork ? forkUse : undefined,
          ...(values["fork-unit"] !== undefined ? { forkUnit: values["fork-unit"] } : {}),
          image: values.image,
          fromGeneration:
            values["from-generation"] !== undefined
              ? { jobRoot: path.resolve("out", "generation"), jobId: parsed["from-generation"] as string, output: parsed.output as string | undefined }
              : undefined,
          fromMatte:
            values["from-matte"] !== undefined
              ? {
                  matteRoot: path.resolve("out", "matting"),
                  matteId: parsed["from-matte"] as string,
                  generationRoot: path.resolve("out", "generation"),
                }
              : undefined,
          text: values.text,
          font: values.font,
          fontFile: values["font-file"],
          fontSize: parsed["font-size"] as number | undefined,
          color: values.color,
          weight: parsed.weight as number | undefined,
          width: parsed.width as number | undefined,
          tracking: parsed.tracking as number | null | undefined,
          lineHeight: parsed["line-height"] as number | null | undefined,
          wrapWidth: parsed["wrap-width"] as number | null | undefined,
          fitBox: parsed["fit-box"] as { width: number; height: number } | null | undefined,
          ...(values.run !== undefined ? { runAppend: values.run as string[] } : {}),
          ...(parsed["run-text"] !== undefined
            ? { runText: parsed["run-text"] as Array<{ index: number; text: string }> }
            : {}),
          ...(buildRunStyleEditsOnce.length > 0 ? { runStyles: buildRunStyleEditsOnce } : {}),
          ...(parsed.runs === null ? { runsNone: true } : {}),
          x: editX,
          y: editY,
          opacity: parsed.opacity as number | undefined,
          shape: parsed.shape as "rectangle" | "ellipse" | undefined,
          size: parsed.size as { width: number; height: number } | undefined,
          cornerRadius: parsed["corner-radius"] as number | undefined,
          fill: parsed.fill as LayerFill | undefined,
          // The converged post-content options (DEC-001, #263): the parsed
          // values, keyed by the option table's own keys — the edit path
          // dispatches each through its ONE shared application case.
          shared: parsed,
        });

        const resultBody: { ok: true; [key: string]: unknown } = {
          ok: true,
          layer: res.layer,
          referringCompositions: res.referringCompositions,
          referrersCount: res.referrersCount,
          reachedThroughUnits: res.reachedThroughUnits,
        };
        if (res.fork) {
          resultBody.fork = res.fork;
        }
        if (res.forkedUnit) {
          resultBody.forkedUnit = res.forkedUnit;
        }
        if (res.generatedFrom) {
          resultBody.generatedFrom = res.generatedFrom;
        }
        if (res.mattedFrom) {
          resultBody.mattedFrom = res.mattedFrom;
        }
        if (res.resized) {
          resultBody.resized = res.resized;
        }
        if (res.rotated) {
          resultBody.rotated = res.rotated;
        }
        if (res.flipped) {
          resultBody.flipped = res.flipped;
        }
        if (res.shadowed) {
          resultBody.shadowed = res.shadowed;
        }
        if (res.outlined) {
          resultBody.outlined = res.outlined;
        }
        if (res.innerShadowed) {
          resultBody.innerShadowed = res.innerShadowed;
        }
        if (res.regionSet) {
          resultBody.regionSet = res.regionSet;
        }
        if (res.regionCarried) {
          resultBody.regionCarried = res.regionCarried;
        }
        if (res.shapeEdited) {
          resultBody.shapeEdited = res.shapeEdited;
        }
        if (res.gradeSet) {
          resultBody.gradeSet = res.gradeSet;
        }
        if (res.glowSet) {
          resultBody.glowSet = res.glowSet;
        }
        if (parsedMask !== undefined) {
          resultBody.masked = {
            mask: parsedMask === MASK_REMOVAL_VALUE ? null : parsedMask,
            resolved: maskResolutions,
          };
        }
        if (anchored) {
          resultBody.anchored = anchored;
        }
        // A region kept across this content edit still fits the new content
        // box (#211 review PROD-1): say so on stderr in BOTH output modes —
        // the note is diagnostic, never part of the machine-readable result.
        if (res.regionCarried) {
          const r = res.regionCarried.visibleRegion;
          console.error(`Note: kept visible region (${r.x}, ${r.y}, ${r.width}, ${r.height}) now frames the replaced content.`);
        }

        output(
          resultBody,
          isJson,
          () => {
            const refMsg =
              res.referrersCount === 0
                ? "not referenced by any Composition"
                : `referenced by ${res.referrersCount} Composition${res.referrersCount === 1 ? "" : "s"} (${res.referringCompositions.map((n) => `"${n}"`).join(", ")})`;
            // The transitive reach through units (ADR-0026 §4, #341), beside
            // the direct referrers; the unit fork's inner copy, when present.
            const reachMsg = res.reachedThroughUnits.length > 0
              ? `; also reached through units: ${res.reachedThroughUnits.map((n) => `"${n}"`).join(", ")}`
              : "";
            const unitForkMsg = res.forkedUnit
              ? `; forked inner Composition "${res.forkedUnit.from}" -> "${res.forkedUnit.to}"`
              : "";
            const generated = res.generatedFrom
              ? `; from Generation Job ${res.generatedFrom.jobId} (${res.generatedFrom.contentHash.slice(0, 12)}, provenance retained)`
              : "";
            const matted = res.mattedFrom
              ? `; from matte ${res.mattedFrom.matteId} (engine ${res.mattedFrom.engine}, provenance retained)`
              : "";
            const resized = res.resized
              ? res.resized.width !== undefined
                ? `; scale ${res.resized.scaleX}×, effective ${res.resized.width}×${res.resized.height}px`
                : `; scale ${res.resized.scaleX}×`
              : "";
            const rotated = res.rotated ? `; rotation ${res.rotated.rotationDeg}°` : "";
            const flipped = res.flipped && res.flipped.flip !== "none" ? `; flip ${res.flipped.flip}` : res.flipped ? "; flip none" : "";
            const shadowed = res.shadowed
              ? res.shadowed.shadow
                ? `; shadow ${res.shadowed.shadow.map((s) => `${s.dx} ${s.dy} ${s.blur} ${s.color}`).join("; ")}`
                : "; shadow none"
              : "";
            const outlined = res.outlined
              ? res.outlined.outline
                ? `; outline ${res.outlined.outline.map((o) => `${o.width} ${o.color}`).join("; ")}`
                : "; outline none"
              : "";
            const innerShadowed = res.innerShadowed
              ? res.innerShadowed.innerShadow
                ? `; inner shadow ${res.innerShadowed.innerShadow.map((s) => `${s.dx} ${s.dy} ${s.blur} ${s.color}`).join("; ")}`
                : "; inner shadow none"
              : "";
            const regionSet = res.regionSet
              ? res.regionSet.visibleRegion
                ? `; visible region (${res.regionSet.visibleRegion.x}, ${res.regionSet.visibleRegion.y}, ${res.regionSet.visibleRegion.width}, ${res.regionSet.visibleRegion.height})` +
                  (res.regionSet.visibleRegion.cornerRadius !== undefined
                    ? `, corner radius ${res.regionSet.visibleRegion.cornerRadius}px`
                    : "")
                : "; visible region none"
              : "";
            const vectorColorSet = res.vectorColorSet
              ? res.vectorColorSet.vectorColor !== null
                ? `; vector colour ${res.vectorColorSet.vectorColor}`
                : "; vector colour removed"
              : "";
            const gradeSet = res.gradeSet
              ? res.gradeSet.grade !== null
                ? `; grade ${formatGrade(res.gradeSet.grade)}`
                : "; grade removed"
              : "";
            const blendSet = res.blendSet
              ? res.blendSet.blend !== null
                ? `; blend ${res.blendSet.blend}`
                : "; blend removed"
              : "";
            const glowSet = res.glowSet
              ? res.glowSet.glow !== null
                ? `; ${formatGlow(res.glowSet.glow)}`
                : "; glow removed"
              : "";
            const maskSummary = parsedMask !== undefined
              ? parsedMask === MASK_REMOVAL_VALUE
                ? "; mask none"
                : `; mask "${parsedMask}"${maskResolutions.map((r) => ` -> "${r.use}" in composition "${r.composition}"`).join(", ")}`
              : "";
            const shapeEdited = res.shapeEdited
              ? `; dropped carried corner radius ${res.shapeEdited.droppedCornerRadius}px (an ellipse has no corners)`
              : "";
            const anchorSummary = anchored
              ? `; anchored ${formatAnchorSpec(anchored.anchor)}${formatAnchorTarget(anchored)} -> placement (${anchored.placement.x}, ${anchored.placement.y})`
              : "";
            if (res.fork) {
              console.log(
                `Forked Layer "${res.fork.previousLayerId}" -> new Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} ` +
                  `(retargeted use "${res.fork.use}" in composition "${res.fork.composition}"; original Layer ${refMsg})${unitForkMsg}${reachMsg}${generated}${matted}${resized}${rotated}${flipped}${shadowed}${innerShadowed}${outlined}${regionSet}${vectorColorSet}${gradeSet}${blendSet}${glowSet}${maskSummary}${shapeEdited}${anchorSummary}`,
              );
            } else {
              console.log(`Edited Layer "${res.layer.id}" -> revision ${res.layer.currentRevisionId} (${refMsg})${unitForkMsg}${reachMsg}${generated}${matted}${resized}${rotated}${flipped}${shadowed}${innerShadowed}${outlined}${regionSet}${vectorColorSet}${gradeSet}${blendSet}${glowSet}${maskSummary}${shapeEdited}${anchorSummary}`);
            }
          },
        );
      } catch (err) {
        const errObj = err as Error & { referringCompositions?: string[]; referrersCount?: number; reachedThroughUnits?: string[] };
        const result: { ok: false; error: string; [key: string]: unknown } = {
          ok: false,
          error: errObj.message,
        };
        if (errObj.referringCompositions !== undefined) {
          result.referringCompositions = errObj.referringCompositions;
        }
        if (errObj.referrersCount !== undefined) {
          result.referrersCount = errObj.referrersCount;
        }
        if (errObj.reachedThroughUnits !== undefined) {
          result.reachedThroughUnits = errObj.reachedThroughUnits;
        }
        output(result, isJson);
        process.exitCode = 1;
      }
    } else if (command === "inspect") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer inspect <layer-id>" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve once at this boundary.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;

      try {
        const layer = await inspectLayer(targetProj, layerId);
        output(
          { ok: true, layer },
          isJson,
          () => {
            const rev = layer.currentRevision;
            console.log(`Layer: ${layer.id}`);
            console.log(`Created: ${layer.createdAt}`);
            console.log(`Current revision: ${layer.currentRevisionId}`);
            console.log(`  Kind: ${rev.kind}`);
            if (rev.kind === "text") {
              console.log(`  Text: ${JSON.stringify(rev.text)}`);
              // Caller fonts (#232): report the font's OWN family name (the
              // name the file declares) and that it is caller-supplied.
              // Bundled and legacy faces keep the established retained-face
              // form — the retained bytes are their only identity.
              const fontLabel =
                rev.callerFont !== undefined
                  ? `"${rev.callerFont.family}" (caller-supplied, ${(rev.fontBytes / 1024).toFixed(1)} KB)`
                  : `retained face (${(rev.fontBytes / 1024).toFixed(1)} KB)`;
              console.log(`  Font: ${fontLabel}, ${rev.fontSize}px`);
              console.log(`  Fill: ${formatFill(normalizeStoredTextFill(rev.color))}`);
              // Selected text axes (#179, ADR-0021): present ⟺ variable font.
              if (rev.weight !== undefined || rev.width !== undefined) {
                console.log(`  Axes: weight ${rev.weight}, width ${rev.width}`);
              }
              // Selected text typography (#187, ADR-0021): each shown only
              // when set — absence IS the normal-spacing / normal-line-height
              // form.
              if (rev.tracking !== undefined) {
                console.log(`  Tracking: ${rev.tracking}em`);
              }
              if (rev.lineHeight !== undefined) {
                console.log(`  Line height: ${rev.lineHeight}`);
              }
              // Selected text wrap width (#294): shown only when set —
              // absence IS the no-wrap-width (natural one-line) form.
              if (rev.wrapWidth !== undefined) {
                console.log(`  Wrap width: ${rev.wrapWidth}px`);
              }
              // The stored fit box (#295): shown only when set — absence IS
              // the no-box form. The effective font size is derived at read
              // time (measure reports it), never stored.
              if (rev.fitWidth !== undefined) {
                console.log(`  Fit box: ${rev.fitWidth}×${rev.fitHeight}px`);
              }
            } else if (rev.kind === "shape") {
              // Shape parameters (#208): the geometry, its size, the corner
              // radius when stored (absent = none), and the one fill.
              console.log(`  Geometry: ${rev.shape} (${rev.width}×${rev.height})`);
              if (rev.cornerRadius !== undefined) {
                console.log(`  Corner radius: ${rev.cornerRadius}px`);
              }
              console.log(`  Fill: ${formatFill(rev.fill)}`);
            } else if (rev.kind === "unit") {
              // The unit Layer (ADR-0026, #307): the live reference is the
              // content fact — there is no content hash and no intrinsic
              // size to report.
              console.log(`  Unit of Composition: ${rev.composition} (live reference)`);
            } else {
              console.log(`  Format: ${rev.format} (${rev.width}×${rev.height}, ${(rev.bytes / 1024).toFixed(1)} KB)`);
              // The vector colour (#215): reported only when set — absence IS
              // the no-colour form. A raster Layer can never carry the fact
              // (the setter refuses), so the line names the vector contract.
              if (rev.vectorColor !== undefined) {
                console.log(`  Vector colour: ${rev.vectorColor}`);
              }
            }
            if (rev.kind !== "unit") {
              console.log(`  Content hash: ${rev.contentHash}`);
            }
            const scalePart =
              rev.scaleX === rev.scaleY ? `${rev.scaleX}×` : `${rev.scaleX}×/${rev.scaleY}×`;
            const scale =
              rev.scaleX === 1 && rev.scaleY === 1
                ? ""
                : rev.kind === "text" || rev.kind === "unit"
                  ? `, Scale: ${scalePart}`
                  : `, Scale: ${scalePart} (effective ${roundEffective(rev.width * rev.scaleX)}×${roundEffective(rev.height * rev.scaleY)})`;
            const rotation =
              rev.rotationDeg === 0 ? "" : `, Rotation: ${rev.rotationDeg}°`;
            const flip =
              !rev.flipX && !rev.flipY
                ? ""
                : rev.flipX && rev.flipY
                  ? ", Flip: both"
                  : ", Flip: " + (rev.flipX ? "horizontal" : "vertical");
            const skew =
              (rev.skewXDeg ?? 0) === 0 && (rev.skewYDeg ?? 0) === 0
                ? ""
                : `, Skew: ${rev.skewXDeg ?? 0}° ${rev.skewYDeg ?? 0}°`;
            const perspective =
              (rev.perspectiveTiltXDeg ?? 0) === 0 && (rev.perspectiveTiltYDeg ?? 0) === 0
                ? ""
                : `, Perspective: ${rev.perspectiveTiltXDeg ?? 0}° ${rev.perspectiveTiltYDeg ?? 0}°`;
            // Stacked effects (#302, ADR-0027; inner shadow #303): each
            // effect of a type on its own entry, in paint order (the chain's
            // function order — inner shadow, then outlines, then shadows).
            const innerShadow =
              rev.innerShadow === undefined
                ? ""
                : rev.innerShadow.map((s) => `, Inner shadow: ${s.dx} ${s.dy} ${s.blur} ${s.color}`).join("");
            const outline =
              rev.outline === undefined
                ? ""
                : rev.outline.map((o) => `, Outline: ${o.width} ${o.color}`).join("");
            const shadow =
              rev.shadow === undefined
                ? ""
                : rev.shadow.map((s) => `, Shadow: ${s.dx} ${s.dy} ${s.blur} ${s.color}`).join("");
            const region =
              rev.visibleRegion === undefined
                ? ""
                : `, Visible region: (${rev.visibleRegion.x}, ${rev.visibleRegion.y}, ${rev.visibleRegion.width}, ${rev.visibleRegion.height})` +
                  (rev.visibleRegion.cornerRadius !== undefined
                    ? `, corner radius ${rev.visibleRegion.cornerRadius}px`
                    : "");
            const grade =
              rev.grade === undefined
                ? ""
                : `, Grade: ${formatGrade(rev.grade)}`;
            const blend =
              rev.blend === undefined
                ? ""
                : `, Blend: ${rev.blend}`;
            const glow =
              rev.glow === undefined
                ? ""
                : `, Glow: ${formatGlow(rev.glow)}`;
            const blur =
              rev.blur === undefined
                ? ""
                : `, Blur: ${rev.blur}px`;
            const choke =
              rev.choke === undefined
                ? ""
                : `, Choke: ${rev.choke}px`;
            const feather =
              rev.feather === undefined
                ? ""
                : `, Feather: ${rev.feather}px`;
            // The Layer mask (ADR-0025, #305): shown only when set — absence
            // IS the no-mask form. The name resolves per Composition; the
            // fact's own line states the stored use name.
            const mask =
              rev.mask === undefined
                ? ""
                : `, Mask: ${rev.mask} (use in each referring Composition)`;
            // Report order matches the chain's function order (review INT-1):
            // inner shadow, then outlines, then shadows.
            console.log(`  Placement: (${rev.x}, ${rev.y}), Opacity: ${rev.opacity}${scale}${rotation}${flip}${skew}${perspective}${innerShadow}${outline}${shadow}${region}${grade}${glow}${blur}${choke}${feather}${blend}${mask}`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "review") {
      const layerToken = positionals[1];
      if (!layerToken) {
        output({ ok: false, error: "Usage: ply layer review <layer-id> --out <path>" }, isJson);
        process.exitCode = 2;
        return;
      }

      // Name addressing (spec #226 US-003): resolve once at this boundary.
      const target = await resolveTarget(targetProj, layerToken, isJson);
      if (!target) return;
      const layerId = target.layerId;

      if (!values.out || !values.out.trim()) {
        output(
          { ok: false, error: "--out <path> is required: name the destination for the review sheet (a self-contained HTML file)." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }

      try {
        const review = await reviewRetainedLayer(targetProj, layerId, path.resolve(values.out));
        output(
          {
            ok: true,
            layer: review.layerId,
            review: review.reviewPath,
            generation: review.generation,
            matting: review.matting,
            associatedMatte: review.associatedMatte ? { matteId: review.associatedMatte.matteId, engine: review.associatedMatte.engine } : null,
            references: review.references.map((r) => ({
              path: r.path,
              contentHash: r.contentHash,
              available: r.bytes !== null,
            })),
          },
          isJson,
          () => {
            console.log(`Evidence review ${review.layerId}`);
            if (review.generation)
              console.log(`  generated by: ${review.generation.jobId} (output ${review.generation.output.contentHash.slice(0, 12)})`);
            if (review.matting) console.log(`  matted by: ${review.matting.matteId} (engine ${review.matting.engine})`);
            for (const r of review.references) {
              const status = r.bytes !== null ? "verified" : `unavailable (${r.unavailable})`;
              console.log(`  ref: ${r.path} (${r.contentHash.slice(0, 12)}) · ${status}`);
            }
            if (review.predecessorCandidateNote) console.log(`  note: ${review.predecessorCandidateNote}`);
            console.log(`  review: ${review.reviewPath}`);
            console.log("  evidence only — no approval or promotion is implied");
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "list") {
      try {
        const layers = await listLayers(targetProj);
        output(
          { ok: true, layers },
          isJson,
          () => {
            console.log(`Layers (${layers.length}):`);
            layers.forEach((l) => {
              const rev = l.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `text ${JSON.stringify(rev.text)}, ${rev.fontSize}px`
                  : rev.kind === "shape"
                    ? `${rev.shape} ${rev.width}×${rev.height}, ${formatFill(rev.fill)}`
                    : rev.kind === "unit"
                      ? `unit of "${rev.composition}"`
                      : `${rev.width}×${rev.height} ${rev.format}`;
              console.log(`  - ${l.id} [${rev.kind}: ${detail}, rev: ${l.currentRevisionId}]`);
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else {
      const msg = `Unknown command "${command}". Available commands: edit, inspect, review, list. See ply layer --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeCliBrowser();
  }
}

if (import.meta.main) {
  await run();
}
