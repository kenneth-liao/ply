// The shared Layer option definition (spec #226 DEC-001): one declaration
// and one validation path per option for `layer edit` and `composition
// add`. These tests pin the poka-yoke invariants the compile-time
// `satisfies` clauses cannot express alone: key sets agree across the
// declarations, per-kind applicability is enumerable, the derived option
// sets are consistent, and each shared validator keeps both surfaces'
// established refusal texts.
import { describe, it, expect } from "bun:test";
import {
  COMPOSITION_ADD_OPTION_KEYS,
  COMPOSITION_ADD_OPTION_PARSE_ARGS,
  LAYER_OPTION_DEFS,
  LAYER_OPTION_PARSE_ARGS,
  TEXT_CONTENT_KEYS,
  anyLayerEditOptionProvided,
  anyOneCommandOptionProvided,
  isAnchorConflicting,
  layerContentKindConflict,
  layerDashNumericFlags,
  layerEditOptionKeys,
  layerOptionsApplicableTo,
  oneCommandAddOptionKeys,
  oneCommandApplicationOrder,
  parseGenerationJobId,
  parseGenerationOutputSelector,
  parseGenerationOutputValue,
  parseLayerAnchor,
  parseLayerCoordinate,
  parseLayerFlip,
  parseLayerFontSize,
  parseLayerLineHeight,
  parseLayerOpacity,
  parseLayerOutline,
  parseLayerRotation,
  parseLayerShadow,
  parseLayerTracking,
  parseLayerWeight,
  parseLayerWidth,
  parseLayerWrapWidth,
  parseLayerBrightness,
  parseLayerContrast,
  parseLayerSaturation,
  parseLayerWarmth,
  parseLayerBlend,
  parseMatteId,
  parseResizeOptions,
  validateTextFaceAxes,
  validateTextTypographyControls,
  type LayerOptionKey,
} from "../src/layer-options.js";

