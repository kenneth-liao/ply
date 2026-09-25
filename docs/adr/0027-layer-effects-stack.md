# ADR-0027: Layer shadow and outline stack — one field, one fold

- Status: Accepted — stacking ships in
  [spec #285](https://github.com/kenneth-liao/ply/issues/285) ticket #302
  (US-011, ISC-50), superseding the one-effect-per-type rule of
  [ADR-0018](0018-layer-shadow-is-a-canonical-revision-effect.md) and
  [ADR-0019](0019-layer-outline-is-a-canonical-revision-effect.md).

## Context

ADR-0018 and ADR-0019 gave a Layer revision exactly one `shadow` and one
`outline`. A title that needs a glow and two drop shadows — or two nested
outline rings — could not carry them: setting a second effect replaced the
first. The #297 text-runs precedent settled the storage question in
general: a revision fact that can be plural stores ONE canonical fold in
one field, where the single form keeps today's shape and several become a
list in the same field, and every reader works on the normalized list from
one ingestion point. DEC-006 names ADR-0018 and ADR-0019's single canonical
shadow and outline as the decision this supersedes.

## Decision

A Layer's `shadow` and `outline` fields stack. The field is the ONE home
for the Layer's effects of that type — no `shadows[]` sibling, no second
representation (DEC-005):

- **Stored fold.** One effect stores today's single object
  (`shadow: {dx,dy,blur,color}`); two or more store a list in the SAME
  field, in paint order. A stored length-1 list is a second answer for the
  same fact — the object form IS the one-effect shape — so it is a
  malformed document, refused loudly (the #297 precedent). Absence IS the
  no-effect form; removal drops the field.
- **One ingestion point.** The stored normalizers
  (`normalizeStoredShadow`, `normalizeStoredOutline`) accept both forms and
  return the normalized LIST; the resolved revision carries the lists, and
  every reader — paint, measure, inspect, review, reach, hash — consumes
  them. One storage fold (`storedEffectStack`) is the single direction back
  from the resolved view to a stored document, so an edit that leaves one
  effect collapses to the object form and a cross-Project copy stays
  byte-identical to its source's stored shape.
- **CLI grammar.** `--shadow` and `--outline` are repeatable on both
  surfaces: N occurrences in command order set the whole stack — an
  absolute setter that replaces any previous stack. One occurrence is
  today's behavior. `--shadow none` / `--outline none` (a single
  occurrence) removes the whole stack; an omitted option preserves it;
  `none` cannot combine with value occurrences (a boundary-parse refusal,
  exit 2). Validation stays through the one parsers `parseShadowSpec` /
  `parseOutlineSpec` per occurrence.
- **Revision identity.** The hash appends the field only when present, as
  before: a single effect's field string is byte-identical to the
  pre-#302 form, so existing revisions keep their exact ids and paint
  (TEST-003). A stack appends its entries inside the same `:shadow(...)`
  / `:outline(...)` field, `;`-joined in paint order.
- **Which types stack.** `shadow`, `outline`, and — joined by this ADR's
  rule in #303 (spec #285 US-011, ISC-64) — `innerShadow`. Glow stays
  a single fact (its #301 change was direction, not count), as do blur,
  choke, feather, grade, and blend.
- **Joining rule for future effect types (#303 inner shadow and beyond):**
  a new stacking effect type joins by adding ONE field with this fold, ONE
  stored normalizer, ONE chain position in the documented ADR-0024 paint
  order, ONE reach term in `localEffectReachPx`, and ONE hash field — the
  same five registrations every effect fact already takes. No second
  field, no second reader. #303's inner shadow is the first type to join
  through this rule, and its reach term is ZERO (the #300 edge-step
  precedent: the atop composite keeps the alpha exactly the input's, so
  the inner-shadowed ink never exceeds the unshadowed ink — proven by the
  ISC-64 extent-unchanged probe).

## Paint ordering

The cross-type chain order is unchanged (ADR-0024): edge step, glow, then
outlines, then shadows, then blur. Within a type, stored (command) order
is filter-function order, and CSS filter-list chaining gives the geometry
— each later function operates on the composite accumulated by the
earlier ones:

- **Outline stack:** each entry is its referenced `feMorphology` dilate
  def (deterministic id: the pair and Layer index, plus the entry's stack
  position from the second entry on, so a single outline's markup is
  byte-identical to the pre-#302 form). Entry k dilates the alpha the
  earlier entries accumulated and floods its color under that composite,
  painting nested rings: the first-listed hugs the content, later ones
  sit outside it. Box structuring elements add exactly
  (`content ⊕ sq(w1) ⊕ sq(w2) = content ⊕ sq(w1+w2)`), so painted ink
  stays derivable from the facts alone. Each entry's filter region is
  sized in-page from the element's untransformed box expanded by the
  ACCUMULATED reach through that entry — a per-entry pad would let
  Chromium clip the outer rings.
- **Shadow stack:** one `drop-shadow` function per entry, in stored
  order — the first is cast from the outlined composite, each later one
  from the ink accumulated before it.

- **Inner-shadow stack (#303, spec #285 US-011, ISC-64, DEC-005):** one
  referenced SVG-filter def per entry (deterministic id: the entry's facts
  and Layer index, plus the entry's stack position from the second entry
  on, so a single inner shadow's markup is byte-identical to a one-effect
  form), in the chain position between the glow and the outlines. Each
  entry offsets and blurs the input's alpha, takes the band as the input
  alpha MINUS the shifted, blurred alpha (`feComposite operator="out"` —
  the reverse operand order would select pixels outside the shape, which
  the atop composite then erases), floods its colour into the band, and
  composites ATOP the input graphic. Porter-Duff atop keeps the
  composite's alpha EXACTLY the input's, so the effect darkens pixels just
  inside the alpha edge without altering coverage. The offset direction
  follows the CSS inset box-shadow convention: the band appears along the
  edge the offset moves AWAY from (dy +4 darkens the top inside edge, dx
  +4 the left inside edge; 0,0,blur rings all inside edges). Stacked
  entries chain in stored order, each darkening the composite the earlier
  ones accumulated — and because every entry's output preserves the
  input's alpha exactly, the outline dilate and drop-shadow casting
  geometry downstream are provably unchanged by the inner shadow's
  presence.

**Reach stays the ONE additive helper.** `localEffectReachPx` sums over
every stacked effect — Σ outline widths + Σ per-shadow `|dx| + |dy| +
2·blur` + the blur term — the same additive list the chain's function
order builds. Because the perspective publication gate reads the same
helper, the gate sees every stacked effect; a stacked Layer's full extent
is captured or the measurement is refused loudly, never silently clipped.

**Reports are lists.** `composition measure`'s `effects` facts,
`layer inspect`, and `layer review` report each effect of a type as the
normalized list, in paint order, even for one effect — consumers read one
shape. This changes the `--json` output of `measure`, `inspect`, and
`layer review` for effect-bearing Layers (a one-effect Layer now reports a
one-element list): a breaking change, shipped in 7.0.0.

## Consequences

- Stacked effect facts are revision facts shared as a whole (DEC-002,
  ADR-0013): in-place edits propagate them, forks isolate them,
  cross-Project copies preserve them verbatim (a one-element list folds
  back to the object form, so copies of legacy revisions keep their exact
  stored shape), and pinned Render history replays byte-identically.
- Retained source bytes, hashes, and lineage never change (DEC-005): the
  effects are paint-time, never baked into content. Removing a stack with
  the documented removal values restores the effect-less render
  byte-for-byte (TEST-002).
- The stack joins the property × kind matrix, the add/edit refusal parity
  tests and their option-enumeration guards, and the offline
  reversibility and replay suite (TEST-002).
- Single-effect revisions — the entire pinned history — keep their exact
  document shape, revision ids, and paint (TEST-003). A rollback to a
  pre-#302 binary reads single-effect documents normally; a STACKED
  revision document's list-valued field is not the object the older
  binary's normalizer expects, so it fails its checks loudly (fail-closed,
  the ADR-0019 PROD-2 pattern) — the remediation is the same
  before-reverting edit: collapse each stack with a single-occurrence
  `--shadow`/`--outline` edit, which publishes the pre-#302 stored form.
- Anchored placement still resolves against the PRE-EFFECT ink (DEC-002,
  ADR-0017 amendment #288): a stack never moves a stored placement, and
  `--anchor` still refuses to combine with `--shadow`/`--outline` in one
  edit.
