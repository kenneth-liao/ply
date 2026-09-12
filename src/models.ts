/**
 * Model registry. Everything routes through Vercel AI Gateway, so switching
 * models is a string change — no new SDK, no new key.
 *
 * Two call shapes exist upstream:
 *   'multimodal' — Nano Banana family. generateText() -> result.files (uint8Array)
 *   'image'      — Flux / Imagen / Recraft / GPT Image. generateImage() -> result.images[].base64
 */
export type ModelKind = "multimodal" | "image";

export interface ModelSpec {
  id: string;
  kind: ModelKind;
  /**
   * Per-image cost at 1K, for the run summary — the estimate a run falls back
   * to when no provider billing receipt is available. A value of 0 is not a
   * free rate but the absence of any rate claim (an unregistered raw gateway
   * id): a run on such a model records unknown cost, never a zero estimate
   * (#126).
   */
  approxCost: number;
  /**
   * The rate's own provenance, and only that:
   *
   * true  — taken from real AI Gateway billing records
   * false — from the Gateway's published pricing table, not yet observed
   *
   * This describes the *rate* — never a charge measured on a request — and is
   * deliberately not copied into any run record (#126): a record says how its
   * own amount was obtained (its cost basis), not how the registry once
   * measured a rate.
   */
  costMeasured: boolean;
  /**
   * Whether the approxCost figure describes (and was measured or published
   * for) calls that carry typed References. When a run's call shape is not
   * what the rate describes — a reference call on a text-only rate — the run
   * records its cost as unknown instead of claiming the rate as measured
   * (TEST-012: the only reference-call billing evidence is an account-window
   * delta, not a per-image rate).
   */
  costCoversRefs: boolean;
  /** Accepts reference images for likeness / style transfer. */
  supportsRef: boolean;
  /**
   * How the model wants its dimensions. OpenAI's image models reject
   * `aspectRatio` and require an explicit `size`.
   */
  sizing?: "aspectRatio" | "size";
  /**
   * The quality tiers this model accepts, when it has any (spec #132 #142).
   * Only models with a real provider-side quality parameter carry this claim:
   * every other model — including raw gateway ids and the multimodal family —
   * has no quality tiers, and none are invented for it (US-005, DEC-007).
   * The absence of this field is itself the refusal: quality selection is a
   * capability read from the one registry, never inferred.
   */
  supportedQualities?: readonly ImageQuality[];
  note: string;
}

  /**
   * The GPT Image 2 quality tiers (spec #132 US-005, #142).
   */
export type ImageQuality = "low" | "medium" | "high";

/**
 * The one runtime home of the tier vocabulary (CRAFT-4, #142 review): every
 * site that tests a value against the quality tiers — CLI syntax, domain
 * validation, record parsing — reads this predicate, so a future tier cannot
 * be added to one site and missed in another.
 */
export function isImageQuality(value: unknown): value is ImageQuality {
  return value === "low" || value === "medium" || value === "high";
}

export const MODELS: Record<string, ModelSpec> = {
  "gpt-image": {
    id: "openai/gpt-image-2",
    kind: "image",
    sizing: "size",
    supportedQualities: ["low", "medium", "high"],
    approxCost: 0.0045,
    costMeasured: true,
    // The measured rate is the text-only plate rate: a reference call bills
    // the image as extra input tokens (#52, TEST-012).
    costCoversRefs: false,
    // Qualified through a real Gateway request with a typed Reference on the
    // exact production call shape (#52, TEST-012): SUPPORTED.
    supportsRef: true,
    note:
      "GPT Image 2 — cheapest and best at following the zone brief; qualified for typed References (#52). " +
      "The rate is the measured text-only plate cost — a reference call bills the image as extra input tokens " +
      "(measured once: $0.016 account-window delta with a ~1 MB reference; the per-generation billing lookup " +
      "was unavailable), not a per-image rate. Slower (~15s)",
  },

  // The Gemini models cost 8-30x more per plate. gpt-image also takes typed
  // References now (qualified through the Gateway, #52), but likeness work
  // remains Nano Banana territory until separately qualified (TEST-012).
  "nano-lite": {
    id: "google/gemini-3.1-flash-lite-image",
    kind: "multimodal",
    approxCost: 0.034,
    costMeasured: true,
    // Measured from reference-bearing creator trials — the rate is the
    // reference-call rate.
    costCoversRefs: true,
    supportsRef: true,
    note: "Nano Banana 2 Lite — fastest (~3s) and the cheapest way to use a face ref",
  },
  "nano-2": {
    id: "google/gemini-3.1-flash-image",
    kind: "multimodal",
    approxCost: 0.067,
    costMeasured: true,
    // Measured from reference-bearing creator trials — the rate is the
    // reference-call rate.
    costCoversRefs: true,
    supportsRef: true,
    note: "Nano Banana 2 — better plates than lite, same reference-image support",
  },
  "nano-pro": {
    id: "google/gemini-3-pro-image",
    kind: "multimodal",
    approxCost: 0.134,
    costMeasured: false,
    costCoversRefs: true,
    supportsRef: true,
    note: "Nano Banana Pro — native 2K/4K and the strongest likeness; priciest by far",
  },

  // Stylistic alternates.
  flux: {
    id: "bfl/flux-2-flex",
    kind: "image",
    approxCost: 0.03,
    costMeasured: false,
    costCoversRefs: false,
    supportsRef: false,
    note: "FLUX.2 Flex — the most stylistic control",
  },
  seedream: {
    id: "bytedance/seedream-5.0-pro",
    kind: "image",
    approxCost: 0.035,
    costMeasured: false,
    // Flat per-image published rate — it covers reference calls too.
    costCoversRefs: true,
    supportsRef: true,
    note: "Seedream 5.0 Pro — flat per-image rate (no 4K penalty), takes reference images; identity strength unproven here",
  },
  recraft: {
    id: "recraft/recraft-v4.1",
    kind: "image",
    approxCost: 0.035,
    costMeasured: false,
    costCoversRefs: false,
    supportsRef: false,
    note: "Recraft V4.1 — clean vector/graphic looks",
  },
};