describe("shared Layer option definition (#226 DEC-001)", () => {
  it("the option table and the parseArgs declaration cover the same key set", () => {
    const tableKeys = LAYER_OPTION_DEFS.map((def) => def.key);
    const parseArgsKeys = Object.keys(LAYER_OPTION_PARSE_ARGS);
    expect([...parseArgsKeys].sort()).toEqual([...tableKeys].sort());
    expect(new Set(tableKeys).size).toBe(tableKeys.length);
  });

  it("the add surface's accepted keys and its parseArgs entries agree", () => {
    expect(Object.keys(COMPOSITION_ADD_OPTION_PARSE_ARGS).sort()).toEqual(
      [...COMPOSITION_ADD_OPTION_KEYS].sort(),
    );
    // Every add key is a declared option: the surfaces share definitions.
    for (const key of COMPOSITION_ADD_OPTION_KEYS) {
      expect(LAYER_OPTION_DEFS.some((def) => def.key === key)).toBe(true);
    }
  });

  it("the add surface's accepted keys are DERIVED from the table, not re-declared (#229 DEC-001)", () => {
    // One-command add accepts every option the table declares, by
    // derivation — so the two surfaces' key sets can never drift apart.
    expect([...COMPOSITION_ADD_OPTION_KEYS].sort()).toEqual(
      LAYER_OPTION_DEFS.map((def) => def.key).sort(),
    );
    expect([...COMPOSITION_ADD_OPTION_KEYS].sort()).toEqual(
      [...layerEditOptionKeys(), "output" as LayerOptionKey].sort(),
    );
  });

  it("the one-command post-content set and its application order come from the group fact (#229 DEC-002, #215 paint)", () => {
    // The table's paint, transform, region, and effect groups plus anchored
    // placement — no re-declared list. The paint group (the vector colour,
    // #215) applies first: content-level paint, before the transforms.
    expect(oneCommandAddOptionKeys()).toEqual([
      "vector-color",
      "anchor",
      "resize",
      "resize-to",
      "cover-to",
      "scale",
      "scale-to",
      "rotate",
      "flip",
      "skew",
      "perspective",
      "shadow",
      "outline",
      "inner-shadow",
      "visible-region",
      "visible-region-radius",
      "mask",
      "brightness",
      "contrast",
      "saturation",
      "warmth",
      "blend",
      "glow",
      "blur",
      "choke",
      "feather",
    ]);
    expect(anyOneCommandOptionProvided({ rotate: "5" })).toBe(true);
    expect(anyOneCommandOptionProvided({ scale: "2" })).toBe(true);
    expect(anyOneCommandOptionProvided({ "scale-to": "1.3x0.8" })).toBe(true);
    expect(anyOneCommandOptionProvided({ "vector-color": "#22c55e" })).toBe(true);
    expect(anyOneCommandOptionProvided({ brightness: "1.2" })).toBe(true);
    expect(anyOneCommandOptionProvided({ opacity: "0.5" })).toBe(false);
    expect(anyOneCommandOptionProvided({})).toBe(false);
  });

  it("a consumer can enumerate the options applicable to a Layer kind", () => {
    const forKind = (kind: "image" | "text" | "shape") =>
      LAYER_OPTION_DEFS.filter((def) => def.appliesTo.includes(kind)).map((def) => def.key);
    // Text Layers have no intrinsic pixel size: --resize-to is image and
    // shape only (#259 — a shape's stored width/height are intrinsic pixel
    // facts like an image's).
    expect(LAYER_OPTION_DEFS.find((def) => def.key === "resize-to")!.appliesTo).toEqual(["image", "shape"]);
    expect(LAYER_OPTION_DEFS.find((def) => def.key === "resize")!.appliesTo).toEqual(["image", "text", "shape"]);
    expect(LAYER_OPTION_DEFS.find((def) => def.key === "scale")!.appliesTo).toEqual(["image", "text", "shape"]);
    // Per-axis scale (#296, spec #285 US-030): the same kind set as the
    // uniform setter — one canonical scale fact, every kind.
    expect(LAYER_OPTION_DEFS.find((def) => def.key === "scale-to")!.appliesTo).toEqual(["image", "text", "shape"]);
    // Cover fit (#293, DEC-011) is an image-Layer option: no intrinsic pixel
    // fact on text, and a shape's sizing goes through --resize-to/--scale.
    expect(LAYER_OPTION_DEFS.find((def) => def.key === "cover-to")!.appliesTo).toEqual(["image"]);
    expect(forKind("image")).toContain("image");
    expect(forKind("text")).toContain("text");
    // The shape applicability (#259, A226-004): the kind-shared placement,
    // transform, effect, and region controls — never the vector colour (a
    // shape's colour is its fill) and never the text style options.
    expect(forKind("shape")).toContain("shape");
    expect(forKind("shape")).toContain("anchor");
    expect(forKind("shape")).toContain("scale");
    expect(forKind("shape")).toContain("rotate");
    expect(forKind("shape")).toContain("shadow");
    expect(forKind("shape")).toContain("outline");
    expect(forKind("shape")).toContain("brightness");
    expect(forKind("shape")).toContain("contrast");
    expect(forKind("shape")).toContain("saturation");
    expect(forKind("shape")).toContain("warmth");
    expect(forKind("shape")).not.toContain("vector-color");
    expect(forKind("shape")).not.toContain("font-size");
    for (const def of LAYER_OPTION_DEFS) {
      expect(def.appliesTo.length).toBeGreaterThan(0);
    }
  });

  it("the edit-option enumeration matches the established refusal list order", () => {
    expect(layerEditOptionKeys()).toEqual([
      "image", "from-generation", "from-matte", "text", "shape", "size", "corner-radius", "fill",
      "vector-color",
      "font", "font-file", "font-size", "color",
      "weight", "width", "tracking", "line-height", "wrap-width", "fit-box",
      "run", "run-text", "runs", "run-color", "run-font", "run-font-file", "run-weight", "run-width",
      "x", "y", "opacity", "anchor",
      "resize", "resize-to", "cover-to", "scale", "scale-to", "rotate", "flip", "skew", "perspective", "shadow", "outline", "inner-shadow", "visible-region", "visible-region-radius", "mask",
      "brightness", "contrast", "saturation", "warmth", "blend", "glow", "blur", "choke", "feather",
    ]);
  });

  it("only edit options count as edit options (--output is a selector)", () => {
    expect(anyLayerEditOptionProvided({ image: "a.png" })).toBe(true);
    expect(anyLayerEditOptionProvided({ output: "2" })).toBe(false);
    expect(anyLayerEditOptionProvided({})).toBe(false);
  });

  it("the dash-numeric facts come from the table", () => {
    expect(layerDashNumericFlags(["x", "y", "tracking", "line-height", "wrap-width", "fit-box"])).toEqual([
      "--x", "--y", "--tracking", "--line-height", "--wrap-width", "--fit-box",
    ]);
    // The edit surface's join covers the transform/effect/region numeric
    // options too.
    const editFlags = layerDashNumericFlags(layerEditOptionKeys());
    expect(editFlags).toEqual(
      expect.arrayContaining(["--x", "--y", "--rotate", "--shadow", "--outline", "--visible-region", "--tracking", "--line-height", "--warmth"]),
    );
    // #208 adds the shape size and corner radius options (dash-numeric: a
    // negative value is legitimate input the ingestion validator refuses
    // with its range); #211 adds --visible-region the same way; #212 adds
    // --visible-region-radius (a negative radius is refused by the parser,
    // but the boundary still accepts dash-leading values); #219 adds --warmth (-1..1);
    // #294 adds --wrap-width (a negative width is refused by the range validator);
    // #295 adds --fit-box the same way (a negative axis is refused by the range validator);
    // #299 adds --blur (a negative radius is refused by the range validator);
    // #300 adds --choke and --feather the same way (negative radii are
    // refused by the range validators); #303 adds --inner-shadow the same
    // way (a negative offset is legitimate input).
    expect(editFlags).toHaveLength(18);
    expect(layerDashNumericFlags(layerEditOptionKeys())).toContain("--corner-radius");
    expect(layerDashNumericFlags(layerEditOptionKeys())).toContain("--warmth");
  });

  it("the anchor conflict set is derived from the table", () => {
    expect(isAnchorConflicting({ anchor: "left", rotate: "5" })).toBe(true);
    expect(isAnchorConflicting({ anchor: "left", resize: "2" })).toBe(true);
    expect(isAnchorConflicting({ anchor: "left", scale: "2" })).toBe(true);
    expect(isAnchorConflicting({ anchor: "left", text: "hi" })).toBe(true);
    // --opacity and the anchor's own axes combine freely.
    expect(isAnchorConflicting({ anchor: "left", opacity: "0.5", x: "1", y: "2" })).toBe(false);
  });

  it("content-kind membership is derived from the text option set", () => {
    expect(TEXT_CONTENT_KEYS).toContain("text");
    for (const key of ["font", "font-file", "font-size", "color", "weight", "width", "tracking", "line-height", "wrap-width"] as LayerOptionKey[]) {
      expect(TEXT_CONTENT_KEYS).toContain(key);
    }
    expect(layerContentKindConflict({ image: "a.png", tracking: "1" }, "image", "edit")).toBeDefined();
  });

  it("the blank --image truthiness hunk is pinned on both surfaces (INT-1)", () => {
    // The add surface's established check reads truthiness: a blank --image
    // is not a supplied content kind, so the exclusivity rule does not fire
    // and the command falls past it to the add path's later refusals
    // (missing content without content, the text branch with --text).
    expect(layerContentKindConflict({ image: "", text: "hi" }, "image", "add")).toBeUndefined();
    // The edit surface reads presence exactly: the exclusivity refusal fires.
    expect(layerContentKindConflict({ image: "", text: "hi" }, "image", "edit")).toBe(
      "--image and text options (--text, --font, --font-file, --font-size, --color, --weight, --width, --tracking, --line-height, --wrap-width, --fit-box, --run, --run-text, --runs, --run-color, --run-font, --run-font-file, --run-weight, --run-width) are mutually exclusive.",
    );
    // The other content kinds keep strict presence on both surfaces: a
    // blank --image still conflicts with --from-generation/--from-matte.
    expect(layerContentKindConflict({ image: "", "from-generation": "j1" }, "from-generation", "add")).toBeDefined();
    expect(layerContentKindConflict({ image: "", "from-matte": "m1" }, "from-matte", "edit")).toBeDefined();
  });
});

