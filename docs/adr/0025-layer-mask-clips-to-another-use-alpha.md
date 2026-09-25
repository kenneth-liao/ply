# ADR-0025: A mask clips a Layer to another use's alpha after its effects

- Status: Accepted — decided by Kenny in the #304 interview (2026-09-23)
  for [spec #285](https://github.com/kenneth-liao/ply/issues/285) DEC-007
  (US-009, ISC-48); §5's derived rules were written by the agent from
  those decisions (see Context). Shipped by ticket #305 (7.2.0): the
  `--mask` revision fact, the after-effects clip in paint, the measure
  clip facts, and the §3 lifecycle (import relink, fork, relocation,
  replay) — with the §5 strict-whitelist reading recorded below.

## Context

A subject behind a table with its arms in front needs a non-rectangular
cut: part of the subject must be hidden by an object that is itself a
separate Layer. The visible region (ADR-0023) only crops a Layer to a
rectangle of its own content, rounded at most at the corners. In the
spec #285 outlier test (round 3, archived at
`docs/archive/research/2026-09-23-outlier-test-2/`), the workaround was
to crop an unmatted generation to the table band.

A mask is the first time one Layer's paint depends on another Layer. That
touches three accepted decisions: ADR-0013 (a Layer is shared as a whole,
forks isolate, cross-Project copies are independent), ADR-0024 (the fixed
paint order within a Layer), and ADR-0023 (the visible region decides which
content is ink). ISC-14 requires a shipped Render to replay exactly.

The ISA deferred the mechanism to an ADR written when it was specced
(2026-09-23 decision log). Spec
#285 DEC-007 fixed how the mask is addressed. It left two questions open,
whether the mask also paints and how it behaves under import and fork,
and the ISA added a third: where the clip sits in paint order. Kenny
settled all three in the #304 interview.

This ADR separates what Kenny **decided** (§1–§4) from what the agent
**derived** from those decisions and existing invariants (§5). The derived
rules are part of this accepted decision, but a reviewer or #305 may
challenge them without re-opening the interview.

## Decision

### 1. Addressing (DEC-007)

A mask is another Layer **use** in the same Composition, named by its use
name. The masked Layer's revision stores that use name as a revision fact
(DEC-005): an absolute setter, stored only when set, with a documented
removal value, replayed byte-identically. #305 picks the spellings. The
removal spelling must not be a possible use name, so removing a mask can
never be read as naming a use (for example, a bare `none` would clash with
a use named `none`). The mask is an ordinary Layer. It can be
moved, transformed, and edited like any other, and the clip follows it.

The clip uses the mask's **alpha after its own transforms and visible
region**. That is the mask's content alpha, cropped by its visible region
(ADR-0023) and placed on the canvas by its placement and transform. The
masked Layer's alpha is multiplied by the mask's alpha at each canvas
pixel. Where the mask is opaque the pixels stay, where it is transparent
they are cut, and partial mask alpha keeps them partially.

The use name resolves in the Composition being painted, measured, or
rendered. Use names are local to that Composition, like every name address
(`<composition>/<use>`).

### 2. A mask does not paint (decided)

A use that serves as a mask gives only its alpha to the clip. It is **not
painted**, and its place in the Composition's use order has no effect on
the image. To show the object and also mask with it (the table in front of
the subject), the Composition holds two uses of the same Layer: one painted
use and one mask use. They share the Layer, so one edit moves both, under
the ordinary ADR-0013 rules.

### 3. Import, fork, and relocation: the mask travels with the masked Layer (decided)

The mask travels with the masked Layer. Wherever a masked Layer's use is
copied, its mask use comes with it and the clip is relinked to that copy.
A use-name clash is refused. Each operation that ships today meets this as
follows:

- **`composition import`** copies the source Composition's whole use list,
  with names unchanged. Because the mask use lives in the same source
  Composition (§1), it always arrives with the masked use, under the same
  name, so the stored name resolves in the target without any rewriting.
  - Same-Project import keeps the shared Layer identities.
  - Cross-Project import (`--from-project`) gives every copied Layer an
    independent destination identity (ADR-0013). The name then resolves to
    the destination copy of the mask. That is the relink.
