# ADR-0013: Layer sharing is project-scoped

- Status: Accepted — target design; not yet implemented

A caller-selected Project owns its compositions, layers, generated content, and render history. Live layer sharing is confined to that Project; importing from another Project or a caller-managed library creates an independent local layer identity and copies the content needed to use it. This keeps Projects movable and self-contained rather than dependent on a global mutable library.

## Addressing and revisions

A stable layer ID identifies an editable layer within a Project. A composition-local name addresses a use of that layer; names and filesystem locations are not its shared identity. The whole layer is shared, not just its image content: placement and effects are not implicit per-composition overrides.

An in-place edit preserves the layer ID and advances its current immutable revision. A fork creates a new ID and changes only the forking composition's reference. Render manifests pin immutable revisions and all required content, so later edits do not change a shipped render. Referenced revisions and content must remain available for reproduction.

Content hashes identify revisions, not mutable layers. This extends ADR-0002's content-derived identity principle; it does not change that ADR's existing asset-resolution behavior retroactively. Retaining historical content is new machinery, not a guarantee provided by the current hash-pin verification alone.

## Project state and reference discovery

Project-owned state stays inside the Project, including its layer identities and immutable content store. Global configuration holds settings; global caches hold replaceable downloads, not authoritative Project state. Exact directory names are not decided here.

Composition documents are authoritative for layer references. Before an edit, Ply scans the Project's compositions to identify referrers; a future index may accelerate discovery but must be rebuildable. A global reference counter was rejected because ordinary filesystem copies, deletions, and edits can make it stale.

More than one referring composition requires an explicit `--in-place` or `--fork`; refusal reports the affected compositions and their count. Exactly one referrer needs no flag. Ply's own mutations use a Project-level lock spanning reference discovery and mutation. This lock does not coordinate arbitrary external filesystem writers.

## Consequences

Editing a library source does not update previously imported Projects. Cross-project live propagation is deliberately unsupported. The Project is the complete reference-discovery boundary, not an arbitrary collection of files anywhere on disk.