describe("shared option validators: both surfaces' established texts", () => {
  it("coordinates: one wording on every surface (#257), the refusal names the axis", () => {
    expect(parseLayerCoordinate("x", "abc")).toEqual({
      ok: false,
      error: "Placement coordinate (--x) must be a finite number.",
    });
    expect(parseLayerCoordinate("y", "abc")).toEqual({
      ok: false,
      error: "Placement coordinate (--y) must be a finite number.",
    });
    expect(parseLayerCoordinate("x", "-5")).toEqual({ ok: true, value: -5 });
    expect(parseLayerCoordinate("y", "")).toMatchObject({ ok: false });
  });

  it("opacity: one text for both surfaces, 0..1", () => {
    expect(parseLayerOpacity("2")).toEqual({
      ok: false,
      error: "Opacity (--opacity) must be a finite number between 0 and 1.",
    });
    expect(parseLayerOpacity("0.5")).toEqual({ ok: true, value: 0.5 });
  });

  it("font size: one positive-finite wording and range on every surface (#257)", () => {
    expect(parseLayerFontSize("0")).toEqual({
      ok: false,
      error: "Font size (--font-size) must be a positive finite number.",
    });
    expect(parseLayerFontSize("-4")).toMatchObject({ ok: false });
    expect(parseLayerFontSize("abc")).toEqual({
      ok: false,
      error: "Font size (--font-size) must be a positive finite number.",
    });
    expect(parseLayerFontSize("64")).toEqual({ ok: true, value: 64 });
  });

  it("weight, width, tracking: one finite-number text everywhere", () => {
    expect(parseLayerWeight("abc")).toEqual({ ok: false, error: "Weight (--weight) must be a finite number." });
    expect(parseLayerWidth("abc")).toEqual({ ok: false, error: "Width (--width) must be a finite number." });
    expect(parseLayerTracking("abc")).toEqual({ ok: false, error: "Tracking (--tracking) must be a finite number." });
    expect(parseLayerWeight("400")).toEqual({ ok: true, value: 400 });
  });

  it("line height: number or the normal clear-form", () => {
    expect(parseLayerLineHeight("normal")).toEqual({ ok: true, value: null });
    expect(parseLayerLineHeight("1.5")).toEqual({ ok: true, value: 1.5 });
    expect(parseLayerLineHeight("abc")).toEqual({
      ok: false,
      error: 'Line height (--line-height) must be a finite number or "normal".',
    });
  });

  it("wrap width: number or the none clear-form (#294)", () => {
    expect(parseLayerWrapWidth("none")).toEqual({ ok: true, value: null });
    expect(parseLayerWrapWidth("220")).toEqual({ ok: true, value: 220 });
    expect(parseLayerWrapWidth("abc")).toEqual({
      ok: false,
      error: 'Wrap width (--wrap-width) must be a finite number of layout px or "none".',
    });
  });

  it("typography range and face axes route through the domain validators", () => {
    expect(validateTextTypographyControls(5, undefined)).toContain("between -0.5 and 1");
    expect(validateTextTypographyControls(0.5, 1.5)).toBeUndefined();
    expect(validateTextFaceAxes("Archivo", 95, undefined)).toContain("supports weight 100-900");
    expect(validateTextFaceAxes("Archivo", 400, undefined)).toBeUndefined();
    // An unknown family keeps its established semantic refusal (thrown).
    expect(() => validateTextFaceAxes("Comic Sans MS", undefined, undefined)).toThrow(/unknown font family/);
  });

  it("generation/matte/output selectors keep their established texts", () => {
    expect(parseGenerationJobId(" ")).toEqual({
      ok: false,
      error: "--from-generation takes a Generation Job id (see ply generate list).",
    });
    expect(parseGenerationJobId(" job1 ")).toEqual({ ok: true, value: "job1" });
    expect(parseMatteId(" ")).toEqual({ ok: false, error: "--from-matte takes a matte id (see ply matte)." });
    expect(parseGenerationOutputSelector("2", false)).toEqual({
      ok: false,
      error: "--output is only valid together with --from-generation <jobId>.",
    });
    expect(parseGenerationOutputValue("0")).toEqual({
      ok: false,
      error: '--output takes a 1-based output index, a sha-256 prefix of at least 12 hex characters, or the full sha-256 output identity (got "0")',
    });
    expect(parseGenerationOutputValue("2")).toEqual({ ok: true, value: "2" });
    // Index vs prefix is unambiguous by construction (DEC-004): all digits
    // and fewer than 12 characters is an index; 12–64 hex characters is a
    // prefix, even when all digits. Uppercase hex is normalized here.
    expect(parseGenerationOutputValue("11")).toEqual({ ok: true, value: "11" });
    expect(parseGenerationOutputValue("123456789012")).toEqual({ ok: true, value: "123456789012" });
    expect(parseGenerationOutputValue("a".repeat(12))).toEqual({ ok: true, value: "a".repeat(12) });
    expect(parseGenerationOutputValue(("ab".repeat(12)).toUpperCase())).toEqual({ ok: true, value: "ab".repeat(12) });
    expect(parseGenerationOutputValue("a".repeat(11))).toEqual({
      ok: false,
      error: `--output takes a 1-based output index, a sha-256 prefix of at least 12 hex characters, or the full sha-256 output identity (got "${"a".repeat(11)}")`,
    });
    expect(parseGenerationOutputValue("a".repeat(65))).toEqual({
      ok: false,
      error: `--output takes a 1-based output index, a sha-256 prefix of at least 12 hex characters, or the full sha-256 output identity (got "${"a".repeat(65)}")`,
    });
  });

  it("resize pair: exclusivity and both forms' texts", () => {
    expect(parseResizeOptions("2", "100x100")).toEqual({
      ok: false,
      error: "--resize and --resize-to are mutually exclusive resize forms: use one per edit.",
    });
    expect(parseResizeOptions("-1", undefined)).toEqual({
      ok: false,
      error: 'Resize factor (--resize) must be a finite number greater than 0 (got "-1").',
    });
    expect(parseResizeOptions(undefined, "100")).toEqual({
      ok: false,
      error:
        '--resize-to takes "<W>x<H>" (both axes: deliberate aspect change) or "<W>x" / "x<H>" (one axis: aspect preserved), e.g. "800x600", "800x", "x600" — got "100".',
    });
    expect(parseResizeOptions(undefined, "800x")).toEqual({ ok: true, value: { resizeTo: { width: 800 } } });
  });

  it("resize/scale family: the extended exclusivity and --scale's text (#231)", () => {
    expect(parseResizeOptions("2", undefined, "1.5")).toEqual({
      ok: false,
      error: "--resize and --scale are mutually exclusive: use one resize form per edit (--resize is relative, --scale sets the absolute scale).",
    });
    expect(parseResizeOptions(undefined, "800x", "1.5")).toEqual({
      ok: false,
      error: "--resize-to and --scale are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale sets the absolute scale).",
    });
    expect(parseResizeOptions(undefined, undefined, "0")).toEqual({
      ok: false,
      error: 'Scale (--scale) must be a finite number greater than 0 (got "0").',
    });
    expect(parseResizeOptions(undefined, undefined, "abc")).toEqual({
      ok: false,
      error: 'Scale (--scale) must be a finite number greater than 0 (got "abc").',
    });
    expect(parseResizeOptions(undefined, undefined, "2")).toEqual({ ok: true, value: { scale: 2 } });
  });

  it("resize family: --scale-to grammar, bounds, and exclusivity texts (#296)", () => {
    expect(parseResizeOptions(undefined, undefined, undefined, undefined, "1.3x0.8")).toEqual({
      ok: true,
      value: { scaleTo: { scaleX: 1.3, scaleY: 0.8 } },
    });
    expect(parseResizeOptions(undefined, undefined, undefined, undefined, "2x")).toEqual({
      ok: true,
      value: { scaleTo: { scaleX: 2 } },
    });
    expect(parseResizeOptions(undefined, undefined, undefined, undefined, "x0.5")).toEqual({
      ok: true,
      value: { scaleTo: { scaleY: 0.5 } },
    });
    expect(parseResizeOptions(undefined, undefined, undefined, undefined, "banana")).toEqual({
      ok: false,
      error:
        '--scale-to takes "<X>x<Y>" (both axes: independent absolute factors) or "<X>x" / "x<Y>" (one axis: the omitted axis keeps the Layer\'s current scale), e.g. "1.3x0.8" — got "banana".',
    });
    expect(parseResizeOptions(undefined, undefined, undefined, undefined, "1.3")).toEqual({
      ok: false,
      error:
        '--scale-to takes "<X>x<Y>" (both axes: independent absolute factors) or "<X>x" / "x<Y>" (one axis: the omitted axis keeps the Layer\'s current scale), e.g. "1.3x0.8" — got "1.3".',
    });
    expect(parseResizeOptions("2", undefined, undefined, undefined, "2x2")).toEqual({
      ok: false,
      error: "--resize and --scale-to are mutually exclusive: use one resize form per edit (--resize is relative, --scale-to sets the absolute per-axis scale).",
    });
    expect(parseResizeOptions(undefined, "96x", undefined, undefined, "2x")).toEqual({
      ok: false,
      error: "--resize-to and --scale-to are mutually exclusive: use one resize form per edit (--resize-to sets an absolute size, --scale-to sets the absolute per-axis scale).",
    });
    expect(parseResizeOptions(undefined, undefined, undefined, "96x96", "x2")).toEqual({
      ok: false,
      error: "--cover-to and --scale-to are mutually exclusive: use one resize form per edit (--cover-to sets a cover-fit size, --scale-to sets the absolute per-axis scale).",
    });
    expect(parseResizeOptions(undefined, undefined, "2", undefined, "2x2")).toEqual({
      ok: false,
      error: "--scale and --scale-to are mutually exclusive: use one resize form per edit (--scale sets a uniform absolute scale, --scale-to sets the absolute per-axis scale).",
    });
  });

  it("rotate, flip, shadow, outline, anchor keep their texts", () => {
    expect(parseLayerRotation("abc")).toEqual({
      ok: false,
      error: 'Rotation (--rotate) must be a finite number of degrees, clockwise positive (got "abc").',
    });
    expect(parseLayerFlip("sideways")).toEqual({
      ok: false,
      error: 'Flip (--flip) takes horizontal, vertical, both, or none (got "sideways").',
    });
    expect(parseLayerShadow("1,2,3")!.ok).toBe(false);
    expect(parseLayerOutline("999,#000")!.ok).toBe(false);
    expect(parseLayerAnchor("center")!.ok).toBe(false);
    expect(parseLayerAnchor("left")).toEqual({ ok: true, value: { horizontal: "left" } });
    expect(parseLayerFlip("NONE")).toEqual({ ok: true, value: "none" });
  });

  it("grade controls: one text and range check for both surfaces (#219)", () => {
    expect(parseLayerBrightness("abc")).toEqual({
      ok: false,
      error: 'Brightness (--brightness) must be a finite number between 0 and 5 (got "abc").',
    });
    expect(parseLayerBrightness("-0.1")).toEqual({
      ok: false,
      error: 'Brightness (--brightness) must be a finite number between 0 and 5 (got "-0.1").',
    });
    expect(parseLayerBrightness("5.1")).toEqual({
      ok: false,
      error: 'Brightness (--brightness) must be a finite number between 0 and 5 (got "5.1").',
    });
    expect(parseLayerBrightness("1.5")).toEqual({ ok: true, value: 1.5 });
    expect(parseLayerBrightness(undefined)).toEqual({ ok: true, value: undefined });

    expect(parseLayerContrast("6")).toEqual({
      ok: false,
      error: 'Contrast (--contrast) must be a finite number between 0 and 5 (got "6").',
    });
    expect(parseLayerContrast("0")).toEqual({ ok: true, value: 0 });

    expect(parseLayerSaturation("-1")).toEqual({
      ok: false,
      error: 'Saturation (--saturation) must be a finite number between 0 and 5 (got "-1").',
    });
    expect(parseLayerSaturation("2")).toEqual({ ok: true, value: 2 });

    expect(parseLayerWarmth("-1.5")).toEqual({
      ok: false,
      error: 'Warmth (--warmth) must be a finite number between -1 and 1 (got "-1.5").',
    });
    expect(parseLayerWarmth("1.5")).toEqual({
      ok: false,
      error: 'Warmth (--warmth) must be a finite number between -1 and 1 (got "1.5").',
    });
    expect(parseLayerWarmth("-0.5")).toEqual({ ok: true, value: -0.5 });
    expect(parseLayerWarmth("0")).toEqual({ ok: true, value: 0 });
  });

  it("blend mode: one validator for both surfaces (#220)", () => {
    expect(parseLayerBlend("banana")).toEqual({
      ok: false,
      error:
        'Blend mode (--blend) takes normal, multiply, screen, overlay, soft-light, darken, lighten, or color-dodge (got "banana").',
    });
    expect(parseLayerBlend("normal")).toEqual({ ok: true, value: "normal" });
    expect(parseLayerBlend("multiply")).toEqual({ ok: true, value: "multiply" });
    expect(parseLayerBlend("colour-dodge")).toEqual({ ok: true, value: "color-dodge" });
    expect(parseLayerBlend(undefined)).toEqual({ ok: true, value: undefined });
  });
});