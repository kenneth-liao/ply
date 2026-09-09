import { describe, test, expect } from "bun:test";
import { MODELS, referenceCapableModels } from "../src/models.js";

/**
 * The model registry is the one capability source for the uniform generation
 * surface (DEC-018/DEC-020): qualification facts are recorded once here and
 * read by default selection, validation, help, and recovery messages. The
 * legacy per-kind default selection and its pre-spend refusals were retired
 * with the category-specific generation entry points (#114); the replacement
 * coverage for the capability gate lives in test/generation.test.ts and
 * test/generation-cli.test.ts.
 */
describe("the registry is the one capability source", () => {
  test("GPT Image 2 capability and measured-cost facts reflect the #52 evidence", () => {
    const gpt = MODELS["gpt-image"];
    expect(gpt.supportsRef).toBe(true);
    // The run-summary rate stays the measured text-only plate figure.
    expect(gpt.approxCost).toBe(0.0045);
    expect(gpt.costMeasured).toBe(true);
    // The reference-call evidence is recorded as an account-window delta with
    // its basis stated — never presented as a per-image rate or run cost.
    expect(gpt.note).toMatch(/account-window delta/);
    expect(gpt.note).toMatch(/not a per-image rate/);
  });

  test("the qualified reference-capable list is derived from the registry, never duplicated", () => {
    for (const { key, spec } of referenceCapableModels()) {
      expect(spec.supportsRef).toBe(true);
      expect(MODELS[key]).toBe(spec);
    }
  });
});