# Matting Publication Contract

This document defines the canonical publication contract for the independent
local Matting operation introduced by #106 (spec #102, DEC-004, ADR-0015).
Dependent tickets (#108 Project ingestion, #109 evidence inspection) consume
and adhere to this contract — no dependent delivery guesses a private schema.

The operation mattes one caller-selected local PNG with no Generation Job, no
library adoption, and no network. A source that already carries a real matte
is kept as-is with no inference (engine `native-alpha`); anything else runs
through the pinned local BiRefNet segmenter with engine preflight before
inference. The source bytes are only ever read — they are never replaced or
modified. Generation is never a prerequisite and this surface imports no
generation module (tripwire-tested).

## 1. Directory layout

Matting records live under `out/matting/` (overridable by the CLI's injected
root; the default is `<cwd>/out/matting`):

```
out/matting/<matteId>/
├── matte.json                # the record (schema below) — the commit point
└── outputs/                  # content-addressed matted bytes (sha-256)
    └── <sha256>.png
```

Matte ids match `^[a-z0-9][a-z0-9-]*$`; the auto id is
`matte-<yyyymmdd>-<8 hex>`. Creating over an existing matte id (`matte.json`
present) is refused — matting a new image records a new matte; nothing is ever
overwritten. A stale directory without `matte.json` (a hard crash) holds no
lineage and may be reclaimed by a retry of the same id.

## 2. Record schema (schemaVersion 1, kind "matting")

```json
{
  "schemaVersion": 1,
  "matteId": "matte-20260908-ab12cd34",
  "kind": "matting",
  "createdAt": "2026-09-08T12:00:00.000Z",
  "request": {
    "source": {
      "path": "caller-supplied path as written",
      "contentHash": "sha-256 derived once at the operation boundary"
    }
  },
  "result": {
    "engine": "native-alpha | local-segmentation:<weights filename>",
    "alpha": { "width": 1024, "height": 1024, "transparentPx": 402391, "opaquePx": 500001 },
    "warnings": [],
    "outputs": [
      { "contentHash": "<sha-256>", "file": "outputs/<sha256>.png", "mediaType": "image/png" }
    ]
  }
}
```

Facts and their one home:

- **The record is the single authoritative home for the Matting facts**: the
  source path as the caller wrote it and its content identity, the engine that
  produced the matte, the measured alpha report, warnings, and the published
  output. Dependent tickets read this record; no second copy of a fact is
  created.
- **`request.source.contentHash` is the source identity** derived once at the
  operation boundary from the exact bytes read. The source file is never
  modified — the source remains where the caller put it, and its identity
  lets #108 trace lineage even after the file moves.
- **`result.engine` records the engine**, `native-alpha` when the source's own
  alpha was the matte (no inference, and the published bytes are the exact
  source bytes — their content hash equals the source's), or the engine name
  the real segmenter records (`local-segmentation:birefnet-hr-fp16.onnx`).
- **The result passes the true-alpha gate before publication**: the alpha
  report in the record is measured by the same gate (`src/alpha.ts`) that
  adoption applies, run at the pass that produced the bytes. An unusable
  result (all-opaque or all-transparent) is refused there and never published.
- **Outputs are content-addressed** by sha-256 of the exact bytes on disk;
  `contentHash` is verifiable against the file at any time.
- **`engine.preflight` runs at this operation, before inference.** Missing or
  mismatched weights fail with the pinned filename, sha-256, and fetch/export
  command before anything is written.

## 3. Input contract

- **PNG only.** The local matting machinery (`src/png.ts`, `src/matte.ts`,
  `src/segment.ts`) is a PNG pipeline; non-PNG input is refused at the
  operation boundary with an actionable convert-locally diagnostic. JPEG/WebP
  matting is not invented here.
- Input is read exactly once; the identity is derived from that one read. The
  native-alpha check, the engine call, and the published bytes all come from
  those ingested bytes.
- **No Generation Job or adoption state is required or consulted.** A
  generated-output-shaped input (a file anywhere on disk, including a
  generation output directory) mattes exactly like an imported one; generation
  is never a prerequisite and is never invoked.

## 4. Publication discipline and failure boundary

- Output bytes are persisted first; `matte.json` is the commit point, written
  last. There is no moment where a record exists without its output.
- Any caught failure (invalid id, duplicate id, unreadable or non-PNG source,
  preflight refusal, unusable matte, write failure) removes the freshly
  created matte directory and reports `{ok: false}` with a nonzero exit — the
  source bytes are byte-identical, and nothing is left that reports success.
- Matting is local correctness machinery (ADR-0015): it never touches
  Projects or Layers, never calls the network, and never invokes generation.
  Ingestion of the published result into Projects is #108's ownership: it
  retains this record **verbatim** under the Project's `matting/<matteId>/`
  and derives the Layer linkage from the content identities this record
  already pins — see docs/project-storage-contract.md for the retention and
  resolution contract. No second copy of a Matting fact is created.

## 5. Command contract (US-005)

- `ply matte <image> [--id <id>]` — see the module help for the full syntax.
- Default output is compact human text; `--json` emits `{ok: true, matteId,
  matteDir, matte}` / `{ok: false, error}`. Exit codes: 0 ok, 1 failure,
  2 usage.
- Richer evidence presentation is #109's ownership; no show/list subcommand is
  introduced here.