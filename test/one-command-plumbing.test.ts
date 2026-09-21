/**
 * The shared one-command plumbing probe (spec #226 DEC-001, US-001 bullet 3;
 * finding A226-002, ticket #258): an option registered through the shared
 * option definition alone — the option table and the shared normalization
 * and application registries — is parsed, validated, and APPLIED by
 * one-command `composition add` with NO add-side code naming it.
 *
 * The probe is registered in this file at runtime (the registration points
 * a real option would touch: the option table, the parseArgs declaration,
 * the shared parse entry, and the shared apply entry) and then driven
 * through the add surface's own paths: the ONE boundary parse
 * (`parseOneCommandOptionValues`, the call that replaced the per-option
 * parse blocks) and the real publication path (`addLayerToComposition`,
 * whose dispatch is the generic registry loop). If a future option still
 * needed an add-side parse block, member, presence check, name mapping, or
 * application case, this probe could not work — that is the poka-yoke.
 *
 * The probe stamp is applied as a plain revision field, and the probe's
 * parse refusal is the probe's own wording: the test asserts the shared
 * plumbing carries both through with no option-specific dispatch anywhere
 * on the add surface.
 */
import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "../src/png.js";
import { initProject } from "../src/project.js";
import { createComposition } from "../src/composition.js";
import { addLayerToComposition } from "../src/composition.js";
import {
  LAYER_OPTION_DEFS,
  LAYER_OPTION_PARSE_ARGS,
  anyOneCommandOptionProvided,
  oneCommandAddOptionKeys,
  oneCommandApplicationOrder,
  type LayerOptionDef,
  type LayerOptionKey,
} from "../src/layer-options.js";
import {
  ONE_COMMAND_OPTION_APPLY,
  ONE_COMMAND_PARSE_ENTRIES,
  parseOneCommandOptionValues,
  type OneCommandOptionParseEntry,
  type OneCommandOptionValues,
} from "../src/one-command.js";

/** The probe's option key and its `--<key>` flag. */
const PROBE_KEY = "probe-stamp" as LayerOptionKey;
const PROBE_FLAG = `--${PROBE_KEY}`;

/** The probe's parse rule: the literal "good" parses; anything else is
 *  refused with the probe's own wording (asserted verbatim below). */
function parseProbeStamp(raw: string | undefined) {
  if (raw === undefined) return { ok: true, value: undefined } as const;
  if (raw !== "good") {
    return { ok: false, error: `${PROBE_FLAG} takes "good" (got "${raw}").` } as const;
  }
  return { ok: true, value: raw } as const;
}

const PROBE_PARSE_ENTRY: OneCommandOptionParseEntry = { key: PROBE_KEY, parse: parseProbeStamp };

const PROBE_DEF: LayerOptionDef = {
  key: PROBE_KEY,
  group: "effect",
  appliesTo: ["image", "text", "shape"],
  editOption: true,
};

beforeAll(() => {
  // The probe's registration — the shared-definition points a real option
  // declares (DEC-001): the option table, the parseArgs declaration, the
  // shared parse entry, and the shared apply entry. Nothing on the add
  // surface names it.
  (LAYER_OPTION_DEFS as LayerOptionDef[]).push(PROBE_DEF);
  (LAYER_OPTION_PARSE_ARGS as Record<string, { type: "string" }>)[PROBE_KEY] = { type: "string" };
  (ONE_COMMAND_PARSE_ENTRIES as OneCommandOptionParseEntry[]).push(PROBE_PARSE_ENTRY);
  (ONE_COMMAND_OPTION_APPLY as Record<string, NonNullable<(typeof ONE_COMMAND_OPTION_APPLY)[LayerOptionKey]>>)[
    PROBE_KEY
  ] = (rev, value) => {
    (rev as unknown as Record<string, unknown>).probeStamp = value;
  };
});

