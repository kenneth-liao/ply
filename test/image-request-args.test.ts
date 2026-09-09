/**
 * The image-kind provider request shape at its one home: the uniform
 * generation surface builds its provider requests through this constructor
 * (with the sizing every normalized request carries), so the call shape
 * production takes is certified here and cannot drift. The legacy implicit
 * plate sizing (a fixed 1536x864 landscape / 16:9 default) was retired with
 * the category-specific entry points (#114): explicit caller sizing is now
 * required — there is no implicit default to pin.
 */
import { describe, test, expect } from "bun:test";
import { buildImageRequestArgs } from "../src/generate.js";
import { MODELS } from "../src/models.js";

describe("buildImageRequestArgs", () => {
  test("gpt-image with a reference: registry id, bytes in prompt.images, explicit size", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      buildImageRequestArgs(MODELS["gpt-image"], "the prompt", [bytes], { size: "1536x864" }),
    ).toEqual({
      model: "openai/gpt-image-2",
      prompt: { text: "the prompt", images: [bytes] },
      size: "1536x864",
    });
  });

  test("gpt-image without references: plain string prompt, explicit size", () => {
    const args = buildImageRequestArgs(MODELS["gpt-image"], "the prompt", [], { size: "1024x1024" });
    expect(args).toEqual({
      model: "openai/gpt-image-2",
      prompt: "the prompt",
      size: "1024x1024",
    });
    expect(args.aspectRatio).toBeUndefined();
  });

  test("aspectRatio-sized image models take an aspect ratio and never a size", () => {
    const args = buildImageRequestArgs(MODELS["flux"], "the prompt", [], { aspectRatio: "16:9" });
    expect(args).toEqual({
      model: "bfl/flux-2-flex",
      prompt: "the prompt",
      aspectRatio: "16:9",
    });
    expect(args.size).toBeUndefined();
  });

  test("multimodal models are unrepresentable here — generateText shape only", () => {
    expect(() =>
      buildImageRequestArgs(MODELS["nano-2"], "the prompt", [], { aspectRatio: "1:1" }),
    ).toThrow(/generateText/);
  });
});
