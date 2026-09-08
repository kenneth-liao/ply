# Project Storage & Selection Contract

This document defines the storage layout, explicit selection, schemas, and containment contract established by #78 and extended by #79 for the Ply Composer foundation (Spec #77, ADR-0013, ADR-0014, DEC-001–006). Dependent tickets (#80–#88) consume and adhere to this contract.

---

## 1. Project Boundary & Invariants

- **Self-contained & Movable**: A Project is the sole authoritative home for its Compositions, Layers, content blobs, and Render history. Moving or copying a Project directory to any location on disk requires no path rewrites and retains complete functionality.
- **No Global Mutable State**: There is no global catalog, background daemon, or active project registry. Project discovery is explicit per invocation.
- **Offline & Local (US-006)**: All project lifecycle, inspection, and authoring operations are purely local and offline. No operation invokes remote network services or implicit image generation.

---

## 2. Selection Syntax & Invocation Contract

Commands operating on a Project designate the target Project explicitly:

- **Flag**: `--project <path>` or `-p <path>` (e.g. `ply composition inspect thumb --project /path/to/proj`).
- **Positional**: Specific commands (such as `ply project init <path>`) accept the target path positionally. When omitted, commands default to the current working directory (`.`).
- **Validation**: Any missing directory, non-directory file, missing `ply.json`, or malformed manifest is rejected immediately with an actionable error message and a nonzero exit code (`1` for runtime errors, `2` for syntax/usage errors).

---

## 3. Directory Layout (schemaVersion 1)

A Ply Project directory has the following canonical structure:

```
<project_root>/
├── ply.json                     # Project manifest
├── .ply.lock                    # Ephemeral Project-level mutation and reader lockfile
├── compositions/                # Composition JSON documents
│   └── <composition-name>.json
├── layers/                      # Layer identity records and revision documents
│   ├── <layer-id>.json          # Mutable Layer identity record (current revision pointer)
│   └── <layer-id>.revisions/    # Immutable revision documents for this Layer
│       └── <revision-hash>.json
├── content/                     # Content-addressed immutable binary blobs (sha-256)
│   └── <sha256>
└── renders/                     # Historical Render manifests and outputs
    ├── <render-id>.manifest.json
    └── <render-id>.png
```

### Manifest & Schema Specifications

#### `ply.json` Manifest Format
```json
{
  "schemaVersion": 1,
  "name": "project-name",
  "createdAt": "2026-09-07T22:00:00.000Z"
}
```
- `schemaVersion` (integer): Specifies the project schema format version (currently `1`).
- `name` (string): Human-readable Project name.
- `createdAt` (string): UTC ISO 8601 creation timestamp, in the canonical `Date.toISOString()` form.

#### `compositions/<name>.json` (Owned by #79, #83, #84)
```json
{
  "schemaVersion": 1,
  "name": "thumbnail",
  "canvas": {
    "width": 1280,
    "height": 720
  },
  "layers": [
    {
      "name": "background",
      "layerId": "layer_01j7abc123"
    },
    {
      "name": "hero",
      "layerId": "layer_01j7def456"
    }
  ]
}
```
- `canvas` (object): Canvas dimensions (`width` and `height` are required positive integers; no implicit defaults).
- `layers` (array): Ordered list of Layer uses defining the painting order (earlier paints underneath, later paints on top).
  - `name` (string): Composition-local unique name addressing this use.
  - `layerId` (string): Stable Project Layer identity pointer (`layers/<layer-id>.json`).
  - No per-use placement overrides, variant sets, or nested compositions.

#### `layers/<layer-id>.json` (Owned by #79, #82, #85)
```json
{
  "schemaVersion": 1,
  "id": "layer_01j7abc123",
  "createdAt": "2026-09-07T22:30:00.000Z",
  "currentRevision": "rev_e3b0c44298fc1c14"
}
```
- `id` (string): Stable Project-scoped Layer identity.
- `currentRevision` (string): Points to the current active revision document in `layers/<layer-id>.revisions/<revision-hash>.json`.
- Contains only stable identity facts and the current pointer (no mutable array of revisions).

