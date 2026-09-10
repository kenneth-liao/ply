#!/usr/bin/env bun
// Composition management CLI: create, add layers, inspect, and list Compositions.
import { parseArgs } from "node:util";
import path from "node:path";
import {
  createComposition,
  addLayerToComposition,
  addTextLayerToComposition,
  addGeneratedLayerToComposition,
  addMattedLayerToComposition,
  importComposition,
  importCompositionCrossProject,
  removeLayerFromComposition,
  reorderCompositionLayers,
  inspectComposition,
  listCompositions,
  type ResolvedComposition,
  type ResolvedCompositionLayer,
} from "./composition.js";
import { renderComposition, replayRender } from "./composition-render.js";
import { measureCompositionLayers, type MeasuredLayerBounds } from "./composition-measure.js";
import { closeCliBrowser } from "./cli-browser.js";

const HELP = `
composition — Composition authoring and inspection

  bun run ply composition create <name> --width <w> --height <h> [options]
      Create a new Composition with explicit canvas dimensions

  bun run ply composition add <comp> <name> --image <path> [options]
      Add a local image Layer to a Composition with optional placement

  bun run ply composition add <comp> <name> --text <str> --font <family> [options]
      Add a locally rendered text Layer. The bundled font family's bytes are
      retained into the Project, so rendering never needs the original font
      files. Mutually exclusive with --image.

  bun run ply composition import <target> <source> [options]
      Import a Composition's Layer references into another Composition
      within the same Project as individually editable uses

  bun run ply composition import <target> <source> --from-project <dir>
      Copy a Composition's Layers from another Project into the target
      Composition as independent destination Layer identities with retained
      content bytes (source edits never propagate; no live links)

  bun run ply composition remove <comp> <name> [options]
      Remove a Layer use from a Composition without deleting the Layer,
      retained revisions, or other Compositions' uses

  bun run ply composition reorder <comp> --order <name1,name2,...> [options]
      Reorder Layer uses within a Composition to change painting order
      (exact full-order permutation of all existing local use names)

  bun run ply composition inspect <name> [options]
      Inspect a Composition's canvas and ordered Layers

  bun run ply composition measure <comp> [use-name] [options]
      Measure Layer geometry read-only in Composition coordinates, including
      the current scale, rotation, and reflection. Reports each Layer's
      LAYOUT boxes (untransformed content box, the axis-aligned bounding box
      of its transformed content rectangle, and that rectangle's corners)
      and its PAINTED extents: the visible-ink (alpha > 0) bounding box —
      image transparent padding is excluded from painted but kept in
      content, text painted bounds are tight glyph ink rather than the
      line-box extent — plus the painted extent's intersection with the
      canvas and whether painted ink is clipped, judged against painted
      extents, never the layout box (no visible ink reports painted: null).
      Painted values are two-decimal rounded: ink is quantized to the
      capture window's pixel grid, while canvas offsets are layout-derived
      and may be fractional. Capture is bounded — one windowed screenshot
      per Layer (never scaled by off-canvas distance), and a Layer whose
      layout box exceeds the 8192×8192px window is refused with an
      actionable error instead of growing memory. Painted bounds are the
      browser's own paint of the exact markup rendering uses, so
      measurement and rendering agree; opacity scaling
      changes alpha values, never the ink footprint, and effects beyond
      opacity are separate functionality. Text dimensions are measured with
      the Layer's retained font bytes — the same face painting uses, never
      a second measuring authority; corrupt content or an unresolved font
      fails instead of producing misleading numbers. Writes nothing to the
      Project.

  bun run ply composition render <name> [options]
      Render a Composition to a PNG at its exact canvas dimensions and
      capture a retained Render manifest under the Project's renders/
      (default: a fresh file under renders/; --out exports the PNG elsewhere,
      history is always kept in renders/)

  bun run ply composition replay <manifest-path> [options]
      Replay a retained Render manifest: regenerate the Render's pixels
      byte-identically from its pinned historical inputs, independent of
      current Layer revisions and Composition documents. Requires the exact
      rendering environment that captured the manifest (tool, runtime,
      platform, browser); an unsupported environment fails before any output.
      Works after Project relocation, without the original source files, and
      without the original PNG

  bun run ply composition list [options]
      List all Compositions in the Project

Options:
  --project, -p <dir>   Path to Project root (default: current working directory)
  --width <int>         Canvas width in pixels (required for create)
  --height <int>        Canvas height in pixels (required for create)
  --image <path>        Path to local source image file (required for add
                        unless --text or --from-generation is used)
  --from-generation <jobId>
                        Add the selected output of a published Generation Job
                        (see ply generate) as an ordinary image Layer. The
                        job's provenance is retained inside the Project and
                        resolvable offline. Mutually exclusive with --image
                        and --text. The output is selected explicitly with
                        --output; a multi-output job without it is refused.
  --from-matte <matteId>
                        Add the verified output of a published matte (see ply
                        matte) as an ordinary image Layer. The matte's
                        provenance is retained inside the Project and
                        resolvable offline; when the matte's source was a
                        generated output, that job's provenance is retained
                        too. Mutually exclusive with --image, --text, and
                        --from-generation.
  --output <n|sha256>   Which output of the --from-generation job to ingest:
                        a 1-based index or the full sha-256 content identity.
  --text <str>          Text content for a text Layer (mutually exclusive
                        with --image; requires --font)
  --font <family>       Bundled font family name (required with --text;
                        e.g. Anton, "Source Sans 3", "Archivo Black")
  --font-size <num>     Font size in px for text Layers (default: 48)
  --color <hex>         Text color as #RGB or #RRGGBB (default: #ffffff)
  --order <names>       Comma-separated permutation of use names (required for reorder)
  --out <path>          Export path for a render or replay; fresh in-Project
                        paths with an existing parent (except reserved storage)
                        or any path outside the Project (existing Project
                        state is never exported over). Render history always
                        stays under the Project's renders/
  --x <num>             X position on canvas (default: 0)
  --y <num>             Y position on canvas (default: 0)
  --opacity <num>       Layer opacity between 0 and 1 (default: 1)
  --from-project <dir>  Import source: copy Layers from a Composition in
                        another Project (default: same-Project import)
  --json                Emit machine-readable JSON output on stdout
  --help, -h            Show this help message
`;

