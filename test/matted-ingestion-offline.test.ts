/**
 * Offline / no-inference / no-generation tripwire for Matting-content
 * ingestion (#108, spec #102 US-005, TEST-005):
 *
 * Ingesting an existing published matte into a Project is a pure local read:
 * it must never load the Matting engine module (no inference, no weights)
 * and never invoke the generation SDK (no provider call, no network). The
 * engine module is mocked to fail hard on any import — the ingestion below
 * runs with the production dependency wiring. The generation SDK is stubbed
 * with functions that fail hard on any call (its module loads transitively
 * for the record parser's shared types, but nothing on the ingestion path
 * may call it).
 */
import { describe, test, expect, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "./png.js";
import { initProject } from "../src/project.js";
import { runMatting } from "../src/matting.js";
import { composeMatte, type MatteEngine } from "../src/matte.js";

mock.module("../src/segment.js", () => {
  throw new Error("TRIPWIRE: Matting ingestion imported the Matting engine module");
});

mock.module("ai", () => ({
  generateText: () => {
    throw new Error("TRIPWIRE: Matting ingestion invoked generation");
  },
  generateImage: () => {
    throw new Error("TRIPWIRE: Matting ingestion invoked generation");
  },
}));

describe("matted-content ingestion runs with the engine and generation SDK forbidden (tripwire armed)", () => {
  test("ingesting a published matte completes offline with both modules unloaded", async () => {
    // Import the ingest graph lazily inside the test so both mocks are
    // definitely armed first (#106 pattern): a static import would evaluate
    // composition.js before mock.module and never rebind.
    const { createComposition, addMattedLayerToComposition } = await import("../src/composition.js");
    const root = await mkdtemp(path.join(tmpdir(), "ply-matted-offline-"));
    try {
      const projDir = path.join(root, "proj");
      await initProject(projDir, { name: "offline" });
      await createComposition(projDir, "thumb", { width: 32, height: 32 });

      const source = path.join(root, "subject.png");
      await writeFile(
        source,
        encodePng(16, 16, () => [200, 30, 40, 255], { colorType: 2 }),
      );
      const mask = encodePng(
        16,
        16,
        (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
        { colorType: 2 },
      );
      const engine: MatteEngine = async ({ bytes, label }) => ({
        bytes: composeMatte(bytes, mask, label),
        engine: "test/segmenter",
        backend: "test-backend",
        timing: { millis: 42, scope: "test-engine-call" },
      });
      // The matte itself runs through the injected seam (no weights); its
      // ingestion below must run with the forbidden modules unloaded.
      const matte = await runMatting(path.join(root, "out", "matting"), "matte-offline-1", source, { engine });

      const res = await addMattedLayerToComposition(
        projDir,
        "thumb",
        "hero",
        {
          matteRoot: path.join(root, "out", "matting"),
          matteId: matte.matteId,
          generationRoot: path.join(root, "out", "generation"),
        },
        { x: 0, y: 0, opacity: 1 },
      );
      expect(res.mattedFrom.matteId).toBe(matte.matteId);
      expect(res.layer.currentRevision.kind).toBe("image");
      expect(res.layer.currentRevision.contentHash).toBe(matte.result.outputs[0]!.contentHash);
      expect(res.generatedFrom).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});