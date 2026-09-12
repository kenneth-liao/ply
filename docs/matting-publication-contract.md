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
├── outputs/                  # content-addressed matted bytes (sha-256)
│   └── <sha256>.png
└── sources/                  # content-addressed source copy (schemaVersion 2
    └── <sha256>.png          #   inference records only, when distinct — see §2)
```

A `schemaVersion` 2 inference record stores a copy of the exact source bytes
that were read at `sources/<sha256>.png`, where the filename hash is the
record's `request.source.contentHash` — the copy *is* the source identity,
not a second hash. When a distinct copy exists, the record names its path in
`request.source.file`, so rematting is ordinary `ply matte` on that retained
path (no new command) and never depends on the caller's original file.
Native-alpha records (`source` hash equals output hash) store one blob under
`outputs/` and omit `sources/` — two identical blobs are never stored.
`schemaVersion` 1 records have no source copy.

Matte ids match `^[a-z0-9][a-z0-9-]*$`; the auto id is
`matte-<yyyymmdd>-<8 hex>`. Creating over an existing matte id (`matte.json`
present) is refused — matting a new image records a new matte; nothing is ever
overwritten. A stale directory without `matte.json` (a hard crash) holds no
lineage and may be reclaimed by a retry of the same id.

## 2. Record schema (schemaVersion 2, kind "matting")

New records are `schemaVersion` 2. The parser reads versions 1 and 2:
version 1 records stay readable with no backfill, and missing source copy /
backend / timing on a version 1 record is not an error.

```json
{
  "schemaVersion": 2,
  "matteId": "matte-20260908-ab12cd34",
  "kind": "matting",
  "createdAt": "2026-09-08T12:00:00.000Z",
  "request": {
    "source": {
      "path": "caller-supplied path as written",
      "contentHash": "sha-256 derived once at the operation boundary",
      "file": "sources/<sha256>.png"
    }
  },
  "result": {
    "engine": "native-alpha | local-segmentation:<weights filename>",
    "backend": "the engine-declared backend that ran inference",
    "timing": { "millis": 1234, "scope": "engine" },
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
- **`request.source.file` names the retained source copy**, present if and
  only if a distinct copy was stored (`sources/<contentHash>.png`). The
  filename hash must equal `request.source.contentHash` — enforced by the
  parser, so the copy can never drift into a second identity.
- **`result.backend` names the backend that ran inference.** It is an
  engine-declared non-empty string, not a product enum: each engine reports
  what it actually used. It is required on version 2 inference records and
  must be absent on native-alpha records (no inference ran — nothing to name).
  The shipped engine observes its device inside its single inference process
  and records `mps`; anything else fails the matte instead of recording.
- **`result.timing` is a timing figure with a stated boundary**
  (`{ millis, scope }`, `millis` finite and ≥ 0, `scope` non-empty).
  Fresh-process vs already-loaded figures must never be mixed under one
  scope: for the shipped engine, scope `"engine"` means wall time of the
  engine call after preflight. The shipped engine is a one-shot process, so
  this figure ALWAYS includes startup, weight load, inference, and mask
  write — it is always fresh, and must never be compared with a warm-loaded
  figure. Required on version 2 inference records; must be absent on
  native-alpha records.
- **Version 2 inference records require all three new facts.** A version 2
  inference record that omits `request.source.file`, `result.backend`, or a
  well-formed `result.timing` fails to parse. A version 2 native-alpha
  record must omit `request.source.file`, `result.backend`, and
  `result.timing`, and its output hash must equal the source hash.
- **`result.engine` records the engine**, `native-alpha` when the source's own
  alpha was the matte (no inference, and the published bytes are the exact
  source bytes — their content hash equals the source's), or the engine name
  the real segmenter records
  (`local-segmentation:birefnet-dynamic@280306042f57b7a33854319da62fd86aaa89ec4c` —
  the pinned BiRefNet Dynamic revision on PyTorch/MPS, ADR-0020).
- **The result passes the true-alpha gate before publication**: the alpha
  report in the record is measured by the same gate (`src/alpha.ts`) the
  retired adoption path applied, run at the pass that produced the bytes. An
  unusable result (all-opaque or all-transparent) is refused there and never
  published.
- **Outputs are content-addressed** by sha-256 of the exact bytes on disk;
  `contentHash` is verifiable against the file at any time.
- **`engine.preflight` runs at this operation, before inference.** Missing or
  mismatched weights fail with the pinned filename, sha-256, and fetch
  command before anything is written; a machine without MPS fails inside the
  single inference process before any mask is written. There is exactly one
  inference process per matte and no second preflight process.

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

- Output bytes and the retained source copy (version 2 inference records)
  are persisted first; `matte.json` is the commit point, written last.
  There is no moment where a record exists without its output.
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
- Compact text names the retained source path (`source-copy:`) when a distinct
  copy was stored, and the inference backend and timing (`backend:`,
  `timing: <millis> ms (<scope>)`) on inference records. `--json` exposes
  the same facts through the embedded record.
- Richer evidence presentation is #109's ownership, delivered as
  `ply generate review <job-id>` (docs/generation-publication-contract.md
  §7) for published evidence — it associates a matte by the same derived
  sha-256 source linkage this record defines — and `ply layer review
  <layer-id> --out <path>` (docs/project-storage-contract.md §7) for
  retained Project evidence. No show/list subcommand exists on this surface.