# ADR-0018: Layer shadow is a canonical revision effect painted before transform

- Status: Accepted — the shadow command and its revision fact shipped in
  [spec #132](https://github.com/kenneth-liao/ply/issues/132) ticket #139.

## Decision

A Layer revision's shadow — an optional `shadow` object `{ dx, dy, blur,
color }` — is the one canonical shadow representation (DEC-002, DEC-006).
The command `ply layer edit --shadow "<dx>,<dy>,<blur>,<color>"` sets an
**absolute** shadow that replaces any previous one (`--shadow none`
removes it, in the #135 flip style), and an omitted option preserves the
current revision's shadow. Parameter bounds: `dx`/`dy` finite within
±256 px (negative valid), `blur` a px radius between 0 and 256, `color` a
hex color `#RGB`/`#RRGGBB`/`#RRGGBBAA` — alpha softens the shadow. The
bounds keep the effect footprint bounded so painted-extent capture stays
bounded; DEC-006 forbids a general filter framework, and #140 adds
`outline` beside this field without reworking it.

**Present ⟺ a shadow exists.** Absence IS the canonical no-shadow form:
removal drops the field, and every reader treats absence as none — there
is no second "no shadow" representation. The revision hash appends the
field only when present, so revisions written before #139 keep their exact
ids and paint meaning (the #133/#134/#135 compat pattern).

## Paint ordering

The shadow applies to the Layer's content in its **LOCAL coordinate
space**, before the canonical transform: paint emits
`filter: drop-shadow(dx dy blur color)` on the Layer element alongside the
`rotate∘flip∘scale` transform, so the transform maps content and shadow
together, the Layer's opacity fades both, and canvas clipping applies to
the shadow-extended result. A rotated Layer's shadow rotates with it. The
effect is uniform over image alpha and text glyphs (one CSS property, no
kind-specific lifecycle), and is emitted only when a shadow exists, so
pre-#139 revisions and their pinned Render history paint exactly as
before.

## Painted bounds and anchored placement

The #137 ink pass screenshots the paint-identical markup, so the shadow's
ink is part of the measured `painted` extents by construction —
`paintedOnCanvas` and `clipped` inherit the extension. The capture window
is widened by the Layer's **shadow reach** — `|dx| + |dy| + 2·blur`, the
documented margin over the CSS blur radius's ~1.5× visible extent —
derived from the revision fact alone, so a shadowed Layer's full extent is
captured or the measurement is refused loudly, never silently clipped.

**Anchored placement resolves against the shadow-extended painted ink.**
There is one definition of painted ink (DEC-004) and no second anchor-box
home: the shadow is part of what is visible, so `--anchor` centers the
composite (content + shadow). Because anchoring is one-shot (ADR-0017), a
shadow edit never moves an already-resolved placement — the documented
consequence is that anchoring with a shadow lands the composite at the
target, and anchoring first then adding a shadow keeps the resolved x/y
literally. `--anchor` and `--shadow` refuse to combine in one edit: the
anchor would resolve different ink than the edit publishes (the same
precedent as transform edits).

## Consequences

- Shadow facts are revision facts shared as a whole (DEC-002): in-place
  edits propagate them, forks isolate them, cross-Project copies preserve
  them verbatim, and pinned Render history replays byte-identically.
- Retained source bytes, hashes, and lineage never change (DEC-005): the
  shadow is paint-time, never baked into content.
- Validation uses one parser (`parseShadowSpec`) at both boundaries, so
  the CLI's usage-error classification (exit 2, the `--opacity`/`--resize`
  value-range convention) and the edit path's pre-staging refusal can
  never disagree — nothing invalid reaches the edit path.
- Outline (#140) extends the same contract: a sibling revision field, the
  same ordering documentation, and a combined effect-extent measurement.
