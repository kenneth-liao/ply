# Scene CLI — operational detail

The retained legacy Scene surface (`ply scene`, preserved for existing work)
keeps its full operational contract here; `ply scene --help` stays focused on
commands and options and points at this document. Every fact below is
maintained: it describes what runs today.

## Output and manifests

Structured results are one valid JSON object on stdout under `--json`:
`{ "ok": true, ... }` or `{ "ok": false, "errors": [...] }`. Successful
renders carry a "warnings" array (e.g. an auto-fit layer that could not fit
at its min floor, or a safe-area violation naming the layer that intersects
YouTube's duration-badge or progress-bar region) and write a Render manifest
beside the output(s) (`<out>.manifest.json`) recording the scene identity,
selected variants, exact Asset identities, tool version, and outputs — every
path in it is relative to the manifest itself, so the project can be
relocated and re-rendered offline via `scene rerender`. `scene validate`
reports the structured `safeAreaViolations` array. Exit codes: 0 ok, 1
invalid scene or render failure, 2 usage error. Rendering, validation,
inspection, and rerendering are offline and never start generation.

Before #128, Scene commands printed this JSON by default; the default is now
compact text, with `--json` as the machine-readable form for callers and
scripts (see README, Legacy surface).

## Themes and templates

A Scene may pin a bundled theme: `"theme": { "name", "revision" }`.
Precedence is one rule — explicit layer value, then theme default, then the
renderer's built-in default. The revision is the sha-256 of the theme's
content; loading re-derives it and fails loudly on drift, so old Scenes
never render with silently changed theme content. `scene init` bakes a
template's layers into a plain Scene (no runtime template reference) with
the theme pin set.

## Safe areas (REQ-012)

The YouTube duration-badge and progress regions are defined once in
`src/safe-area.ts`. `validate` and `render` report visible layers whose
painted footprint intersects a region — as structured violations and as
warnings respectively. Violations never fail a render: a full-canvas plate
legitimately intersects, and accepting the overlap is the reviewer's call
(ADR-0005). `scene guidelines` renders the regions for visual review without
entering the final output.

## Reference Thumbnail import (DEC-001..004)

`scene reference import <scene> <file>` is one normalization boundary plus
one atomic transaction, serialized per Scene by a lock file (`<scene>.lock`
— leave it in place: it relocates with the bundle, and a crashed import's
lock is recovered automatically). Supported input is exactly a regular local
PNG, JPEG, or WebP file; it may live anywhere — it is external source
material. Ingestion is resource-bounded: the file is opened and the opened
handle is measured (regular files only), the 64 MB encoded cap is enforced
on that measurement and re-bounded by the read window itself, and the
header's declared geometry must fit the decoded-pixel budget before the
browser rasterizes anything. Normalization is non-distorting and
non-subjective: a 16:9 input is uniformly rescaled to exactly 1280×720 (1:1
when already exact); any other aspect is refused before anything is written,
because fitting it would require an unstated subjective crop or a
distortion — crop or resize locally with stated intent, then import. The
copy is stored inside the scene's directory as `<scene>.reference.png` (a
`-2`, `-3`… suffix is used when a name is taken — the reservation is an
exclusive no-replace create, so an existing file, directory, or symlink
alias is never overwritten or written through, and the previous
association's file always survives). `--source` records user-supplied
provenance as `reference.source` free text: never resolved as a path — no
external file dependency — and never a second stored hash (identity derives
from bytes). Before the Scene file is replaced, the complete resulting Scene
passes the same validation gate as `scene validate`, and the Scene's current
bytes are compared to the bytes this import first read — an intervening edit
fails closed. Any failure — missing or unreadable input, refused
normalization, failed validation, a changed Scene, or a failed commit —
rolls the new copy back and leaves the previous Scene and its associated
files byte-identical and usable; a rollback whose removal fails is reported
as a second error naming the retained path. The renderer never reads the
reference, and the Render manifest never records it as a Render input
(DEC-009): importing changes neither rendered pixels nor resolved Asset
identities — the manifest's scene byte identity (its sha256) necessarily
changes, because the reference metadata is part of the Scene bytes.

## Scene replacement and the per-Scene lock

Every in-repo writer that can replace an existing Scene participates in the
same per-Scene transaction lock (`<scene>.lock` beside the scene's real
path): `scene reference import` and `scene init --force` (over an existing
file). On contention a writer waits only to the bounded timeout and then
fails with the retained lock path named — a crashed holder's lock requires
explicit operator cleanup, never automatic stealing. Fresh `scene init`
publication is an atomic no-replace create: a writer that appears between
the existence check and publication gets a refusal, never a silent
overwrite. External (non-participating) edits to the Scene are still caught
by the import's Scene-byte comparison immediately before commit.