function output(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string },
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

const rawArgs = process.argv.slice(2);
const isJson = rawArgs.includes("--json");

let values: {
  project?: string;
  width?: string;
  height?: string;
  image?: string;
  text?: string;
  font?: string;
  "font-size"?: string;
  color?: string;
  order?: string;
  out?: string;
  "from-project"?: string;
  "from-generation"?: string;
  "from-matte"?: string;
  output?: string;
  x?: string;
  y?: string;
  opacity?: string;
  json?: boolean;
  help?: boolean;
};
let positionals: string[];

try {
  const parsed = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      width: { type: "string" },
      height: { type: "string" },
      image: { type: "string" },
      text: { type: "string" },
      font: { type: "string" },
      "font-size": { type: "string" },
      color: { type: "string" },
      order: { type: "string" },
      out: { type: "string" },
      "from-project": { type: "string" },
      "from-generation": { type: "string" },
      "from-matte": { type: "string" },
      output: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      opacity: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  output({ ok: false, error: (err as Error).message }, isJson);
  process.exit(2);
}

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
const targetProj = values.project ?? process.cwd();

async function run() {
  let mutationCommitted = false;
  // Exact published outcome for teardown-failure reporting (render only).
  let teardownOutcome: string | undefined;
  try {
    if (command === "create") {
      const name = positionals[1];
      if (!name) {
        output({ ok: false, error: "Usage: ply composition create <name> --width <w> --height <h>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!values.width || !values.height) {
        output(
          { ok: false, error: "Explicit canvas dimensions (--width and --height) are required to create a Composition." },
          isJson,
        );
        process.exitCode = 2;
        return;
      }
      const width = parseNumericArgument(values.width);
      const height = parseNumericArgument(values.height);
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        output({ ok: false, error: "Canvas width and height must be positive integers." }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const composition = await createComposition(targetProj, name, { width, height });
        mutationCommitted = true;
        output(
          { ok: true, composition },
          isJson,
          () => {
            console.log(`Created Composition "${composition.name}" (${composition.canvas.width}×${composition.canvas.height})`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "add") {
      const compName = positionals[1];
      const localName = positionals[2];
      if (!compName || !localName) {
        output({ ok: false, error: "Usage: ply composition add <composition> <local-name> (--image <path> | --text <str> --font <family> | --from-generation <jobId> | --from-matte <matteId>)" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.image && (values.text !== undefined || values.font !== undefined || values["font-size"] !== undefined || values.color !== undefined)) {
        output({ ok: false, error: "--image and --text are mutually exclusive content kinds; use one per Layer." }, isJson);
        process.exitCode = 2;
        return;
      }
      // Generated-content ingestion (#107): --from-generation is a third,
      // mutually exclusive content kind; --output selects one output of the
      // referenced Generation Job and is meaningless without it.
      if (values["from-generation"] !== undefined && (values.image !== undefined || values.text !== undefined || values.font !== undefined || values["font-size"] !== undefined || values.color !== undefined)) {
        output({ ok: false, error: "--from-generation and --image/--text options are mutually exclusive content kinds; use one per Layer." }, isJson);
        process.exitCode = 2;
        return;
      }
      // Matting-content ingestion (#108): --from-matte is a fourth, mutually
      // exclusive content kind.
      if (values["from-matte"] !== undefined && (values.image !== undefined || values.text !== undefined || values.font !== undefined || values["font-size"] !== undefined || values.color !== undefined || values["from-generation"] !== undefined)) {
        output({ ok: false, error: "--from-matte and --image/--text/--from-generation options are mutually exclusive content kinds; use one per Layer." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values["from-matte"] !== undefined && !values["from-matte"].trim()) {
        output({ ok: false, error: "--from-matte takes a matte id (see ply matte)." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.output !== undefined && values["from-generation"] === undefined) {
        output({ ok: false, error: "--output is only valid together with --from-generation <jobId>." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values["from-generation"] !== undefined && !values["from-generation"].trim()) {
        output({ ok: false, error: "--from-generation takes a Generation Job id (see ply generate list)." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.output !== undefined && !/^([1-9]\d*|[0-9a-f]{64})$/.test(values.output)) {
        output({ ok: false, error: `--output takes a 1-based output index or the full sha-256 output identity (got "${values.output}")` }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.text === undefined && (values.font !== undefined || values["font-size"] !== undefined || values.color !== undefined)) {
        output({ ok: false, error: "--font, --font-size, and --color require --text <str>." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!values.image && values.text === undefined && values["from-generation"] === undefined && values["from-matte"] === undefined) {
        output({ ok: false, error: "Missing required content: --image <path>, --text <str> (with --font <family>), --from-generation <jobId>, or --from-matte <matteId>" }, isJson);
        process.exitCode = 2;
        return;
      }

      const x = values.x !== undefined ? parseNumericArgument(values.x) : 0;
      const y = values.y !== undefined ? parseNumericArgument(values.y) : 0;
      const opacity = values.opacity !== undefined ? parseNumericArgument(values.opacity) : 1.0;

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        output({ ok: false, error: "Placement coordinates (--x, --y) must be finite numbers." }, isJson);
        process.exitCode = 2;
        return;
      }
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        output({ ok: false, error: "Opacity (--opacity) must be a finite number between 0 and 1." }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        if (values["from-generation"] !== undefined) {
          const res = await addGeneratedLayerToComposition(
            targetProj, compName, localName,
            { jobRoot: path.resolve("out", "generation"), jobId: values["from-generation"].trim(), output: values.output },
            { x, y, opacity },
          );
          mutationCommitted = true;
          output(
            { ok: true, composition: res.composition, use: res.use, layer: res.layer, generatedFrom: res.generatedFrom },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : `${rev.width}×${rev.height} ${rev.format}`;
              console.log(
                `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${detail}] from Generation Job ${res.generatedFrom.jobId} ` +
                  `(${res.generatedFrom.contentHash.slice(0, 12)}; provenance retained)`,
              );
            },
          );
          return;
        }
        if (values["from-matte"] !== undefined) {
          const res = await addMattedLayerToComposition(
            targetProj, compName, localName,
            {
              matteRoot: path.resolve("out", "matting"),
              matteId: values["from-matte"].trim(),
              generationRoot: path.resolve("out", "generation"),
            },
            { x, y, opacity },
          );
          mutationCommitted = true;
          output(
            {
              ok: true,
              composition: res.composition,
              use: res.use,
              layer: res.layer,
              mattedFrom: res.mattedFrom,
              ...(res.generatedFrom ? { generatedFrom: res.generatedFrom } : {}),
            },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : `${rev.width}×${rev.height} ${rev.format}`;
              const generated = res.generatedFrom
                ? `; generation lineage from Generation Job ${res.generatedFrom.jobId} retained`
                : "";
              console.log(
                `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${detail}] from matte ${res.mattedFrom.matteId} ` +
                  `(engine ${res.mattedFrom.engine}, ${res.mattedFrom.contentHash.slice(0, 12)}; provenance retained${generated})`,
              );
            },
          );
          return;
        }
        if (values.text !== undefined) {
          if (!values.font) {
            output({ ok: false, error: "Missing required option: --font <family> (required with --text)" }, isJson);
            process.exitCode = 2;
            return;
          }
          const fontSize = values["font-size"] !== undefined ? parseNumericArgument(values["font-size"]) : 48;
          if (!Number.isFinite(fontSize)) {
            output({ ok: false, error: "Font size (--font-size) must be a finite number." }, isJson);
            process.exitCode = 2;
            return;
          }
          const res = await addTextLayerToComposition(
            targetProj, compName, localName,
            { text: values.text, font: values.font, color: values.color },
            { x, y, opacity, fontSize },
          );
          mutationCommitted = true;
          output(
            { ok: true, composition: res.composition, use: res.use, layer: res.layer },
            isJson,
            () => {
              const rev = res.layer.currentRevision;
              if (rev.kind !== "text") return; // unreachable: text ingestion returns a text revision
              console.log(
                `Added text Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" ` +
                  `[${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}]`,
              );
            },
          );
          return;
        }

        const res = await addLayerToComposition(targetProj, compName, localName, values.image!, { x, y, opacity });
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, use: res.use, layer: res.layer },
          isJson,
          () => {
            const rev = res.layer.currentRevision;
            const detail =
              rev.kind === "text"
                ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                : `${rev.width}×${rev.height} ${rev.format}`;
            console.log(
              `Added Layer "${res.use.name}" (${res.use.layerId}) to Composition "${res.composition}" [${detail}]`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "import") {
      const targetComp = positionals[1];
      const sourceComp = positionals[2];
      if (!targetComp || !sourceComp) {
        output({ ok: false, error: "Usage: ply composition import <target> <source>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const fromProject = values["from-project"];
        const res =
          fromProject !== undefined
            ? await importCompositionCrossProject(targetProj, targetComp, sourceComp, fromProject)
            : await importComposition(targetProj, targetComp, sourceComp);
        mutationCommitted = true;
        output(
          {
            ok: true,
            composition: res.composition,
            sourceComposition: res.sourceComposition,
            importedUses: res.importedUses,
            layers: res.layers,
          },
          isJson,
          () => {
            const count = res.importedUses.length;
            const noun = count === 1 ? "Layer" : "Layers";
            console.log(
              `Imported ${count} ${noun} from "${res.sourceComposition}" into Composition "${res.composition}" (total: ${res.layers.length} layers)`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "remove") {
      const compName = positionals[1];
      const localName = positionals[2];
      if (!compName || !localName) {
        output({ ok: false, error: "Usage: ply composition remove <composition> <use-name>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const res = await removeLayerFromComposition(targetProj, compName, localName);
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, removedUse: res.removedUse, layers: res.layers },
          isJson,
          () => {
            console.log(
              `Removed Layer use "${res.removedUse.name}" (${res.removedUse.layerId}) from Composition "${res.composition}" (remaining: ${res.layers.length})`,
            );
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "reorder") {
      const compName = positionals[1];
      if (!compName) {
        output({ ok: false, error: "Usage: ply composition reorder <composition> --order <name1,name2,...>" }, isJson);
        process.exitCode = 2;
        return;
      }
      if (values.order === undefined) {
        output({ ok: false, error: "Missing required option: --order <name1,name2,...>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const res = await reorderCompositionLayers(targetProj, compName, values.order);
        mutationCommitted = true;
        output(
          { ok: true, composition: res.composition, layers: res.layers },
          isJson,
          () => {
            const names = res.layers.length === 0 ? "(empty)" : res.layers.map((l) => l.name).join(", ");
            console.log(`Reordered Composition "${res.composition}" (order: ${names})`);
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "inspect") {
      const name = positionals[1];
      if (!name) {
        output({ ok: false, error: "Usage: ply composition inspect <name>" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const composition = await inspectComposition(targetProj, name);
        output(
          { ok: true, composition },
          isJson,
          () => {
            console.log(`Composition: ${composition.name} (${composition.canvas.width}×${composition.canvas.height})`);
            console.log(`Layers (${composition.layers.length}):`);
            composition.layers.forEach((layer, idx) => {
              const rev = layer.revision;
              const detail =
                rev.kind === "text"
                  ? `${JSON.stringify(rev.text)} ${rev.fontSize}px ${rev.color}`
                  : `${rev.width}×${rev.height} ${rev.format}`;
              console.log(
                `  ${idx + 1}. "${layer.name}" [${layer.layerId}] (${rev.kind}, ${detail}) ` +
                  `@ (${rev.x}, ${rev.y}) opacity: ${rev.opacity}`,
              );
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "measure") {
      const compName = positionals[1];
      const useName = positionals[2];
      if (!compName) {
        output({ ok: false, error: "Usage: ply composition measure <composition> [use-name]" }, isJson);
        process.exitCode = 2;
        return;
      }

      try {
        const result = await measureCompositionLayers(targetProj, compName, useName);
        output(
          { ok: true, composition: result.composition, canvas: result.canvas, layers: result.layers },
          isJson,
          () => {
            console.log(`Measured Composition "${result.composition}" (${result.canvas.width}×${result.canvas.height}), ${result.layers.length} Layer${result.layers.length === 1 ? "" : "s"} (layout boxes + painted extents):`);
            result.layers.forEach((layer, idx) => {
              const t = layer.transform;
              const facts: string[] = [];
              if (t.scaleX !== 1 || t.scaleY !== 1) {
                facts.push(`scale ${t.scaleX === t.scaleY ? `${t.scaleX}×` : `${t.scaleX}×/${t.scaleY}×`}`);
              }
              if (t.rotationDeg !== 0) facts.push(`rot ${t.rotationDeg}°`);
              if (t.flipX || t.flipY) {
                facts.push(`flip ${t.flipX && t.flipY ? "both" : t.flipX ? "horizontal" : "vertical"}`);
              }
              console.log(
                `  ${idx + 1}. "${layer.name}" (${contentLabel(layer)}) box (${layer.box.x}, ${layer.box.y}) ${layer.box.width}×${layer.box.height} ${paintedText(layer)}` +
                  (facts.length > 0 ? ` [${facts.join(", ")}]` : ""),
              );
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "render") {
      const name = positionals[1];
      if (!name) {
        emitRender({ ok: false, error: "Usage: ply composition render <name> [--out <path>]" }, isJson);
        process.exitCode = 2;
        return;
      }
      try {
        const render = await renderComposition(targetProj, name, { out: values.out });
        // The output is on disk before the browser teardown runs; if teardown
        // fails, the caller must hear exactly that.
        teardownOutcome = `The rendered PNG was already written to ${render.output}. Do not re-render to recover it.`;
        emitRender(
          { ok: true, render },
          isJson,
          () => {
            console.log(`Rendered Composition "${render.name}" at ${render.width}\u00d7${render.height} \u2192 ${render.output} (manifest: ${render.manifest})`);
          },
        );
      } catch (err) {
        teardownOutcome = "No rendered PNG was written; no output was published.";
        emitRender({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "replay") {
      const manifestPath = positionals[1];
      if (!manifestPath) {
        emitRender({ ok: false, error: "Usage: ply composition replay <manifest-path> [--out <path>]" }, isJson);
        process.exitCode = 2;
        return;
      }
      try {
        const replay = await replayRender(targetProj, manifestPath, { out: values.out });
        // The output is on disk before the browser teardown runs; if teardown
        // fails, the caller must hear exactly that.
        teardownOutcome = `The replayed PNG was already written to ${replay.output}. Do not re-replay to recover it.`;
        emitRender(
          { ok: true, replay },
          isJson,
          () => {
            console.log(
              `Replayed Composition "${replay.name}" from its retained history \u2192 ${replay.output} (manifest: ${replay.manifest})`,
            );
          },
        );
      } catch (err) {
        teardownOutcome = "No replayed PNG was written; no output was published.";
        emitRender({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else if (command === "list") {
      try {
        const compositions = await listCompositions(targetProj);
        output(
          { ok: true, compositions },
          isJson,
          () => {
            console.log(`Compositions (${compositions.length}):`);
            compositions.forEach((c) => {
              console.log(`  - ${c.name} (${c.canvas.width}×${c.canvas.height}, ${c.layers.length} layers)`);
            });
          },
        );
      } catch (err) {
        output({ ok: false, error: (err as Error).message }, isJson);
        process.exitCode = 1;
      }
    } else {
      const msg = `Unknown command "${command}". Available commands: create, add, import, remove, reorder, inspect, measure, render, replay, list. See ply composition --help.`;
      output({ ok: false, error: msg }, isJson);
      process.exitCode = 2;
    }
  } finally {
    await closeCliBrowser(mutationCommitted, teardownOutcome);
  }
}

await run();

/**
 * Render output emission: JSON (success and failure) always goes to stdout
 * so callers can parse it regardless of exit status; the compact default
 * prints one actionable success line on stdout and failures on stderr.
 */
function emitRender(
  result: { ok: true; [key: string]: unknown } | { ok: false; error: string },
  isJson: boolean,
  textFormatter?: () => void,
): void {
  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    textFormatter?.();
  } else {
    console.error(`Error: ${result.error}`);
  }
}

/** Blank supplied values are invalid, never implicit zero. */
function parseNumericArgument(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN;
}

/** Compact content description for a measured Layer. */
function contentLabel(layer: { kind: string; content: { width: number; height: number } }): string {
  return layer.kind === "text" ? `text ${layer.content.width}×${layer.content.height}` : `image content ${layer.content.width}×${layer.content.height}`;
}

/**
 * Compact painted-extent segment for a measured Layer: the unclipped ink
 * box, plus the on-canvas intersection only when ink is clipped, or the
 * explicit no-visible-ink wording when there is nothing painted.
 */
function paintedText(layer: Pick<MeasuredLayerBounds, "painted" | "paintedOnCanvas" | "clipped">): string {
  if (!layer.painted) return "painted: none (no visible ink)";
  const p = layer.painted;
  let segment = `painted (${p.x}, ${p.y}) ${p.width}×${p.height}`;
  if (layer.clipped) {
    // Ink can be clipped with an empty on-canvas footprint — entirely
    // outside the canvas — so the intersection may be null.
    const v = layer.paintedOnCanvas;
    segment += v
      ? `, on-canvas (${v.x}, ${v.y}) ${v.width}×${v.height} — clipped`
      : " — clipped (entirely off-canvas)";
  }
  return segment;
}