- **A use-name clash is refused.** Import already refuses when the target
  has a use with the same name as any source use, before anything is
  published. The mask use is one of those names, so the refusal covers it
  without new code. Nothing is ever renamed silently.
- **Any future operation that copies a single use** must carry the mask use
  with it under these same rules. It must never copy the masked use alone.
- **`composition remove`** gains a refusal. Removing a use that a masked
  Layer still names is refused (§5).
- **Fork** (ADR-0013) gives the masked Layer a new identity only for the
  forking Composition's reference. The forked revision keeps its mask fact,
  and the name resolves to the same mask use in that same Composition.
  Editing the mask Layer is an ordinary edit of that Layer, with its own
  `--in-place` / `--fork` rule when it is shared.
- **Relocation** moves the whole Project. Use names are local to each
  Composition, and Layer identities and content are local to the Project,
  so masks move unchanged.
- **Replay** (ISC-14): a Render manifest pins the mask Layer's revision and
  content along with the masked Layer's, even though the mask does not
  paint. A Render with a mask replays byte-identically from its pinned
  inputs.

### 4. Paint order: the clip applies after the masked Layer's effects (decided)

The clip cuts the masked Layer's **final pixels**, including its outline,
shadow, and edge glow. A shadow that falls where the mask has no alpha is
cut, just as the content is. §5 places the clip in the full order.

### 5. Derived rules

These follow from §1–§4 and from existing invariants.

- **Where the clip sits.** It is a new step between ADR-0024's step 8
  (transform & opacity) and step 9 (blend):

  1. Content
  2. Vector colour
  3. Visible region
  4. Grade
  5. Edge glow
  6. Outline
  7. Shadow
  8. Transform & opacity
  9. **Mask clip** — the Layer's composite from steps 1–8, cut by the mask's
     canvas-space alpha (§1)
  10. Blend against the backdrop

  The clip comes after transform because DEC-007 defines the mask's alpha
  on the canvas, after the mask's own transforms. Opacity and the clip
  both scale alpha, so their order does not change the result. The clip
  comes before blend, so the clipped Layer blends as one unit (ADR-0024
  §5).
