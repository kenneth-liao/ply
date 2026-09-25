# ADR-0026: A nested Composition is used as one unit, by live reference

- Status: Accepted — decided by Kenny in the #306 interviews (2026-09-23
  and 2026-09-24) for [spec #285](https://github.com/kenneth-liao/ply/issues/285)
  DEC-009 (US-018, ISC-36). §3 records his answers to the follow-up
  questions, and two choices the delivery orchestrator made within scope
  (marked as such); §4's derived rules were
  written by the agent from those decisions (see Context). Implementation
  is ticket #307; nothing here has shipped.

## Context

A tile, its logo, and its caption should move and turn together with one
edit, while each stays its own editable Layer. ISC-36 asks for several
Layers to be transformed and adjusted as one unit without flattening, and
ISC-5 forbids flattening a Composition in order to reuse it.

Today the only reuse of a Composition is `composition import`, which copies
the source's use list into the target. The Layers stay individual and
shared (ISC-5 holds), but the copies have no link back to the source, and
nothing moves them as one. Placing a group means editing each member.

The ISA deferred the choice between a group primitive and a nested
Composition used as a unit (2026-09-19 decision log). Spec #285 DEC-009
requires an ADR before ISC-36 work starts. Kenny decided the mechanism on
2026-09-23 and the reference semantics on 2026-09-24. A first draft of
this ADR left four questions open (fork depth, fork trigger, unit bounds,
and intent for edits that reach through units); Kenny answered them on
2026-09-24, recorded on #306.

A nested Composition touches several accepted decisions: ADR-0013 (a Layer
is shared as a whole, forks isolate, Renders pin revisions), ADR-0024 and
ADR-0025 (paint order and masks), ADR-0017 (anchors resolve against ink),
and ADR-0022 (supersampling). ISC-14 requires a shipped Render to replay
exactly.

As in ADR-0025, this ADR separates what was **decided** (§1–§3, with
§3's two orchestrator choices marked) from
what the agent **derived** from those decisions and existing invariants
(§4). The derived rules are part of this accepted decision, but a reviewer
or #307 may challenge them without re-opening the interview.

## Decision

### 1. Mechanism: a nested Composition used as a unit (decided)

Several Layers move as one by putting them in their own Composition and
using that Composition as **one unit inside another Composition**. There
is no new group primitive.

The members stay ordinary Layers in the inner Composition. They are
edited there, individually, with every existing command (ISC-5). Nothing
is flattened to make or use the unit.

### 2. Live reference (decided)

- **A unit is a live reference.** Editing the inner Composition, such as
  adding, removing, reordering, or editing a member, updates every place it
  is used.
- **Each Render pins the inner revisions it used.** A retained Render
  replays unchanged after the inner Composition changes (ISC-14).
- **A fork makes an independent copy.** §3 fixes its depth and trigger.

### 3. Follow-up decisions

Kenny answered the four follow-up questions on 2026-09-24 (#306). The
last two items are choices the delivery orchestrator made within scope,
recorded in the same #306 comment; they are not Kenny's.

- **Fork depth: members stay shared.** A forked unit gets a new inner
  Composition whose uses reference the **same member Layers**. An
  in-place member edit still reaches both, under ADR-0013.
- **Fork trigger: `--fork` on an edit of the unit Layer.** The caller must
  supply the name of the new inner Composition. A fork without that name
  is refused.
- **Bounds: the inner Composition's canvas, for now.** The unit's content
  box is the inner canvas. The unit must be stored so that bounds derived
  from its content can be added later without changing existing revision
  ids or Renders. Content-derived bounds would let flow and hug become
  rules on the unit later (#306 comment, from #320).
- **Reach through units needs no extra intent.** An edit that reaches
  Compositions only through units is not refused under ISC-11. Direct
  referrers are counted for the `--in-place` / `--fork` rule as today.
  The transitive reach is reported in the output.
- **Isolated blending (orchestrator choice).** Members blend against each other
  inside the unit, and the unit blends as one Layer against the outer
  backdrop. Pass-through blending is out of scope.
- **Delete refuses while any unit Layer refers to the Composition
  (orchestrator choice).** A Composition that any unit Layer in the
  Project refers to cannot be deleted. "Any" includes a unit Layer that
  no Composition uses at the moment. A later Composition with the same name can therefore never be
  picked up silently. The #290 `composition delete` command gains this
  refusal in #307.

### 4. Derived rules

These follow from §1–§3 and from existing invariants.

#### The unit is a Layer

The unit is a **Layer whose content is a live reference to another
Composition in the same Project**. This document calls it a *unit Layer*.
The outer Composition uses it through an ordinary use with a local name,
addressed as `<composition>/<use>` like any other.

This keeps the CONTEXT.md invariant that a Layer is the only composition
primitive. It also gives the unit a home for its own placement and
effects: ADR-0013 stores those on the Layer, never as per-use overrides.
A group primitive, or facts stored on a use, would break one of those two
rules.

The unit Layer's revision stores the inner Composition's name, not a copy
of its contents or a pinned inner revision. Composition names are the
Composition's identity inside a Project; there is no rename today, and any
future rename must go through the reference checks below. Because the
revision stores only the name, editing the inner Composition does not
advance the unit Layer's revision. The revision is immutable, as ADR-0013
requires, but what it paints is live.

#### Transformed and adjusted as one

The unit Layer takes the Layer facts that apply across Layer kinds
(ISC-37): placement, anchored placement, rotation, flip, scale
(ADR-0016), opacity, visible region (ADR-0023), grade and the effects
(ADR-0024; shadow ADR-0018, outline ADR-0019), blend, and mask
(ADR-0025). Kind-specific facts (text, vector colour, shape geometry) do
not apply. Which facts #307 ships first is its scope; none may be refused
on the unit for being a unit.

- **One edit moves or turns the unit.** `layer edit` on the unit's use
  changes the unit Layer's placement or transform. The members' own
  revisions do not change.
- **The unit paints as one isolated group (§3).** The inner Composition is
  composited at paint time, members in its use order with their own
  facts. That composite is the unit Layer's content: step 1 of the
  ADR-0024 order, as amended by ADR-0025. The unit's own visible region,
  grade, effects, transform, opacity, mask clip, and blend then apply to
  the composite as one Layer, which blends against the outer backdrop
  (ADR-0024 §5). This is how the inner
  Composition composites when rendered on its own, so its members
  composite the same way wherever the unit is used.
- **Painted at the size it appears.** The composite is painted at the
  unit's painted size and the Render's supersample factor (ADR-0022). It is
  never rasterized at the inner canvas size and then resampled, so a
  scaled-up unit stays as sharp as its members. The composite is never
  stored as content; it exists only during painting.
- **Content box.** The unit's content box is the inner Composition's
  canvas (§3). Members outside the inner canvas are cut, as they are when
  the inner Composition renders on its own. Because the bounds must stay
  extensible, a unit Layer revision written today must keep its id when a
  bounds option is added later: the new option is stored only when set,
  and its absence means the canvas.
- **Anchors and measure.** The unit's pre-effect ink (the ADR-0017 anchor
  basis, as amended by #288) is the alpha of the inner composite, cropped
  by the unit's visible region. The members' own effects (their shadows,
  outlines, and glows) are part of that composite, so they count as the
  unit's ink; only the unit's own effects are stripped, as #288 strips a
  single Layer's. Anchoring a unit therefore uses its members' actual
  ink, not the empty canvas around them. `measure` reports
  the unit like any Layer, and reports it as a unit naming its inner
  Composition. Measuring a member means measuring it in the inner
  Composition.

#### Editing and blast radius

- **Editing a member.** A member is edited in the inner Composition under
  the ordinary ADR-0013 rules. The change reaches every Composition that
  uses the unit; that is the live reference (§2). Only direct referrers
  count for the `--in-place` / `--fork` rule (§3). Every edit reports the
  Compositions it reaches **through units**, transitively, next to the
  direct ones, on success and on refusal.
- **Editing the unit.** The unit Layer is shared as a whole (ADR-0013). A
  unit Layer used by several Compositions follows the usual `--in-place`
  / `--fork` rule for its own facts. Because `--fork` also copies the
  inner Composition (§3), placing the same inner Composition differently
  in two outer Compositions while keeping it live is done with two unit
  Layers, one per outer Composition, that reference the same inner
  Composition.
- **Reference discovery.** ADR-0013's referrer scan grows one step: it
  follows unit references transitively for reporting. The Composition
  documents stay authoritative, and any index stays rebuildable.

#### Fork

`layer edit --fork` on a unit Layer, with the required name (§3), does
two things in one publication:

- It forks the unit Layer, as ADR-0013 defines a fork: a new Layer
  identity, referenced only by the forking Composition, carrying the
  edit.
- It creates the new inner Composition under the caller's name, with the
  original's canvas and the same use list: the same use names referring
  to the same Layers. The forked unit Layer's revision refers to the new
  name.

What follows:

- Later changes to either inner Composition's use list (adding,
  removing, or reordering uses) do not reach the other. A member edited
  in place reaches both, because both use it; such a member now has two
  direct referrers, so the ordinary `--in-place` / `--fork` rule applies.
- A unit used inside the original inner Composition is not forked. The
  copy gets a use of the same unit Layer, which still refers to the same
  nested inner Composition, live.
- A fork never changes the original inner Composition, any other
  Composition that uses it, or any retained Render.
- A name that clashes with an existing Composition is refused before
  anything is published, never silently renamed (the rule ADR-0025 §3
  applies to use names). The fork runs the cycle check.

#### Import, relocation, and delete

- **Same-Project `composition import`** copies the source's use list, as
  today. A unit use arrives as a use of the same shared unit Layer, which
  still references the same inner Composition. Nothing else is copied.
- **Cross-Project import (`--from-project`)** must bring every inner
  Composition the copied units reference, transitively. Each copied Layer
  gets an independent destination identity, as ADR-0013 requires, and the
  copied unit Layers reference the destination copies of their inner
  Compositions. That is the relink. An inner Composition reached by
  several paths (units A and B both use C) is copied once, as import
  already copies each distinct Layer once. A Composition-name clash in the
  destination is refused before anything is published. That includes an
  inner Composition an earlier import already copied, so importing a
  second outer Composition that shares it is refused today (see
  Consequences). Cross-Project links stay unsupported: a unit never
  references a Composition in another Project.
- **Relocation** moves the whole Project. Composition names and Layer
  identities are Project-local, so units move unchanged.
- **`composition delete`** (#290) refuses while any unit Layer in the
  Project refers to the Composition (§3). The refusal names each such
  unit Layer, and the Compositions and uses that use it, if any. The
  same check guards any future rename. Retained Renders are unaffected
  either way: they replay from their pins.
- **A unit whose inner Composition does not exist** is refused when
  painted, measured, or rendered, naming the missing Composition. It
  never paints empty as a fallback. This extends the CONTEXT.md invariant
  that unresolved inputs fail loudly.

#### Render pinning and replay

A Render manifest pins everything the unit painted from. That includes
the unit Layer's revision and the inner Composition's resolved state at
render time: its canvas, its use order and names, and every member's
revision and content. Nested units pin recursively. Replay paints from
those pins. It never reads the current inner Composition document, just
as it never reads the current outer one today. A Render with a unit
therefore replays byte-identically after the inner Composition, a member,
or the unit Layer changes, and after relocation (ISC-14).

Manifests written before units carry no nested pins and replay exactly as
they do now.

#### Cycles

A Composition can never contain itself, directly or through other
Compositions.

- **Checked before publication.** The check runs whenever a use of a unit
  Layer is added, whenever a unit Layer's reference is set or changed
  (including in place, across every Composition that uses it), on fork,
  and on import. A cycle is refused, and the refusal names the chain of
  Compositions, such as `a → b → a`. A Composition using a unit of itself
  is the one-step case.
- **Checked again when painting.** A cycle that reaches a document some
  other way, such as a hand edit, is refused when painted, measured, or
  rendered, naming the chain. It is never painted to a fixed depth.
- **Not a cycle:** the same inner Composition used as a unit several
  times, in one Composition or across several.

#### Masks inside and outside the unit

A mask's use name resolves in the Composition being painted (ADR-0025
§1), so the boundary is clear in both directions.

- A member's mask resolves in the inner Composition, among its sibling
  members.
- In the outer Composition, the unit is an ordinary use. It may be masked,
  and it may serve as a mask. Its mask alpha is the alpha of its
  composite, after its transform and visible region.
- A mask never reaches across the unit boundary. That keeps ADR-0025's
  exclusion of masks that reach across Compositions.

## Relationship to accepted ADRs

This ADR amends none of the accepted ADRs' decisions. It constrains how
ADR-0013, ADR-0017, ADR-0022, ADR-0024, and ADR-0025 are applied, and
adds a refusal to the #290 delete.

- **ADR-0013 (Project-scoped sharing) — constrained.** Unchanged: a Layer
  is shared as a whole, revisions are immutable, in-place edits
  propagate, forks isolate, cross-Project copies are independent, and
  Renders pin what they used. What is new:
  - A unit Layer's revision is immutable, but it paints the inner
    Composition's current state.
  - An edit's reach now includes Compositions reached through units. It
    is reported, but it does not count for the `--in-place` / `--fork`
    rule, so the ISC-11 refusal and the CONTEXT.md invariant still count
    direct referrers only.
  - `--fork` on a unit Layer also copies the inner Composition under a
    caller-supplied name. Member Layers stay shared.
  - Cross-Project import brings referenced inner Compositions.
  - Render pins nest.
- **ADR-0024 and ADR-0025 (paint order and masks) — constrained.** The
  order is unchanged. For a unit Layer, step 1's content is the inner
  composite. Masks resolve per Composition and never cross the unit
  boundary.
- **ADR-0017 (anchored placement, as amended by #288) — constrained.** A
  unit's pre-effect ink is its composite's alpha.
- **ADR-0022 (supersampling) — constrained.** The composite is painted at
  the unit's painted size and the Render's supersample factor.
- **#290 `composition delete` — constrained.** It refuses while any unit
  Layer refers to the Composition. #307 adds the refusal.
- **ADR-0014 (uniform Layers) — unchanged.** The unit Layer is a new Layer
  kind that takes the uniform Layer facts; no content-category
  exception is introduced.
- **CONTEXT.md.** The invariant "a Layer is the only composition
  primitive" holds. "Composition reuse ... never requires flattening"
  holds. The vocabulary entry for a unit is added when #307 ships it, not
  before.

## Consequences

- A Composition gains a second reuse path. Import copies a use list once.
  A unit keeps a live link. Both keep members individually editable
  (ISC-5).
- A Layer's painted output can now change without its revision changing.
  Live painting, measurement, and the painted-ink pass resolve the
  current inner Composition. Only replay reads the Render pins. Any
  future cache keyed by revision must include the resolved inner state.
- The unit Layer is a new Layer kind, so it joins the ISC-3 operation ×
  layer-type matrix and the ISC-37 property × kind matrix.
- Painting becomes recursive. The paint, measure, and render paths must
  resolve inner Compositions, carry the supersample factor down, and
  refuse cycles and missing inner Compositions.
- The Render manifest schema gains nested pins. Older manifests stay valid
  and replay unchanged.
- Referrer discovery gains a transitive step for reporting.
- `composition delete` and cross-Project import gain refusals for
  referenced and clashing Compositions. Importing two outer Compositions
  that share an inner Composition into another Project is refused on the
  second import until a later rule recognises an earlier copy.
- Ply has no command that deletes a Layer: `composition delete` and
  `composition remove` keep the Layers they drop. So deleting the outer
  Composition, or removing the unit's use, leaves an unused unit Layer
  that keeps its inner Composition from being deleted for as long as the
  Project exists. Today no command re-adds an existing Layer, so the
  unused unit Layer cannot paint again; the refusal guards any future
  re-add path. A future Layer cleanup would lift the block.
- Out of scope:
  - references to Compositions in another Project;
  - content-derived bounds, and content-driven layout rules on a unit
    such as flow and hug. The picture-it benchmark (#320) and the ISA's
    fog keep these for later; §3 keeps the storage open for them;
  - pass-through blending of members against the outer backdrop (§3).

