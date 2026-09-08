# Project Storage & Selection Contract

This document defines the storage layout, explicit selection, and containment contract established by #78 for the Ply Composer foundation (Spec #77, ADR-0013, DEC-001–006). Dependent tickets (#79–#88) consume and adhere to this contract.

---

## 1. Project Boundary & Invariants

- **Self-contained & Movable**: A Project is the sole authoritative home for its Compositions, Layers, content blobs, and Render history. Moving or copying a Project directory to any location on disk requires no path rewrites and retains complete functionality.
- **No Global Mutable State**: There is no global catalog, background daemon, or active project registry. Project discovery is explicit per invocation.
- **Offline & Local (US-006)**: All project lifecycle, inspection, and authoring operations are purely local and offline. No operation invokes remote network services or implicit image generation.

---

## 2. Selection Syntax & Invocation Contract

Commands operating on a Project designate the target Project explicitly:

- **Flag**: `--project <path>` or `-p <path>` (e.g. `ply project inspect --project /path/to/proj`).
- **Positional**: Specific commands (such as `ply project init <path>`) accept the target path positionally. When omitted, commands default to the current working directory (`.`).
- **Validation**: Any missing directory, non-directory file, missing `ply.json`, or malformed manifest is rejected immediately with an actionable error message and a nonzero exit code (`1` for runtime errors, `2` for syntax/usage errors).

---

## 3. Directory Layout (schemaVersion 1)

A Ply Project directory has the following canonical structure:

```
<project_root>/
├── ply.json         # Project manifest
├── compositions/    # Composition JSON documents
├── layers/          # Layer identity records
├── content/         # Content-addressed immutable blobs (sha-256)
└── renders/         # Historical Render manifests and outputs
```

### `ply.json` Manifest Format
```json
{
  "schemaVersion": 1,
  "name": "project-name",
  "createdAt": "2026-09-07T22:00:00.000Z"
}
```

- `schemaVersion` (integer): Specifies the project schema format version (currently `1`).
- `name` (string): Human-readable Project name.
- `createdAt` (string): ISO 8601 creation timestamp.

### Subdirectory Responsibilities
1. **`compositions/`** (Owned by #79, #83, #84): Contains composition definitions (`<composition-name>.json`), each defining an ordered list of Layer references and canvas dimensions.
2. **`layers/`** (Owned by #79, #82, #85): Contains Layer identity definitions (`<layer-id>.json`), tracking stable project-scoped IDs and current revision pointers.
3. **`content/`** (Owned by #79, #86, #87): Content-addressed immutable binary storage (`<sha256>`), retaining historical inputs for byte-identical reproduction.
4. **`renders/`** (Owned by #80, #87): Historical Render manifests (`<render-id>.manifest.json`) and output images (`<render-id>.png`).

---

## 4. Path Containment & Security

- **Boundary Enforcement**: All reads and writes must remain inside `<project_root>`. Operations verify containment using `src/paths.ts` (`outsideDir` and `escapesDirReal`).
- **Symlink Discipline**: Symlinks inside the Project targeting paths outside the Project root are rejected.
- **Fail-Safe Initialization**: `ply project init` verifies that the target path does not conflict with existing manifests or pre-existing subdirectories, ensuring caller files are never overwritten on failure.

---

## 5. CLI Output & Error Contract (US-008)

All commands introduced for Project management adhere to US-008:
- **Default (Text)**: Outputs concise, single-screen human-readable text.
- **Machine-Readable (`--json`)**: Outputs valid formatted JSON.
  - Success: `{ "ok": true, "project": { ... } }` (Exit code: 0)
  - Failure: `{ "ok": false, "error": "<actionable diagnostic>" }` (Exit code: 1 or 2)
