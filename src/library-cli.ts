#!/usr/bin/env bun
// The asset library CLI: search and maintain the reusable plates and logos.
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { wantsJson, usageMessage } from "./cli-present.js";
import {
  LIBRARY_ROOT,
  scanLibrary,
  searchLibrary,
  resolveAsset,
  writeMaskAsset,
  approveCutout,
  type Library,
  type CutoutMeta,
} from "./assets.js";

const HELP = `
library — the reusable asset library (plates + logos + cutouts + objects + masks)

  ply library list [query] [options]      Search the library. Empty query lists all.
  ply library resolve <ref> [options]     Resolve an asset reference to its exact content identity.
  ply library add-logo <file> --id <id>   Add a logo image to the library.
  ply library add-cutout <file> --id <id> Add a transparent-PNG cutout.
  ply library add-mask <file> --id <id>   Add a named-mask PNG (alpha selects).
  ply library approve <id> [options]      Promote a trial Creator Asset to approved —
                                          the only promotion path (REQ-018).

Object and plate adoption is retired (spec #102, #115): generated or matted
content enters Projects as ordinary Layers — "ply composition add <comp>
<name> --from-generation <jobId>" or "--from-matte <matteId>" — not the asset
library. Existing plates and objects remain listable, resolvable, and
renderable.

Asset references name exact content and work the same for library and
project-local assets: "<id>" or "library:<id>" resolves a library asset
(logos answer to aliases); "<project-relative path>" resolves a file in a
project. Add "@<sha-256-or-prefix>" to pin exact bytes — if the content
changes, pinned references fail loudly instead of silently changing.

Generation references are arbitrary local image files supplied directly to
"ply generate" with repeatable "--ref <path>" arguments, in the order given.
They are not library entries and carry no roles or mandatory identity
(ADR-0014).

Options
  --name <str>     Display name (defaults to the id)
  --tags <csv>     Comma-separated descriptive tags
  --color <hex>    Logo: default mark colour when recolourable
  --alias <csv>    Logo: extra ids it answers to, e.g. "chatgpt,gpt"
  --source <url>   Logo/cutout: where it came from (URL + date)
  --approval <s>   Cutout: trial | approved  (default: trial). "approved"
                   here imports an externally approved source (--source
                   required) — promoting an existing trial Creator Asset
                   is "library approve <id>", never this flag.
  --approver <s>   approve: who approved (default: git config user.name)
  --note <str>     approve: optional approval rationale
  --derived-from <path>  Cutout: the approved original this was edited from
  --edit-prompt <str>    Cutout: the edit instruction that produced it
  --sheet          list only: also write assets/index.html contact sheet
  --project <dir>  resolve only: project root for project-local refs (default: cwd)
  --json           Emit one valid JSON result on stdout (default: compact text)
  --help, -h       Show this help

Library lives at ${LIBRARY_ROOT}. One directory per asset:
logos/<id>/ holds logo.svg|png + meta.json; plates/<id>/ holds plate.png +
meta.json; cutouts/<id>/ holds cutout.png + meta.json; objects/<id>/ holds
object.png + meta.json; masks/<id>/ holds mask.png + meta.json.
`;

const isJson = wantsJson(process.argv.slice(2));

