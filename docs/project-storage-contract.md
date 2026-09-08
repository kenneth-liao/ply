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

Since #80, caller exports via `ply composition render --out` may create a fresh PNG anywhere in the Project that is not reserved storage and has an existing parent directory; reserved inputs and every existing Project path are protected (see §6, Render output).

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
  - `ply composition reorder` permutes existing uses to alter painting order (#83).
  - `ply composition remove` removes a use from this list without modifying or deleting the underlying Layer, its revisions, content blobs, or other Compositions' uses of that Layer (#83). Removing the last use yields an empty `layers: []` array.
  - `ply composition import` appends a source Composition's Layer references into a target Composition as individual, independently editable uses pointing to the same shared Layer identities, with no baked images or subscription coupling (#84).

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

#### `layers/<layer-id>.revisions/<revision-hash>.json` (Owned by #79, #81, #82, #85)
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
- `kind` (string): Discriminated content contract — `"image"` or `"text"` (#81). Both kinds share the identity/revision/use lifecycle, publication protocol, and storage layout; there is no second lifecycle for text.
- `contentHash` (string): Content-addressed SHA-256 hash pointing to `content/<contentHash>`.
- `x`, `y` (number): Layer placement on the canvas.
- `opacity` (number): Layer opacity in `[0, 1]`.
- Image revisions derive intrinsic width, height, and format from the verified content blob; nothing raster-specific is duplicated in the revision.

**Text revision contract (#81).** A `"text"` revision additionally carries `text` (nonempty string, ≤ 2000 characters), `fontSize` (finite number in `(0, 8192]`), and `color` (strict hex `#RGB`/`#RRGGBB`) as immutable revision facts covered by the revision hash:

**Content/font identity semantics.** For both kinds, `contentHash` is the one content identity: it pins the revision's exact retained bytes in `content/<sha256>` — decoded raster bytes for `"image"`, the bundled font face's raw TTF bytes for `"text"`. The face is resolved once at ingestion through the bundled-face registry (`resolveFace` in `src/fonts.ts`); its bytes are then retained into the Project, and the family/weight selection facts live only in that registry. They are deliberately **not** persisted: the renderer declares the retained bytes under an internal `@font-face` family derived from the content hash, so rendering after retention never consults `assets/fonts/` and no family/weight fact is stored in a second storage source. A text revision's retained font blob is required Project state for rendering and future replay/relocation (#87), exactly like image content.

#### `content/<sha256>` (Owned by #79, #86, #87)
- Content-addressed raw binary blob.
- Immutable and deduplicated across all Layers and revisions in the Project. Existing deduplicated blobs are validated for byte integrity and headers before reuse.

### Resolution-Time Verification

Readers never trust stored bytes blindly. `readLayerInternal` re-verifies on every resolution:
- Every stored manifest, Composition, identity, revision, content blob, and lock payload is checked for real filesystem containment before reading its bytes. A Project-root symlink alias remains valid; an owned path escaping that root is rejected.
- Project selection and inspection use the same complete manifest validator: object, supported schema version, nonempty name, required UTC ISO creation timestamp, and all canonical directories.
- The Layer identity document's `id` matches the requested Layer, its `currentRevision` is a revision identifier, and both identity and revision have required UTC ISO creation timestamps.
- The revision document is a canonical, self-consistent revision of that Layer (schema, `layerId`, discriminated `kind` (`"image"` or `"text"`), sha-256 `contentHash`, finite placement, `opacity` in `[0, 1]`; for `"text"`: nonempty ≤ 2000-character `text`, finite `fontSize` in `(0, 8192]`, and strict hex `color` — validated by the one shared text validator used at ingestion), and its contents re-hash to exactly the revision hash the identity's current pointer names.
- The retained content blob re-hashes to its `contentHash`; any drift is rejected as corrupted rather than resolved to substitute bytes.
- Composition documents are parsed through one shared validated parser (name↔file match, positive-integer canvas, ordered unique `{ name, layerId }` uses); mutations refuse a composition whose existing references no longer resolve.
- Composition resolution has one canonical site: `readCompositionInternalFull` (`src/composition.ts`) parses the document once and resolves every Layer exactly once through the canonical Layer resolver (`readLayerInternalFull`, `src/layer.ts`), returning reference names, revision metadata, and the hash-verified retained bytes. Metadata-only readers project from that result — no reader resolves or verifies the same Layer twice.

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
2. Ingest and validate content: for `--image`, decode the input image and compute SHA-256; for `--text`, resolve the bundled font family once and read its bundled bytes (unknown families and missing bundled bytes fail loudly, naming the bundled families).
3. Stage immutable content blob in `content/<sha256>` (atomic create if not already present) — the image bytes or the retained font bytes.
4. Stage immutable revision in `layers/<layer-id>.revisions/<revision-hash>.json` (atomic create).
5. Stage Layer identity in `layers/<layer-id>.json` (atomic create), then fully resolve the staged Layer before the live commit. Resolution failure follows the same rollback path.
6. **Live Commit Point**: Update `compositions/<name>.json` with `{ name: localName, layerId }` via `atomicReplace`.
7. **Caught-error cleanup**: If an error reaches the staging catch before step 6 completes, attempt to delete the staged identity and revision and remove the empty revision directory. This cleanup is best-effort: deletion errors are ignored, so artifacts may remain. The Composition reference is not published when replacement fails; immutable content is retained for deduplication.
8. Release Project Lock in the normal `finally` path. Release is also best-effort; it is not guaranteed after abrupt termination.

### In-Place Layer Editing & Authoritative Referrer Discovery (#82, US-004, US-002)

1. **Acquire Project Lock**: Entire referrer discovery, content validation, revision staging, and identity pointer update execute under `.ply.lock`.
2. **Authoritative Referrer Discovery**:
   - Scans all `compositions/*.json` documents using the canonical parser `parseCompositionDocument`.
   - Counts distinct referring Compositions (not use occurrences).
   - **Fail-Closed Guarantee**: Any malformed, unreadable, or escaping Composition document in `compositions/` immediately aborts the operation with a runtime error (exit 1); unreadable reference state is never treated as proof that sharing is absent.
3. **Intent Enforcement (Blast-Radius Guard)**:
   - If referrers count $\le 1$ (including unreferenced/retained Layers with 0 referrers): editing succeeds without `--in-place` flag or warning.
   - If referrers count $> 1$: editing without `--in-place` fails with exit status 1, reporting all affected Compositions and their count in text and `--json` mode (`referringCompositions`, `referrersCount`). Passing `--in-place` advances the Layer's current revision, propagating to all referring Compositions upon subsequent resolution.
4. **Kind Stability & Field Preservation**:
   - A Layer's kind (`"image"` or `"text"`) is stable across revisions; kind-incompatible options (e.g. `--text` on an image Layer or `--image` on a text Layer) fail validation before staging.
   - Placement (`--x`, `--y`, `--opacity`) and text fields (`--text`, `--font-size`, `--color`) preserve current values when omitted.
   - Font-preserving text edits reuse the Layer's retained font blob without re-reading `assets/fonts/`; supplying `--font` resolves and ingests the bundled face bytes locally into `content/`.
   - If all target revision fields match the current revision (no-op edit), the existing revision is returned without creating duplicate revision files or storage churn.
5. **Atomic Publication & Rollback**:
   - Stages new revision document in `layers/<layer-id>.revisions/<revision-hash>.json` (`atomicCreate`).
   - **Live Commit Point**: Updates `layers/<layer-id>.json` with `{ ...identity, currentRevision: revHash }` via `atomicReplace`.
   - Caught-error cleanup: attempts to unlink staged revision file if identity replacement fails.
    - Historical revision documents and content blobs are never overwritten or deleted; all prior revisions remain available for reproduction (#87).
    - The Project lock coordinates cooperating Ply processes; it does not claim coordination with arbitrary external filesystem writers.

### Explicit Fork Editing (#85, US-004)

`ply layer edit <layer-id> --fork --composition <comp> --use <local-name> [edit options]` publishes a new Layer identity and retargets exactly one use. The CLI command is the sole fork entry point.

1. **Intent Normalization (#85, DEC-003)**: External intent is normalized once into a canonical discriminated shape — in-place, or fork with an explicit `composition`/`use` target. `--fork` and `--in-place` are mutually exclusive; fork requires `--composition <comp>` and `--use <local-name>`; those flags are forbidden without `--fork`. Flag misuse is a usage error (exit 2). A fork with no edit options is valid (documented below).
2. **Acquire Project Lock**: Referrer discovery, target validation, revision construction, staging, and the live commit all execute under `.ply.lock` — the same boundary as in-place editing (#82) and Composition mutations (#83, #84).
3. **Authoritative Referrer Discovery**: The same fail-closed `compositions/*.json` scan as in-place editing runs before any fork work. A fork never needs the blast-radius flag (it changes exactly one use in one Composition), but the scan still fails closed on malformed or unreadable documents, and the reported `referrersCount`/`referringCompositions` describe the original Layer's pre-fork referrers.
4. **Target Validation (canonical use→original-id rule)**: The target Composition document must exist and parse canonically; the selected use must exist in it by local name; and that use must reference the Layer being forked. Mismatches fail closed (exit 1) before any content work. Every existing reference in the target Composition is re-verified to resolve — never mutate a composition whose existing references no longer resolve.
5. **Shared Edited-Revision Construction**: The edited revision builds through the same canonical construction as in-place editing: kind stability (`--text`/`--font`/`--font-size`/`--color` on an image Layer and `--image` on a text Layer fail), placement/opacity preservation when omitted, and font-preserving reuse of retained bytes (only `--font` re-resolves a bundled face). The revision document binds the new identity and a fresh `createdAt`.
6. **No-Content-Change Fork**: An explicit fork ALWAYS publishes a new Layer identity, even when the edited revision is field-identical to the current one. This is documented behavior, not an accident: the caller asked for an isolated copy, and the in-place no-op shortcut does not apply.
7. **Atomic Publication & Rollback**:
   - Stages the new revision (`layers/<new-id>.revisions/<revision-hash>.json`, `atomicCreate`), stages the new identity (`layers/<new-id>.json`, `atomicCreate`), then fully resolves the staged Layer before the live commit.
   - **Live Commit Point**: Replaces `compositions/<comp>.json` via `atomicReplace` with ONLY the selected use retargeted to the new identity; every other document field and use (including other uses of the same Layer identity in the same Composition) is preserved verbatim.
   - **Caught-error cleanup**: If an error reaches the staging catch before the Composition replacement completes, the newly staged identity and revision (and the now-empty revision directory) are deleted. The original Layer's identity, revisions, and content are never touched; deduplicated content blobs already present before the fork are retained. Content newly ingested by the failed fork (e.g. a `--image` blob staged before the replacement failed) is honestly NOT deleted: like every publication path, immutable content is retained for deduplication and may remain unreferenced after a failure or interruption.
   - On failure the live references and current revisions are unchanged (exit 1) and the operation can be retried. The interrupted-operation recovery notes in “Interrupted operations and operator recovery” apply unchanged (a crash can leave an unreferenced staged identity).
8. **Original-State Guarantee**: The original identity document, every historical revision document, and all content blobs remain byte-identical across a fork; other Compositions (including the fork's source) render byte-identically.

### Composition Reference Removal & Reordering (#83, US-002, US-008)

1. **Acquire Project Lock**: Entire document discovery, reference verification, and replacement execute under `.ply.lock` to coordinate with other Composition mutations, in-place Layer edits (#82), and reader snapshots.
2. **Document Parsing & Resolution**: Scans the target Composition document using `parseCompositionDocument` and re-verifies that every referenced Layer resolves via `readLayerInternal`. Fails closed immediately on missing or malformed documents or dangling references.
3. **Removal Protocol (`remove`)**:
   - Locates the use by its unique local name (`<use-name>`).
   - Fails with exit 1 if the use name is not found in the Composition.
   - Updates `compositions/<name>.json` via `atomicReplace` with the target use removed. Removing the last use is permitted and yields an empty `layers: []` array.
   - **Layer Preservation Guarantee**: Removal does NOT delete or mutate the Layer identity document (`layers/<layer-id>.json`), any historical revision documents, or any content blobs in `content/`. Other Compositions referencing the same Layer remain completely unaffected and resolvable.
4. **Reordering Protocol (`reorder`)**:
   - Requires an exact full-order permutation of all existing local use names via `--order <name1,name2,...>`.
   - Rejects duplicate names, missing names, unknown names, empty segments, or count mismatches with exit 1 and actionable diagnostics, leaving the stored Composition document completely unchanged.
   - For an empty Composition (0 layers), an explicit empty order (`--order ""`) succeeds as a no-op; passing non-empty names fails with exit 1.
   - If the requested permutation matches the existing order (no-op reorder), it returns cleanly without storage churn.
   - Valid permutations commit the updated `layers` array to `compositions/<name>.json` via `atomicReplace`.

### Same-Project Composition Import (#84, US-003, US-008)

1. **Acquire Project Lock**: The entire document discovery, reference verification, collision validation, and atomic destination update execute under `.ply.lock` to coordinate with other Composition mutations, in-place Layer edits (#82), and reader snapshots.
2. **Document Parsing & Resolution**:
   - Resolves target (destination) and source Composition documents using `readMutableComposition`.
   - Re-verifies that every referenced Layer in both Compositions resolves via `readLayerInternal`. Fails closed immediately on missing or malformed documents or dangling references.
3. **Self-Import & Empty-Source Invariants**:
   - **Self-import refusal**: Importing a Composition into itself (`target === source`) fails closed with exit 1, leaving stored documents unchanged.
   - **Empty-source no-op**: Importing a source Composition with 0 layers (`layers: []`) succeeds cleanly as a no-op returning 0 imported uses without storage churn.
4. **Collision Policy (Explicit Fail-Closed Rejection)**:
   - Compares all use names in `source.layers` against existing use names in `target.layers`.
   - If any name collides, the operation fails closed with exit 1 and an actionable error naming the colliding local name(s).
   - Live destination references and stored documents remain completely unmodified and byte-identical.
5. **Shared Layer Identity Reuse & Content Preservation**:
   - Appends source's `{ name, layerId }` uses to the end of target's `layers` array, preserving source ordering among imported uses.
   - Reuses the exact same stable Layer identity pointers (`layerId`).
   - Does NOT clone Layer identity documents (`layers/<layer-id>.json`), historical revision documents (`layers/<layer-id>.revisions/*.json`), or content blobs (`content/<sha256>`).
   - Never substitutes a rendered image, raster snapshot, or flattened asset.
6. **Non-Subscription Membership Semantics**:
   - The destination Composition gains its own independent reference list.
   - Subsequent additions, removals, or reorderings in the source Composition do NOT alter the destination Composition.
   - Predecessor operations (`composition remove`, `composition add`, `composition reorder`) allow dropping imported uses or interleaving destination-owned Layers between imported uses without affecting the source.
7. **In-Place Edit Propagation & Multi-Referrer Discovery**:
   - In-place edits to a shared Layer (`ply layer edit <layer-id> --in-place`) advance the Layer's current revision and propagate upon resolution to all referring Compositions.
   - Authoritative referrer discovery under the Project lock discovers all Compositions using that Layer. An unflagged edit (`ply layer edit <layer-id>`) on a Layer shared across multiple Compositions fails closed with exit 1, reporting all referring Compositions and `referrersCount: 2` (or greater).
8. **Canvas Dimensions**:
   - Importing between Compositions with different canvas dimensions preserves the destination's declared width and height and preserves Layer placements and opacities without rescaling.
9. **Atomic Publication**:
   - Commits updated `layers` array to `compositions/<target>.json` via `atomicReplace`.

### Cross-Project Composition Copy (#86, US-005, US-008)

`ply composition import <target> <source> --from-project <path>` copies a source Project Composition's reusable Layers into a destination Project Composition as independent destination Layer identities with retained destination bytes — never live source links. Flag absent ⇒ the #84 same-Project semantics apply unchanged.

1. **Alias Guard (poka-yoke)**: the source `--from-project` root and the destination root are compared by realpath. Identical realpaths mean one Project under a different path spelling, so the operation is refused (exit 1) with actionable guidance to run the same-Project `ply composition import <target> <source>` instead. Cross-Project copy semantics and same-Project shared-identity reuse are never silently confused. Two genuinely different Projects that happen to share a Composition name remain valid.
2. **Dual-Project Locking in Canonical Order**: both Projects' `.ply.lock` files are acquired in sorted canonical (realpath) order before any reading or staging. Every cooperating process derives the same global order, so reverse-direction imports (A importing from B while B imports from A) serialize instead of deadlocking. A failed second-lock acquisition releases the first lock. Under both locks, the source Composition is snapshotted through the canonical bytes-bearing reader `readCompositionInternalFull`: the document is parsed once and every referenced source use is resolved through the canonical Layer resolver `readLayerInternalFull` (hash-verified identity, revision, and content bytes) — one consistent snapshot, fail-closed on malformed or dangling source state. Duplicate uses of one source Layer each resolve through that same canonical resolver; the copy maps each distinct source Layer identity to exactly one destination identity from that snapshot (point 3). The source is read-only: the canonical pre-mutation reader (`readMutableComposition`) guards only the destination mutation boundary.
3. **One Destination Identity per Distinct Source Layer**: the snapshot maps each distinct source `layerId` to exactly one newly generated destination identity; duplicate uses of the same source Layer within the source Composition remap through that single map. Placement, opacity, kind, and text revision facts are preserved verbatim through the canonical copy construction (`buildCopiedRevision`); text fields are re-validated through the one shared text validator used at ingestion; intrinsics are re-derived from the verified content blob at resolution. The destination revision binds the new identity with a fresh `createdAt`, yielding a new content-derived revision hash. Only the source Layer's current revision is copied: source historical revisions remain the source Project's (#87 owns retention; OOS-007).
4. **Retained Bytes, No Font Re-resolution**: the source revision's verified content bytes (image raster or retained font TTF) are copied into the destination `content/` store via `storeContentBlob` (deduplicated, integrity-verified on reuse). Copying retained text never consults `assets/fonts/` or re-resolves a bundled face — the retained bytes are the only font identity, exactly as at ingestion.
5. **Atomic Publication & Rollback**:
   - Collision check BEFORE staging: any source local name colliding with an existing destination use name fails closed (exit 1) with a byte-identical destination — no staged artifacts, no partial live identity state.
   - Stage content blobs → stage revisions → stage identities (`atomicCreate`) → fully resolve every staged Layer before the live commit.
   - **Live Commit Point**: one `atomicReplace` of the destination Composition document appending the remapped uses (source order preserved; destination canvas, existing uses, and document fields untouched).
   - **Caught-error cleanup**: newly staged identities and revision documents are deleted (best-effort, revision directory only if now-empty); retained content blobs stay for deduplication and may remain as documented orphans. The source Project is never mutated on any path.
   - Empty-source import succeeds as a clean no-op with 0 imported uses and no storage churn.
6. **Two-Way Independence & Source-Free Usability**: source in-place edits advance only the source identity; destination edits and forks touch only destination identities. Because the destination retains its own bytes, removing the source Project and the original external input files leaves destination inspection, editing, and rendering fully functional offline.

### Interrupted operations and operator recovery

This protocol provides atomic Composition replacement and serialization among cooperating Ply processes, not crash rollback. Abrupt termination (for example, SIGKILL or process/host failure) bypasses catch/finally cleanup. An interruption after identity staging and before replacement can leave an unreferenced identity, its revision, retained content, temporary files, and a stale `.ply.lock`. Once the lock is manually removed, Layer listing and Project counts can expose that unreferenced identity. An interruption after replacement may instead leave a committed use; a missing success response does not establish failure. The controlled staging test proves reader serialization under normal completion, not recovery after a crash.

For recovery:

1. Confirm the owning command and every writer for this Project have stopped. Do not remove a lock merely because it is old or a wait timed out; inspect its PID and verify ownership/liveness. Copy the Project for recovery before changing files.
2. Inspect the stored Composition documents to establish whether the intended use was committed. Preserve all referenced identities, revisions, and content, including inputs retained by Render history. Do not retry an add merely because its command exited unsuccessfully or produced no response.
3. Residual unreferenced identities/revisions and temporary files are not automatically reconciled. Leave uncertain artifacts intact. Quarantine or remove artifacts only after establishing that they belong to the interrupted operation and are not required by any Composition or retained history; this is operator work, not a Ply garbage-collection or recovery command.
4. After confirming there is no active owner, remove the stale `.ply.lock` manually. Inspect the Project and its Compositions/Layers through the CLI to verify resolution before further mutations. If resolution fails, investigate the retained files or restore the recovery copy rather than substituting content or blindly retrying.

Atomic helpers do not `fsync` files or directories. Atomic visibility does not guarantee persistence or write ordering across power loss; this protocol provides no power-loss durability guarantee or crash journal.

---

## 6. Render Snapshot & Output Contract (#80, US-006)

### Snapshot

- `ply composition render` resolves under the Project lock in exactly one pass: the Composition document, its ordered Layer references, each Layer's current revision metadata (position, opacity, format, intrinsic size), and the hash-verified retained content bytes, all through `readCompositionInternalFull`. The lock is then released; painting never re-reads Project state.
- The snapshot's exact bytes are painted through the shared render page with awaited image decode. Paint contract: later Layers paint over earlier ones at each revision's stored position and opacity, at intrinsic size, clipped to the canvas; uncovered canvas stays transparent. Foundation Layer effects are position and opacity only. Text Layers (#81) paint as DOM text — never pre-rasterized into image content — with each text revision's retained font bytes declared under an internal `@font-face` family; after page load, every text family is probed for actual load/resolution, and an unresolved face (invalid or undecodable retained font bytes, unavailable font) fails the Render with a nonzero status and no published output instead of accepting browser/system fallback. Rendering a text Layer after retention never consults `assets/fonts/` or any global font store. Render-history capture is layered on this same snapshot (#87).
- Canvas limits are enforced at the render boundary: 8192 px per axis and 16,777,216 pixels total. Invalid dimensions, dangling Layer references, and corrupted or missing retained content fail with an actionable diagnostic and nonzero status. A failed Render publishes no output.

### Output

- **Default**: a fresh, never-colliding `renders/<composition>-<unique>.png`, created with `O_EXCL` so repeated renders never collide or overwrite.
- **`--out <path>` destination policy**:
  - Every **existing** in-Project path is protected state and refused — render history in `renders/`, the manifest, `compositions/`, `layers/`, `content/`, and any symlink alias onto them (judged by the path's realpath, so an in-project alias cannot dodge the guard).
  - A **fresh** path with an existing parent directory is permitted anywhere in the Project except reserved storage: the manifest (`ply.json`), the lock (`.ply.lock`), and the canonical `compositions/`, `layers/`, and `content/` directories. The parent must already exist; missing parents are refused, never created.
  - Fresh in-Project targets publish with `O_EXCL` (`atomicCreate`): a concurrent render racing the same fresh path loses loudly with a nonzero status and publishes nothing, instead of silently replacing the winner (RE-1).
  - Outside the Project, the parent directory must exist, and an existing regular file is the documented overwrite case.
  - External destinations are written by **destination-entry atomic replacement**: a temp file in the destination directory, renamed over the target. The rename swaps the directory entry and never writes through the target's inode, so an external hardlink alias onto Project state (e.g. a hardlink to `ply.json`) keeps its original bytes; the temp file is cleaned up on failure.
  - The reported output path is the caller-chosen path verbatim; realpaths are only containment guards.

### Render history & replay (#87, US-007)

#### Capture

Every successful `ply composition render` retains a Project-owned Render manifest under the Project's `renders/` directory — whatever PNG destination the caller chose (`--out` included; no duplicate PNG bytes are retained for external exports). The manifest records identities only:

```json
{
  "schemaVersion": 1,
  "composition": "poster",
  "canvas": { "width": 1080, "height": 1080 },
  "environment": {
    "tool": { "name": "ply", "version": "2.10.0" },
    "runtime": "bun 1.4.0",
    "browser": "chromium 151.0.7922.34",
    "platform": "darwin-arm64"
  },
  "output": "renders/poster-mtxa1b2c-3d4e5f60.png",
  "createdAt": "2026-09-08T12:00:00.000Z",
  "layers": [
    { "name": "background", "layerId": "layer_01j7abc123", "revisionId": "rev_e3b0c44298fc1c14" }
  ]
}
```

- **One home per fact**: revision facts (kind, placement, opacity, text fields, `contentHash`) stay in the immutable revision documents; content identity stays in their `contentHash`. The manifest pins `layerId` + `revisionId` per ordered use, plus the canvas and environment. `layers[i].revisionId` is the content-derived revision id the render resolved.
- **Relocation-proof by construction**: the manifest carries no filesystem path that replay depends on. `output` is informational only — the project-relative form for in-Project destinations, the caller-chosen path verbatim for external ones — and replay works without the original PNG.
- **No-mix invariant**: the manifest is built strictly from the one locked snapshot the paint used (`readCompositionInternalFull`) — capture never re-consults Project state, so an edit committed between snapshot release and publication cannot mix revisions into the published manifest+PNG pair (deterministic `--preload` lock-gate evidence).
- **Publication discipline — no reported-success Render without history**: all fallible preparation (paint, environment capture) precedes publication; the manifest is created (O_EXCL, fresh never-colliding `renders/<render-id>.manifest.json`) before the PNG is published. If output publication fails, only the freshly created manifest is removed — never a preexisting or concurrently-winning file. **Honest crash limits**: no multi-file atomicity is promised — abrupt termination can leave a manifest without its PNG (replay still regenerates the pixels from retained inputs) or an unreferenced artifact; the interrupted-operations notes in §5 apply.

#### Environment identity & compatibility

The environment is captured inside the same paint pass that produced the pixels: tool name+version, Bun runtime version, platform (`os-arch`), and the actual browser used to paint. Replay requires an **exact match on every field** and rejects a mismatch before any output is published (exit 1, actionable diagnostic naming both identities). This is a conservative boundary: byte-identical replay is guaranteed within one environment, and is **not claimed universally** across machines that merely report equal version strings.

#### Replay

`ply composition replay <manifest-path> [--out <path>]`:

- The manifest must live inside the Project, outside reserved input storage (`compositions/`, `layers/`, `content/`) — render history lives in `renders/`, and relocation moves manifest and Project together.
- **Historical resolution never consults current state**: every pinned use resolves through the one canonical revision-only reader (`readRevisionInternalFull` in `src/layer.ts`, factored from `readLayerInternalFull`'s validation): the exact revision document is validated and re-hashed to its pinned revision id, and its retained content blob is read and re-hashed to its `contentHash`. Layer identity pointers (`layers/<id>.json`) and Composition documents (`compositions/*.json`) are never read, so in-place edits, fork edits, use removal, and reordering cannot invalidate retained history.
- Pinned identifiers are strictly validated **before** any filesystem path is constructed from them (`layers/[0-9a-f]{16}` revision ids and `layer_[a-zA-Z0-9_]+` identities).
- **Fail-loud boundaries** (exit 1, actionable diagnostic, no output published, no resolution to current or newer content): manifest not found, malformed JSON, unsupported `schemaVersion`, invalid pinned identifiers, missing pinned revision document, corrupted revision document (contents re-hash to a different id), missing content blob, corrupted content blob (hash mismatch), and environment mismatch.
- Default replay output is a fresh, never-colliding `renders/<composition>-<unique>.png`; `--out` follows the identical destination policy as render. A successful replay retains its own manifest under the same publication discipline (its manifest pins the same historical revisions; its `output` names the replay's PNG).
- Replay works after Project relocation, deletion of external source files, and deletion of the original PNG. Offline behavior follows US-006: resolution and painting are local (embedded data URLs, retained font bytes); #88 owns the full-surface OS-level isolation qualification.

---

## 7. CLI Commands & Output Contract (US-008)

All commands support `--project <path>` (or `-p <path>`) and `--json`.

- `ply project init [dir] [--name <str>] [--json]`
- `ply project inspect [options] [--json]`
- `ply composition create <name> --width <w> --height <h> [options] [--json]`
- `ply composition add <comp> <local-name> (--image <path> | --text <str> --font <family> [--font-size <px>] [--color <hex>]) [--x <x>] [--y <y>] [--opacity <op>] [options] [--json]`
- `ply composition import <target> <source> [--from-project <path>] [options] [--json]`
  - Without `--from-project`, both Compositions live in the destination Project and import reuses shared Layer identities (#84).
  - With `--from-project <path>`, the source Composition resolves in the other Project and its Layers are copied as independent destination identities with retained bytes (#86). A source path resolving to the destination Project is refused with same-Project guidance.
- `ply composition remove <comp> <use-name> [options] [--json]`
- `ply composition reorder <comp> --order <name1,name2,...> [options] [--json]`
- `ply composition inspect <name> [options] [--json]`
- `ply composition render <name> [--out <path>] [options] [--json]`
  - Every successful render also retains a Project-owned manifest under `renders/` pinning the exact historical inputs (#87).
- `ply composition replay <manifest-path> [--out <path>] [options] [--json]`
  - Replay a retained Render manifest from pinned history; requires the exact capturing environment (#87).
- `ply composition list [options] [--json]`
- `ply layer inspect <layer-id> [options] [--json]`
- `ply layer edit <layer-id> [--in-place | --fork --composition <comp> --use <local-name>] [--image <path> | --text <str> [--font <family>] [--font-size <px>] [--color <hex>]] [--x <x>] [--y <y>] [--opacity <op>] [options] [--json]`
- `ply layer list [options] [--json]`

### Status & Error Codes:
- **0**: Success.
- **1**: Runtime error (missing project, invalid image, duplicate name, unknown use name, invalid reorder permutation, etc.). Structured error JSON in `--json` mode. `composition render` and `composition replay` emit their JSON — success and failure — on stdout, so callers can parse it regardless of exit status. Browser teardown failure also exits with status 1: the already-emitted command result remains unchanged on stdout (including valid JSON in `--json` mode), while stderr reports the separate lifecycle failure and recovery guidance, including the render's exact published outcome (output already written to the reported path, or no output published). For a successful mutation the diagnostic explicitly says it is already committed and must not be retried; teardown failure does not trigger rollback or mutation retry. Consumers must check exit status and stderr as well as the command-result JSON's `ok` field.
- **2**: Usage error / malformed flags / missing required options. Structured error JSON in `--json` mode.
