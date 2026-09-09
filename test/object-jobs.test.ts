import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJob, listJobs, adoptCandidate } from "../src/jobs.js";
import { scanLibrary, writePlateAsset } from "../src/assets.js";
import { loadScene } from "../src/scene.js";
import { buildManifest, readManifest } from "../src/manifest.js";
import { encodePng } from "./png.js";
import { writeLegacyJob, type LegacyJobSpec } from "./legacy-jobs.js";

let root: string;
let jobRoot: string;
let libraryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ply-object-jobs-"));
  jobRoot = path.join(root, "jobs");
  libraryRoot = path.join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True-alpha PNG: a 4×4 opaque red subject in a 16×16 transparent frame. */
const ALPHA_PNG = encodePng(16, 16, (x, y) =>
  x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
);

/** The measured reality: an opaque candidate whose backdrop is painted pixels. */
const OPAQUE_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [230, 120, 80, 255] : [20, 90, 200, 255]),
  { colorType: 2 },
);

/** The segmentation mask the matting engine predicted for it before retirement. */
const MASK_PNG = encodePng(
  16,
  16,
  (x, y) => (x < 8 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  { colorType: 2 },
);

/** An object record as a pre-retirement binary wrote it: native-alpha candidates. */
const nativeObjectJob = (jobId: string, extra?: Partial<LegacyJobSpec>): LegacyJobSpec => ({
  jobId,
  kind: "object",
  subject: "a retro desk lamp",
  runs: [{
    candidates: [
      { bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${jobId}-one`)]), },
      { bytes: Buffer.concat([ALPHA_PNG, Buffer.from(`-${jobId}-two`)]), },
    ],
  }],
  ...extra,
});

/** An object record whose candidate is the opaque reality, with the run's recorded matte. */
const mattedObjectJob = (jobId: string, extra?: Partial<LegacyJobSpec>): LegacyJobSpec => ({
  jobId,
  kind: "object",
  subject: "a retro desk lamp",
  runs: [{
    candidates: [{
      bytes: OPAQUE_PNG,
      matteBytes: Buffer.concat([ALPHA_PNG, MASK_PNG]),
      matteEngine: "test/segmentation",
    }],
  }],
  ...extra,
});

describe("adoptCandidate for object jobs", () => {
  test("adopts a true-alpha candidate as an Object Asset with provenance", async () => {
    const job = await writeLegacyJob(jobRoot, nativeObjectJob("obj-adopt"));
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "obj-adopt", cand.contentHash, "lamp", {
      libraryRoot,
      name: "Desk Lamp",
      tags: ["retro"],
    });

    expect(result.adoptedFrom).toBe(`job:obj-adopt#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "lamp")!;
    expect(asset).toBeDefined();
    expect(asset.hash).toBe(cand.contentHash);
    expect(asset.meta.kind).toBe("object");
    if (asset.meta.kind === "object") {
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.subject).toBe("a retro desk lamp");
      expect(asset.meta.model).toBe("openai/gpt-image-2");
    }
    expect(result.imagePath).toBe(asset.imagePath);
  });

  test("adopts a matted candidate's matte — verified true alpha enters the library", async () => {
    const job = await writeLegacyJob(jobRoot, mattedObjectJob("obj-adopt-matte"));
    const cand = job.runs[0]!.candidates[0]!;

    const result = await adoptCandidate(jobRoot, "obj-adopt-matte", cand.contentHash, "tile", {
      libraryRoot,
      name: "Hook Tile",
      tags: ["hook-scene"],
    });

    // The asset's identity is the matte's — the isolated form is what ships.
    expect(result.contentHash).toBe(cand.matte!.contentHash);
    expect(result.adoptedFrom).toBe(`job:obj-adopt-matte#${cand.contentHash}`);
    const lib = await scanLibrary(libraryRoot);
    const asset = lib.objects.find((o) => o.meta.id === "tile")!;
    expect(asset.hash).toBe(cand.matte!.contentHash);
    expect(asset.meta.kind).toBe("object");
    if (asset.meta.kind === "object") {
      expect(asset.meta.matting).toBe("true-alpha");
      expect(asset.meta.matteEngine).toBe("test/segmentation");
      expect(asset.meta.subject).toBe("a retro desk lamp");
      expect(asset.meta.model).toBe("openai/gpt-image-2");
    }
    expect(result.imagePath).toBe(asset.imagePath);
  });

  test("refuses an opaque candidate with no matte — chroma-key color distance cannot qualify", async () => {
    // The run recorded no matte (the pass failed before retirement); the raw
    // candidate is opaque, so adoption refuses it.
    await writeLegacyJob(jobRoot, {
      jobId: "obj-opaque",
      kind: "object",
      subject: "a retro desk lamp",
      runs: [{
        candidates: [{ bytes: OPAQUE_PNG }],
        warnings: ["matte: candidate could not be isolated — segmenter unavailable"],
      }],
    });
    const job = await loadJob(jobRoot, "obj-opaque");
    const hash = job.runs[0]!.candidates[0]!.contentHash;

    await expect(
      adoptCandidate(jobRoot, "obj-opaque", hash, "opaque-lamp", { libraryRoot }),
    ).rejects.toThrow(/matte|chroma-key|alpha/i);
    // The refusal's diagnostics point at the replacement workflow, not the
    // retired commands.
    try {
      await adoptCandidate(jobRoot, "obj-opaque", hash, "opaque-lamp-2", { libraryRoot });
      throw new Error("adoption should have been refused");
    } catch (err) {
      expect((err as Error).message).toMatch(/bun run generate/);
      expect((err as Error).message).not.toMatch(/jobs rerun/);
    }
    // Nothing entered the library.
    const lib = await scanLibrary(libraryRoot);
    expect(lib.objects).toHaveLength(0);
  });

  test("refuses a non-PNG candidate outright", async () => {
    await writeLegacyJob(jobRoot, {
      jobId: "obj-jpeg",
      kind: "object",
      runs: [{ candidates: [{ bytes: Buffer.from("jpeg bytes"), mediaType: "image/jpeg" }] }],
    });
    const job = await loadJob(jobRoot, "obj-jpeg");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    await expect(
      adoptCandidate(jobRoot, "obj-jpeg", hash, "jpeg-lamp", { libraryRoot }),
    ).rejects.toThrow(/PNG|alpha|matte/i);
  });

  test("never overwrites an existing asset", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-overwrite"));
    const job = await loadJob(jobRoot, "obj-overwrite");
    const [a, b] = job.runs[0]!.candidates;
    await adoptCandidate(jobRoot, "obj-overwrite", a!.contentHash, "taken", { libraryRoot });
    await expect(
      adoptCandidate(jobRoot, "obj-overwrite", b!.contentHash, "taken", { libraryRoot }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("loadJob record integrity", () => {
  test("refuses a record whose kind contradicts its request kind — one discriminant or none", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-contradiction"));
    const file = path.join(jobRoot, "obj-contradiction", "job.json");
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.kind = "plate"; // claims the plate contract while carrying an object request
    await writeFile(file, JSON.stringify(tampered, null, 2));
    // Both dispatch paths go through loadJob — neither can run the contradiction.
    await expect(loadJob(jobRoot, "obj-contradiction")).rejects.toThrow(/contradictory/i);
    await expect(adoptCandidate(jobRoot, "obj-contradiction", "0", "steal", { libraryRoot })).rejects.toThrow(
      /contradictory/i,
    );
  });

  test("refuses a v3 record claiming kind object — an older binary would misread it", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-forged-v3", { schemaVersion: 3 }));
    await expect(loadJob(jobRoot, "obj-forged-v3")).rejects.toThrow(/schemaVersion 3/);
  });

  test("rejects a v1 record claiming kind object — v1 is plate-only, the rollback boundary", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-forged-v1", { schemaVersion: 1 }));
    await expect(loadJob(jobRoot, "obj-forged-v1")).rejects.toThrow(/schemaVersion 1.*plate-only/i);
    await expect(adoptCandidate(jobRoot, "obj-forged-v1", "0", "no-gate", { libraryRoot })).rejects.toThrow(
      /plate-only/i,
    );
  });

  test("adopts a candidate mislabeled image/jpeg as a PNG object — verified bytes are the truth", async () => {
    await writeLegacyJob(jobRoot, {
      jobId: "obj-mislabeled",
      kind: "object",
      runs: [{ candidates: [{ bytes: ALPHA_PNG, mediaType: "image/jpeg" }] }],
    });
    const job = await loadJob(jobRoot, "obj-mislabeled");
    const hash = job.runs[0]!.candidates[0]!.contentHash;
    const result = await adoptCandidate(jobRoot, "obj-mislabeled", hash, "lamp", { libraryRoot });
    // The alpha gate proved the bytes are PNG, so the asset is object.png —
    // not object.jpg — and downstream resolution reports image/png.
    expect(result.imagePath.endsWith(path.join("lamp", "object.png"))).toBe(true);
    const lib = await scanLibrary(libraryRoot);
    expect(lib.objects[0]!.imagePath).toBe(result.imagePath);
  });
});

describe("listJobs with object jobs", () => {
  test("summarizes both kinds from one jobs root", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-a"));
    const jobs = await listJobs(jobRoot);
    const a = jobs.find((j) => j.jobId === "obj-a")!;
    expect(a.kind).toBe("object");
    expect(a.subject).toBe("a retro desk lamp");
    expect(a.candidates).toBe(2);
  });
});

describe("an adopted Object Asset in a Scene", () => {
  test("loads as an Image layer behind and in front of other layers, movable and hideable", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-scene"));
    const job = await loadJob(jobRoot, "obj-scene");
    await adoptCandidate(jobRoot, "obj-scene", job.runs[0]!.candidates[0]!.contentHash, "lamp", {
      libraryRoot,
    });
    // A backdrop plate for the object to sit over.
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });

    // Array order is compositing order: the object layer sits behind the text
    // layer and in front of the plate — both placements resolve the same
    // library bytes, and moving/resizing/hiding are scene fields on the layer,
    // so none of it touches the plate or any other layer's bytes.
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      layers: [
        { id: "plate", type: "image", asset: "library:plate-a",
          position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
        { id: "lamp", type: "image", asset: "library:lamp",
          position: { x: 500, y: 300 }, size: { width: 280, height: 280 } },
        { id: "headline", type: "text", text: "NEW LAMP", font: "Anton", fontSize: 80,
          position: { x: 100, y: 100 }, size: { width: 600, height: 120 } },
      ],
    };
    const lib = await scanLibrary(libraryRoot);
    const loaded = await loadScene(libraryRoot, async () => lib, scene);
    if (!loaded.ok) throw new Error(`scene failed to load: ${JSON.stringify(loaded.errors)}`);
    const lamp = loaded.resolved.assets.get("lamp")!;
    expect(lamp.kind).toBe("object");
    expect(lamp.id).toBe("lamp");
    // The same asset bytes serve a second, independently transformed layer —
    // no regeneration of anything.
    const hidden = structuredClone(scene);
    (hidden.layers[1] as { visible?: boolean }).visible = false;
    (hidden.layers[1] as { position: { x: number } }).position.x = 900;
    const again = await loadScene(libraryRoot, async () => lib, hidden);
    expect(again.ok).toBe(true);
  });

  test("records the object kind in a Render manifest that verifies on read", async () => {
    await writeLegacyJob(jobRoot, nativeObjectJob("obj-manifest"));
    const job = await loadJob(jobRoot, "obj-manifest");
    await adoptCandidate(jobRoot, "obj-manifest", job.runs[0]!.candidates[0]!.contentHash, "lamp", {
      libraryRoot,
    });
    await writePlateAsset(libraryRoot, "plate-a", new TextEncoder().encode("PLATE"), {
      kind: "plate", id: "plate-a", name: "Plate A", tags: [],
    });
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      layers: [
        { id: "lamp", type: "image", asset: "library:lamp",
          position: { x: 500, y: 300 }, size: { width: 280, height: 280 } },
      ],
    };
    const lib = await scanLibrary(libraryRoot);
    const loaded = await loadScene(libraryRoot, async () => lib, scene);
    if (!loaded.ok) throw new Error("scene failed to load");

    const manifestDir = path.join(root, "out");
    await mkdir(manifestDir, { recursive: true });
    const png = encodePng(1280, 720, () => [10, 10, 10, 255]);
    const manifest = buildManifest({
      manifestDir,
      sceneFile: path.join(libraryRoot, "scene.json"),
      sceneSha256: "a".repeat(64),
      variant: [],
      outputs: [{
        output: path.join(manifestDir, "scene.png"),
        width: 1280, height: 720, png, warnings: [],
        resolved: loaded.resolved,
      }],
    });
    // The recorded identity survives the manifest's strict read validation —
    // an object render must rerender, not fail its own record.
    const readResult = await readManifest(
      path.join(manifestDir, "scene.manifest.json"),
      Buffer.from(JSON.stringify(manifest)),
    );
    if (!readResult.ok) throw new Error(`manifest failed its own read: ${JSON.stringify(readResult.errors)}`);
    const lamp = readResult.manifest.outputs[0]!.assets.find((a) => a.id === "lamp")!;
    expect(lamp.kind).toBe("object");
  });
});