afterAll(() => {
  // Undo every registration: this file runs in its own `bun test
  // --isolate` process (the required per-file topology), so the mutation
  // cannot reach another test file — the undo keeps this file's own state
  // clean regardless of execution order.
  (LAYER_OPTION_DEFS as LayerOptionDef[]).pop();
  delete (LAYER_OPTION_PARSE_ARGS as Record<string, { type: "string" }>)[PROBE_KEY];
  (ONE_COMMAND_PARSE_ENTRIES as OneCommandOptionParseEntry[]).pop();
  delete (ONE_COMMAND_OPTION_APPLY as Record<string, unknown>)[PROBE_KEY];
});

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  return encodePngRgba(width, height, buf);
}

let tempDir: string;
let projDir: string;
let imagePath: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-one-command-plumbing-"));
  projDir = path.join(tempDir, "proj");
  await initProject(projDir, { name: "probe" });
  await createComposition(projDir, "poster", { width: 400, height: 300 });
  imagePath = path.join(tempDir, "red.png");
  await writeFile(imagePath, solidPng(64, 48, [255, 0, 0, 255]));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("the shared definition parses, validates, and applies a probe option on add with no add-side code naming it", async () => {
  // Presence and application order come from the table (the probe's group
  // fact), not from any add-side list.
  expect(anyOneCommandOptionProvided({ [PROBE_KEY]: "good" })).toBe(true);
  expect(oneCommandApplicationOrder({ [PROBE_KEY]: "good", shadow: "1,1,1,#000000" })).toEqual([
    "shadow",
    PROBE_KEY,
  ]);

  // The ONE shared boundary parse: the probe's value normalizes through its
  // parse entry, keyed by the option's own key.
  const parsed = parseOneCommandOptionValues({ [PROBE_KEY]: "good" } as Record<string, string>);
  expect(parsed.ok).toBe(true);
  expect(parsed.ok && (parsed.value as Record<string, unknown>)[PROBE_KEY]).toBe("good");

  // The probe's validation travels through the same shared parse: the
  // probe's own refusal, unchanged.
  const refused = parseOneCommandOptionValues({ [PROBE_KEY]: "bad" } as Record<string, string>);
  expect(refused).toEqual({ ok: false, error: `${PROBE_FLAG} takes "good" (got "bad").` });

  // The real publication path applies the probe through the generic
  // registry loop — no application case names the probe on the add side.
  // (The Layer reader normalizes a revision to its known fields, so the
  // probe fact is read back from the stored revision document itself.)
  const res = await addLayerToComposition(projDir, "poster", "probe1", imagePath, {
    oneCommand: { [PROBE_KEY]: "good" } as OneCommandOptionValues,
  });
  const revDir = path.join(projDir, "layers", res.layer.id + ".revisions");
  const stored = JSON.parse(await readFile(path.join(revDir, res.layer.currentRevisionId + ".json"), "utf8"));
  expect(stored.probeStamp).toBe("good");
  // The probe option does not disturb the established single-revision fact:
  // the published use is the probe add's own.
  expect(res.use.name).toBe("probe1");
});

test("the shared parse and apply registries cover every post-content option (the poka-yoke the switch default carried)", () => {
  // The post-content set is DERIVED from the table (oneCommandAddOptionKeys)
  // — no local re-enumeration to decay: every key it yields must have an
  // application case; the resize family's parse is the shared exclusivity
  // parse, every other key needs a parse entry in the same order the add
  // boundary checks in. The probe is covered by the same derivation.
  const trio = new Set<LayerOptionKey>(["resize", "resize-to", "scale"]);
  for (const key of oneCommandAddOptionKeys()) {
    expect(ONE_COMMAND_OPTION_APPLY[key]).toBeDefined();
    if (!trio.has(key)) {
      expect((ONE_COMMAND_PARSE_ENTRIES as OneCommandOptionParseEntry[]).some((e) => e.key === key)).toBe(true);
    }
  }
  // The resize family's shared parse: each form normalizes through the ONE
  // exclusivity rule.
  const resize = parseOneCommandOptionValues({ resize: "2" });
  expect(resize.ok && resize.value?.resize).toBe(2);
  const scale = parseOneCommandOptionValues({ scale: "2" });
  expect(scale.ok && scale.value?.scale).toBe(2);
  const both = parseOneCommandOptionValues({ resize: "2", scale: "2" });
  expect(both.ok).toBe(false);
});