/**
 * The tool-wide default for general generation (DEC-007): omitting an
 * explicit model selects nano-2, per the reviewed comparison (spec #132).
 * This is the one canonical home for that default — the generate CLI applies
 * it at request normalization (`parsed.model ?? DEFAULT_MODEL`), so an
 * explicit --model selection always takes precedence and one change here
 * moves every reader. The Kenny-likeness caller default (GPT Image 2 low) is
 * NOT a tool default: it lives in the caller's own workflow (DEC-007).
 */
export const DEFAULT_MODEL = "nano-2";

/**
 * The canonical qualified reference-capable list (DEC-018): every registry
 * model the recorded evidence marks as accepting typed References. Default
 * selection, explicit validation, help, and recovery messages all read this
 * one reader — there is no second compatibility list.
 */
export function referenceCapableModels(): { key: string; spec: ModelSpec }[] {
  return Object.entries(MODELS)
    .filter(([, spec]) => spec.supportsRef)
    .map(([key, spec]) => ({ key, spec }));
}

/**
 * The one reference-incompatibility refusal (DEC-020): names the rejected
 * model, states that nothing was sent, and lists every qualified compatible
 * choice derived from the registry — recovery never requires registry
 * knowledge (US-032).
 */
export function referenceIncompatibilityError(spec: ModelSpec): string {
  const qualified = referenceCapableModels()
    .map(({ key, spec: s }) => `${key} (${s.id})`)
    .join(", ");
  return (
    `Model "${spec.id}" is not qualified reference-capable — the registry records no Gateway-proven ` +
    `typed-Reference support for it, so the Job was refused before any provider call and nothing was spent. ` +
    `Qualified reference-capable models: ${qualified}. ` +
    `Raw gateway ids carry no capability claim until they are qualified through a real Gateway request and registered (TEST-012).`
  );
}

/**
 * The reference-capability gate (TEST-011): a model selection for a Job that
 * carries typed References must be qualified reference-capable, or it is
 * refused here — before any generator call, and therefore before any spend
 * (US-031, DEC-020). A selection without References needs no capability
 * claim: the existing default and raw-id pass-through behavior is preserved.
 */
export function validateReferenceCapability(model: string, hasReferences: boolean): void {
  if (!hasReferences) return;
  const spec = resolveModel(model);
  if (!spec.supportsRef) throw new Error(referenceIncompatibilityError(spec));
}

/**
 * The quality-capability refusal (#142): names the rejected model, states
 * that nothing was sent, and points at the one qualified choice — recovery
 * never requires registry knowledge (the same shape as the reference
 * incompatibility message).
 */
export function qualityUnsupportedError(spec: ModelSpec): string {
  return (
    `Model "${spec.id}" takes no quality selection — explicit low/medium/high quality control is qualified for ` +
    `GPT Image 2 only (gpt-image), and no quality tiers are invented for other models (spec #132, DEC-007). ` +
    `The Job was refused before any provider call and nothing was spent; drop --quality or pass --model gpt-image.`
  );
}

/**
 * The quality-capability gate (#142): a quality selection is accepted only
 * for a model whose registry spec carries the qualified tiers — refused
 * before any provider call, therefore before any spend (US-005). A request
 * without a quality selection needs no capability claim: the provider's own
 * default applies and the record gains no quality key.
 */
export function validateQualitySupport(spec: ModelSpec, quality: ImageQuality | undefined): void {
  if (quality === undefined) return;
  if (!spec.supportedQualities?.includes(quality)) throw new Error(qualityUnsupportedError(spec));
}

export function resolveModel(name: string): ModelSpec {
  const spec = MODELS[name];
  if (spec) return spec;
  // Allow passing a raw gateway id through; assume image-only call shape
  // unless it looks like a Gemini multimodal model.
  if (name.includes("/")) {
    // Exact-identity normalization first (DEC-019): a gateway id that names a
    // registered model IS that model — durable Job records may carry the id
    // (recorded before registry keys existed), and rerun must requalify them
    // through the same canonical spec, not strand them as unqualified raws.
    // This is exact id equality, never a substring guess, and it reads the
    // one registry — no alias table, no second capability list.
    const registered = Object.values(MODELS).find((s) => s.id === name);
    if (registered) return registered;
    return {
      id: name,
      kind: name.includes("gemini") ? "multimodal" : "image",
      sizing: name.startsWith("openai/") ? "size" : "aspectRatio",
      approxCost: 0,
      costMeasured: false,
      // No capability or cost claim: an unregistered raw id is unqualified
      // until a real Gateway request proves it and it is registered
      // (DEC-019, TEST-012) — capability is never inferred from the
      // model-name substring. The call-shape guess stays: it is SDK routing,
      // not a capability fact.
      costCoversRefs: false,
      supportsRef: false,
      note: "raw gateway id",
    };
  }
  throw new Error(
    `Unknown model "${name}". Options: ${Object.keys(MODELS).join(", ")} (or a raw gateway id like bytedance/seedream-5.0-lite)`,
  );
}