#### `layers/<layer-id>.revisions/<revision-hash>.json` (Owned by #79, #82, #85)
```json
{
  "schemaVersion": 1,
  "layerId": "layer_01j7abc123",
  "createdAt": "2026-09-07T22:30:00.000Z",
  "kind": "image",
  "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "x": 0,
  "y": 0,
  "opacity": 1.0
}
```
- Immutable document identified by content-derived revision hash.
- `kind` (string): `"image"` (or `"text"` in #81).
- `contentHash` (string): Content-addressed SHA-256 hash pointing to `content/<contentHash>`.
- `x`, `y` (number): Layer placement on the canvas.
- `opacity` (number): Layer opacity in `[0, 1]`.
- Intrinsic width, height, and format are derived from the verified content blob, not duplicated in the revision.

#### `content/<sha256>` (Owned by #79, #86, #87)
- Content-addressed raw binary blob.
- Immutable and deduplicated across all Layers and revisions in the Project. Existing deduplicated blobs are validated for byte integrity and headers before reuse.

### Resolution-Time Verification

Readers never trust stored bytes blindly. `readLayerInternal` re-verifies on every resolution:
- Every stored manifest, Composition, identity, revision, content blob, and lock payload is checked for real filesystem containment before reading its bytes. A Project-root symlink alias remains valid; an owned path escaping that root is rejected.
- Project selection and inspection use the same complete manifest validator: object, supported schema version, nonempty name, required UTC ISO creation timestamp, and all canonical directories.
- The Layer identity document's `id` matches the requested Layer, its `currentRevision` is a revision identifier, and both identity and revision have required UTC ISO creation timestamps.
- The revision document is a canonical, self-consistent revision of that Layer (schema, `layerId`, `kind`, sha-256 `contentHash`, finite placement, `opacity` in `[0, 1]`), and its contents re-hash to exactly the revision hash the identity's current pointer names.
- The retained content blob re-hashes to its `contentHash`; any drift is rejected as corrupted rather than resolved to substitute bytes.
- Composition documents are parsed through one shared validated parser (name↔file match, positive-integer canvas, ordered unique `{ name, layerId }` uses); mutations refuse a composition whose existing references no longer resolve.

---

## 4. Ingestion & Validation Contract

0. **Project Gate**: Every command that reads or mutates Project state first resolves the target through `resolveProjectRoot` (`src/project.ts`): an existing directory with a complete, current, contained `ply.json` manifest and all four canonical subdirectories present, each verified to stay inside the Project once symlinks are resolved. Validation happens before any write, so invalid targets never gain partial state.
1. **Resource Bounds**:
   - `MAX_ENCODED_BYTES` (64 MB) enforced on the open file handle before full read.
   - `MAX_DIMENSION` (8192 px) and `MAX_PIXELS` (16,777,216 px) enforced on declared geometry.
2. **Format & Decoding Verification**:
   - Validated supported formats: PNG, JPEG, WebP.
   - Sniffed via `readRasterMeta` (bounding checks).
   - Full image decompression and decoding verified prior to staging:
     - PNGs verified via `decodePng` (chunk CRCs, IDAT inflate, scanlines, filter codes).
     - Rasters verified via browser image decoding (`Image.decode()`).
   - Truncated or corrupted image bodies with valid headers are rejected at the ingestion boundary.

---

## 5. Locking & Atomic Publication Protocol

### Project Lock (`.ply.lock`)
- Project-level exclusive lock file (`.ply.lock`) acquired for all mutations and public inspection/list readers to prevent reading partial or mixed snapshots.
- Single lock helper with unlocked internal readers avoids re-entrancy deadlocks.
- **Stale-Lock Policy**: Checks holder PID liveness via `process.kill(pid, 0)` without age-based stealing. On timeout or dead PID, fails with actionable instructions for operator cleanup. Release verifies inode and token before unlinking.

### Atomic Publication & Rollback
1. Acquire Project Lock.
2. Ingest and decode input image; compute SHA-256.
3. Stage immutable content blob in `content/<sha256>` (atomic create if not already present).
4. Stage immutable revision in `layers/<layer-id>.revisions/<revision-hash>.json` (atomic create).
5. Stage Layer identity in `layers/<layer-id>.json` (atomic create), then fully resolve the staged Layer before the live commit. Resolution failure follows the same rollback path.
6. **Live Commit Point**: Update `compositions/<name>.json` with `{ name: localName, layerId }` via `atomicReplace`.
7. **Rollback**: If any failure occurs prior to step 6, delete staged `layers/<layer-id>.json` and revision file (removing the revision directory if it is now empty). The composition remains unchanged and no live reference is published; the immutable content blob is retained for deduplication.
8. Release Project Lock.

---

## 6. CLI Commands & Output Contract (US-008)

All commands support `--project <path>` (or `-p <path>`) and `--json`.

- `ply project init [dir] [--name <str>] [--json]`
- `ply project inspect [options] [--json]`
- `ply composition create <name> --width <w> --height <h> [options] [--json]`
- `ply composition add <comp> <local-name> --image <path> [--x <x>] [--y <y>] [--opacity <op>] [options] [--json]`
- `ply composition inspect <name> [options] [--json]`
- `ply composition list [options] [--json]`
- `ply layer inspect <layer-id> [options] [--json]`
- `ply layer list [options] [--json]`

### Status & Error Codes:
- **0**: Success.
- **1**: Runtime error (missing project, invalid image, duplicate name, etc.). Structured error JSON in `--json` mode.
- **2**: Usage error / malformed flags / missing required options. Structured error JSON in `--json` mode.