- **What shapes the mask's alpha.** Only what DEC-007 names: content alpha,
  visible region, placement, and transform. The mask's opacity, grade,
  edge glow, outline, shadow, blend, and any mask of its own do not
  contribute. A mask use does not paint, so these facts have no visible
  effect while the use serves as a mask.
  - **Reading recorded at implementation (#305, approved):** the whitelist
    is exhaustive — "content alpha, visible region, placement, and
    transform" is the complete set. The §2/§5 effect lists never claimed to
    be the only excluded facts: choke, feather, and inner shadow (alpha-edge
    and interior effects) and blur are excluded too, because none of them is
    the content alpha DEC-007 names. A soft clip edge comes from soft
    CONTENT alpha in the mask (an anti-aliased cutout, feathered-by-content
    glyphs), not from the mask's effects.
- **Which uses are masks.** A use is a mask when at least one other use in
  the same Composition names it. Several masked Layers may name the same
  mask use.
  - Self-masks and cycles are checked in every Composition that uses the
    masked Layer, both when a mask is set and when a use is added.
  - A use naming itself is refused.
  - A cycle is refused before publication, naming the uses in it. A cycle
    is two or more uses that each end up clipped by one another, such as
    A masks B while B masks A.
  - A use that is both masked and serving as a mask (a chain) is allowed.
    It does not paint, and its own clip plays no part in the alpha it
    gives.
- **Unresolved names fail loudly.** If a masked Layer's mask name does not
  resolve in the Composition being painted, measured, or rendered, the
  operation is refused and names the missing use. The masked Layer never
  paints unclipped as a fallback. This extends the CONTEXT.md invariant that
  final composition is deterministic and that unresolved inputs fail loudly.
- **Shared masked Layers.** A masked Layer's revision is shared as a whole
  (ADR-0013), but its mask name resolves separately in each Composition
  that uses it.
  - Setting or changing a mask on a Layer with several referring
    Compositions already needs `--in-place` or `--fork`.
  - An `--in-place` mask edit is refused unless the name resolves in
    **every** referring Composition. The refusal names each Composition
    where it does not.
  - A successful edit, and a successful add of a masked Layer's use,
    report which use the name resolved to (per Composition for an edit),
    so the blast radius is visible. That matters because a same-named use
    in another Composition may hold a different Layer.
  - Adding a use of a masked Layer, removing a mask use, and any future
    use rename all go through the same resolution check. They are refused
    rather than leaving a masked Layer with nothing to resolve to.
- **Placement and measurement.** The clip comes after placement (step 9).
  Masking therefore changes neither the anchor basis nor `painted`, and
  moving a mask never moves the Layer it clips. These two are different
  boxes today, and masking keeps them apart:
  - **Anchored placement** keeps resolving against the Layer's
    **pre-effect ink**, as the ADR-0017 amendment (spec #285 #288,
    DEC-002) defines it. That ink has shadow and outline stripped, is
    still clipped by the visible region, and is never mask-clipped.
  - **`measure`'s `painted` extents** keep their meaning: they include the
    effects' ink (#139/#140) and are taken before the mask clip.
  - **The mask clip is reported separately.** For a masked Layer,
    `measure` reports the clip and the post-clip extents as additional
    facts.
  - A mask use has ink of its own (its alpha from §1), so it measures and
    anchors like any Layer. It is reported as a mask, and its ink is not
    painted.

## Relationship to accepted ADRs

This ADR amends ADR-0024 and constrains how ADR-0013 and ADR-0023 are
applied. It overrides none of them.

- **ADR-0024 (look paint order) — amended.** §2's steps 1–8 are unchanged.
  The mask clip is inserted between transform & opacity and blend. It is
  the first step defined in canvas space rather than the Layer's local
  space. The blend unit of ADR-0024 §5 is now the clipped Layer.
- **ADR-0013 (Project-scoped sharing) — constrained.** Unchanged: a Layer is
  shared as a whole, in-place edits propagate, forks isolate, and
  cross-Project copies are independent. What is new: a masked Layer's
  revision names a Composition-local use. So an in-place mask edit must
  resolve in every referring Composition, and copies must bring the mask
  use (§3, §5).
- **ADR-0023 (visible region) — constrained.** Unchanged for the masked
  Layer: its region still crops content before the effects. The mask's own
  visible region shapes the clip (§1), so the mask's ink and its clip alpha
  are the same thing.
- **ADR-0017 (anchored placement, as amended by #288) — unchanged.** The
  anchor still resolves against the pre-effect ink, which the mask never
  clips. `measure`'s `painted` extents keep their with-effects meaning,
  also before the clip. The clip's extents are reported separately (§5).

## Consequences

- One Layer's rendered pixels now depend on another Layer. Paint,
  `measure`, and replay all resolve the mask's use in the same Composition.
- The mask fact is revision-only and stored only when set. Removing the
  clip restores the prior Render byte-for-byte: set-then-remove renders
  exactly like never-set.
  - The former mask use is painted again, unless another Layer still
    names it as a mask.
  - Revisions written before masks keep their exact ids.
- A Composition can contain a use that is not painted. The painted-ink pass,
  measurement, and the one-element-per-Layer markup under `#canvas` all
  assume every use is painted. Each must learn which uses are masks.
- The mask fact's removal spelling must not be a possible use name (§1).
  The add/edit refusal-parity tests should pin that the removal value is
  never read as naming a use.
- A copied mask gives the existing import refusal of colliding use names one
  more reason to fire. Import needs no new copying logic.
- Out of scope:
  - soft-edge or feathered masks beyond the mask's own alpha (spec #285
    US-013 treats edge choke and feather separately);
  - masks that reach across Compositions or Projects;
  - grouping (DEC-009).