/** Usage-shaped failure: the caller's arguments are wrong — exit 2. */
function usageExit(message: string): never {
  if (isJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(usageMessage(message, "library"));
  process.exit(2);
}

/** Operational failure: the arguments are valid but the operation failed — exit 1. */
function fail(msg: string): never {
  if (isJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const parse = () =>
  parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      tags: { type: "string", default: "" },
      color: { type: "string" },
      alias: { type: "string", default: "" },
      source: { type: "string" },
      approval: { type: "string" },
      "derived-from": { type: "string" },
      "edit-prompt": { type: "string" },
      approver: { type: "string" },
      note: { type: "string" },
      project: { type: "string" },
      sheet: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

let values: {
  id?: string;
  name?: string;
  tags?: string;
  color?: string;
  alias?: string;
  source?: string;
  approval?: string;
  "derived-from"?: string;
  "edit-prompt"?: string;
  approver?: string;
  note?: string;
  project?: string;
  sheet?: boolean;
  json?: boolean;
  help?: boolean;
};
let positionals: string[];
try {
  ({ values, positionals } = parse());
} catch (err) {
  // An unparseable argument vector is a usage error, never a stack trace (#128, F13).
  usageExit((err as Error).message);
}

if (values.help || positionals.length === 0) {
  if (isJson) console.log(JSON.stringify({ ok: true, help: HELP.trim() }, null, 2));
  else console.log(HELP);
  process.exit(0);
}
if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
if (!["list", "resolve", "add-logo", "add-cutout", "add-mask", "approve"].includes(command)) {
  usageExit(`Unknown command "${command}". Options: list | resolve | add-logo | add-cutout | add-mask | approve`);
}
const csv = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
function requireId(): string {
  const id = values.id;
  if (!id) usageExit(`--id is required for "${command}"`);
  if (!idPattern.test(id))
    usageExit(`--id must be lowercase letters/digits/hyphens (got "${id}")`);
  return id;
}

async function scanOrDie(): Promise<Library> {
  try {
    return await scanLibrary(LIBRARY_ROOT);
  } catch (err) {
    fail((err as Error).message);
  }
}

/** Write an HTML contact sheet of everything in the library. */
async function writeSheet(lib: Library) {
  if (
    lib.logos.length === 0 &&
    lib.plates.length === 0 &&
    lib.cutouts.length === 0 &&
    lib.objects.length === 0 &&
    lib.masks.length === 0
  )
    return;
  const figure = (kind: string, id: string, file: string, caption: string) =>
    `<figure><a href="file://${path.join(LIBRARY_ROOT, kind, id, file)}"><img class="${kind === "plates" ? "plate-img" : kind === "cutouts" || kind === "objects" ? "cutout-img" : ""}" src="file://${path.join(LIBRARY_ROOT, kind, id, file)}"></a><figcaption>${caption}</figcaption></figure>`;
  const section = (
    title: string,
    html: string,
    emptyNote: string,
  ) =>
    `<h2>${title}</h2><div class="g">${
      html || `<p class="empty">${emptyNote}</p>`
    }</div>`;
  const html = `<!doctype html><meta charset="utf-8"><title>library</title>
<style>
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.g{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px;min-height:200px;justify-content:center}
img{max-width:96px;max-height:96px;border-radius:4px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
img.plate-img{max-width:100%;max-height:none;width:100%}
img.cutout-img{max-width:180px;max-height:180px;object-fit:contain}
.empty{color:#5c5c64;font-size:12px;margin:8px 4px}
</style><h1>Asset library · ${lib.logos.length + lib.plates.length + lib.cutouts.length + lib.objects.length + lib.masks.length}</h1>
${section(
  "logos",
  lib.logos
    .map((l) =>
      figure(
        "logos",
        l.meta.id,
        path.basename(l.imagePath),
        `${l.meta.id} [${l.meta.tags.join(", ")}]`,
      ),
    )
    .join("\n"),
  "(none)",
)}
${section(
  "plates",
  lib.plates
    .map((p) =>
      figure("plates", p.meta.id, path.basename(p.imagePath), `${p.meta.id} [${p.meta.tags.join(", ")}]`),
    )
    .join("\n"),
  "(none — generated content enters Projects as Layers, not the library)",
)}
${section(
  "objects",
  lib.objects
    .map((o) =>
      figure("objects", o.meta.id, path.basename(o.imagePath), `${o.meta.id} [${o.meta.tags.join(", ")}] ${o.meta.matting}`),
    )
    .join("\n"),
  "(none — object adoption is retired; existing objects remain usable)",
)}
${section(
  "cutouts",
  lib.cutouts
    .map((c) =>
      figure("cutouts", c.meta.id, path.basename(c.imagePath), `${c.meta.id} [${c.meta.tags.join(", ")}] ${c.meta.approval}`),
    )
    .join("\n"),
  "(none — add one with ply add-cutout <cutout.png> --id <name>)",
)}
${section(
  "masks",
  lib.masks
    .map((m) =>
      figure("masks", m.meta.id, path.basename(m.imagePath), `${m.meta.id} [${m.meta.tags.join(", ")}]`),
    )
    .join("\n"),
  "(none — add one with ply add-mask <mask.png> --id <name>)",
)}
</body>`;
  await writeFile(path.join(LIBRARY_ROOT, "index.html"), html);
}

if (command === "list") {
  const lib = await scanOrDie();
  const query = positionals.slice(1).join(" ");
  let found: Library;
  try {
    found = await searchLibrary(lib, query);
  } catch (err) {
    fail((err as Error).message);
  }

  if (values.sheet) await writeSheet(found);

  const jsonPayload = {
    ok: true,
    logos: found.logos.map((l) => ({
      id: l.meta.id,
      name: l.meta.name,
      tags: l.meta.tags,
      ...(l.meta.defaultColor ? { defaultColor: l.meta.defaultColor } : {}),
      ...(l.meta.aliases?.length ? { aliases: l.meta.aliases } : {}),
      hash: l.hash,
    })),
    plates: found.plates.map((p) => ({
      id: p.meta.id,
      tags: p.meta.tags,
      ...(p.meta.subject ? { subject: p.meta.subject } : {}),
      hash: p.hash,
    })),
    cutouts: found.cutouts.map((c) => ({
      id: c.meta.id,
      tags: c.meta.tags,
      approval: c.meta.approval,
      hash: c.hash,
    })),
    objects: found.objects.map((o) => ({
      id: o.meta.id,
      tags: o.meta.tags,
      ...(o.meta.matting ? { matting: o.meta.matting } : {}),
      hash: o.hash,
    })),
    masks: found.masks.map((m) => ({ id: m.meta.id, tags: m.meta.tags, hash: m.hash })),
  };
  if (isJson) {
    console.log(JSON.stringify(jsonPayload, null, 2));
    process.exit(0);
  }

  console.log(`\n  Logos (${found.logos.length})`);
  if (found.logos.length === 0) console.log(`    (none)`);
  for (const l of found.logos) {
    const color = l.meta.defaultColor ? `  ${l.meta.defaultColor}` : "";
    const aliases = l.meta.aliases?.length ? `  aka ${l.meta.aliases.join(", ")}` : "";
    console.log(`    ${l.meta.id.padEnd(22)} ${l.meta.name.padEnd(18)} [${l.meta.tags.join(", ")}]${color}${aliases}  @${l.hash.slice(0, 12)}`);
  }
  console.log(`\n  Plates (${found.plates.length})`);
  if (found.plates.length === 0) console.log(`    (none — generated content enters Projects as Layers, not the library)`);
  for (const p of found.plates) {
    const subject = p.meta.subject ? `  "${p.meta.subject.slice(0, 60)}${p.meta.subject.length > 60 ? "…" : ""}"` : "";
    console.log(`    ${p.meta.id.padEnd(22)} [${p.meta.tags.join(", ")}]${subject}  @${p.hash.slice(0, 12)}`);
  }
  console.log(`\n  Cutouts (${found.cutouts.length})`);
  if (found.cutouts.length === 0) console.log(`    (none — add one with: ply library add-cutout <cutout.png> --id <name> --tags <role facets>)`);
  for (const c of found.cutouts) {
    console.log(
      `    ${c.meta.id.padEnd(22)} [${c.meta.tags.join(", ")}]  ${c.meta.approval}  @${c.hash.slice(0, 12)}`,
    );
  }
  console.log(`\n  Objects (${found.objects.length})`);
  if (found.objects.length === 0) console.log(`    (none — object adoption is retired; existing objects remain usable)`);
  for (const o of found.objects) {
    console.log(`    ${o.meta.id.padEnd(22)} [${o.meta.tags.join(", ")}]${o.meta.matting ? `  ${o.meta.matting}` : ""}  @${o.hash.slice(0, 12)}`);
  }
  console.log(`\n  Masks (${found.masks.length})`);
  if (found.masks.length === 0) console.log(`    (none — add one with: ply library add-mask <mask.png> --id <name>)`);
  for (const m of found.masks) {
    console.log(`    ${m.meta.id.padEnd(22)} [${m.meta.tags.join(", ")}]  @${m.hash.slice(0, 12)}`);
  }
  if (
    values.sheet &&
    (found.logos.length || found.plates.length || found.cutouts.length || found.objects.length || found.masks.length)
  )
    console.log(`\n  sheet    ${path.relative(process.cwd(), path.join(LIBRARY_ROOT, "index.html"))}`);
  console.log("");
  process.exit(0);
}

if (command === "resolve") {
  const lib = await scanOrDie();
  const ref = positionals[1];
  if (!ref)
    usageExit(
      `resolve needs an asset reference — an id (optionally "<id>@<hash>"), "library:<id>@<hash>", or a project-relative path`,
    );
  const projectRoot = values.project ? path.resolve(values.project!) : process.cwd();
  try {
    const asset = await resolveAsset(projectRoot, lib, ref);
    const identity = asset.id ?? asset.path!;
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            scope: asset.scope,
            identity: `${identity}@${asset.hash}`,
            kind: asset.kind ?? "file",
            mediaType: asset.mediaType,
            bytes: asset.bytes.byteLength,
            hash: `sha-256:${asset.hash}`,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `\n  scope      ${asset.scope}` +
          `\n  identity   ${identity}@${asset.hash}` +
          `\n  kind       ${asset.kind ?? "(file)"}` +
          `\n  media      ${asset.mediaType}` +
          `\n  bytes      ${asset.bytes.byteLength}` +
          `\n  hash       sha-256:${asset.hash}\n`,
      );
    }
  } catch (err) {
    fail((err as Error).message);
  }
  process.exit(0);
}

if (command === "approve") {
  // The one promotion path trial → approved (REQ-018). `add-cutout --approval
  // approved --source` imports an externally approved source; it is not a
  // promotion. This command promotes an existing trial Creator Asset.
  const id = positionals[1];
  if (!id) usageExit(`approve needs the Creator Asset id — "ply library approve <id>"`);
  const approver =
    values.approver ??
    (() => {
      try {
        return execSync("git config user.name", { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
  if (!approver) usageExit(`--approver is required (or set git config user.name)`);
  try {
    const meta = await approveCutout(LIBRARY_ROOT, id, {
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
      ...(values.note ? { approvalNote: values.note } : {}),
    });
    const lib = await scanOrDie();
    const entry = lib.cutouts.find((c) => c.meta.id === id);
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            id,
            approval: "approved",
            approvedBy: meta.approvedBy,
            approvedAt: meta.approvedAt,
            ...(meta.approvalNote ? { approvalNote: meta.approvalNote } : {}),
            ...(entry ? { hash: entry.hash } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `  approve  ${id} → approved` +
          `
  by       ${meta.approvedBy} at ${meta.approvedAt}` +
          (meta.approvalNote ? `
  note     ${meta.approvalNote}` : "") +
          (entry ? `
  identity ${id}@${entry.hash}` : "") +
          "\n",
      );
    }
  } catch (err) {
    fail((err as Error).message);
  }
  process.exit(0);
}

const KIND_OF: Record<string, "logos" | "plates" | "cutouts" | "masks"> = {
  "add-logo": "logos",
  "add-cutout": "cutouts",
  "add-mask": "masks",
};
const id = requireId();
const dir = path.join(LIBRARY_ROOT, KIND_OF[command]!, id);
const existing = await scanOrDie();
if (
  existing.logos.some((l) => l.meta.id === id) ||
  existing.plates.some((p) => p.meta.id === id) ||
  existing.cutouts.some((c) => c.meta.id === id) ||
  existing.masks.some((m) => m.meta.id === id)
) {
  fail(`"${id}" already exists in the library.`);
}

// add-mask writes through writeMaskAsset, which creates its asset directory
// exclusively; add-logo / add-cutout still own their directory creation here.
if (command !== "add-mask") await mkdir(dir, { recursive: true });
try {
  if (command === "add-logo") {
    const src = path.resolve(positionals[1] ?? "");
    if (!src || !/\.(svg|png|jpe?g|webp)$/i.test(src)) usageExit("add-logo needs a logo image file");
    const destFile = path.join(dir, `${id}${path.extname(src).toLowerCase()}`);
    if (destFile.endsWith(".svg")) {
      // Normalize on the way in: drop fixed sizing hints so every viewer
      // (VS Code, Finder) sizes from the viewBox, like the composer does.
      const raw = await readFile(src, "utf8");
      const normalized = raw
        .replace(/<\?xml[^>]*\?>/g, "")
        .replace(/\s(width|height|style)="[^"]*"/g, "");
      await writeFile(destFile, normalized.trimStart());
    } else {
      await copyFile(src, destFile);
    }
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          kind: "logo",
          id,
          name: values.name ?? values.id!,
          tags: csv(values.tags!),
          ...(values.color ? { defaultColor: values.color } : {}),
          ...((csv(values.alias!) || []).length ? { aliases: csv(values.alias!) } : {}),
          ...(values.source ? { source: values.source } : {}),
        },
        null,
        2,
      ),
    );
    if (isJson) console.log(JSON.stringify({ ok: true, kind: "logo", id, path: destFile }, null, 2));
    else console.log(`  logo     ${id} → ${path.relative(process.cwd(), destFile)}`);
  } else if (command === "add-mask") {
    // Add a named mask (REQ-019): a PNG whose alpha selects pixels of the
    // Creator Asset that references it. Written through writeMaskAsset —
    // exclusive create, cross-kind id, hardcoded mask.png name.
    const src = path.resolve(positionals[1] ?? "");
    if (!src || !/\.png$/i.test(src)) usageExit("add-mask needs a PNG mask (its alpha selects)");
    const imagePath = await writeMaskAsset(LIBRARY_ROOT, id, new Uint8Array(await readFile(src)), {
      kind: "mask",
      id,
      name: values.name ?? values.id!,
      tags: csv(values.tags!),
    });
    if (isJson) console.log(JSON.stringify({ ok: true, kind: "mask", id, path: imagePath }, null, 2));
    else console.log(`  mask     ${id} → ${path.relative(process.cwd(), imagePath)}`);
  } else {
    // Add a cutout: a transparent PNG whose reuse value is its role — the
    // pose/expression/outfit facets its tags name.
    const src = path.resolve(positionals[1] ?? "");
    if (!src || !/\.(png)$/i.test(src)) usageExit("add-cutout needs a transparent PNG");
    const approval = (values.approval ?? "trial") as CutoutMeta["approval"];
    if (!["trial", "approved"].includes(approval)) usageExit(`--approval must be trial | approved`);
    if (approval === "approved" && !values.source)
      usageExit(`--approval approved needs --source pointing at its provenance record`);
    const destFile = path.join(dir, "cutout.png");
    await copyFile(src, destFile);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          kind: "cutout",
          id,
          name: values.name ?? values.id!,
          tags: csv(values.tags!),
          approval,
          ...(values.source ? { source: values.source } : {}),
          ...(values["derived-from"] ? { derivedFrom: path.resolve(values["derived-from"]!) } : {}),
          ...(values["edit-prompt"] ? { editPrompt: values["edit-prompt"] } : {}),
          adoptedFrom: src,
        } satisfies CutoutMeta,
        null,
        2,
      ),
    );
    if (isJson) console.log(JSON.stringify({ ok: true, kind: "cutout", id, path: destFile, approval }, null, 2));
    else console.log(`  cutout   ${id} → ${path.relative(process.cwd(), destFile)}  (${approval})`);
  }
} catch (err) {
  fail((err as Error).message);
}
