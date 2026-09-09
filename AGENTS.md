# Ply — agent instructions

## Documentation and migration boundary

- `ISA.md` owns the accepted destination, claims, fog, and progress; it is not
  an implementation spec. Do not duplicate its backlog in other documents.
- `CONTEXT.md` defines the composer vocabulary. The shipped Project/Layer/
  Composition foundation coexists with the preserved legacy Scene/Job surface;
  `README.md` documents both.
- ADR-0013's Project-scoped sharing and retained Render history are shipped
  by spec #77. ADR-0014's uniform generation and caller-owned content policy
  and ADR-0015's independent Matting are shipped by spec #102, including the
  #114 retirement of the category-specific generation entry points
  (`jobs plates|objects|creators|rerun`); ADR-0014/0015's region-gate
  migration remains a target decision. Do not remove existing gates in a
  docs pass.
- `.agents/skills/visual-authoring/SKILL.md` owns relocated authoring knowledge.
  It must be committed before any gate deletion (ISC-27).
- This repository's instructions take precedence over stale generated profile
  context under `.agent-profile-kit/`; do not hand-edit generated profiles to
  encode repository documentation policy.

## Agent skills

### Issue tracker

GitHub Issues via the best available GitHub interface (`gh` as portable fallback). Claim work with
`gh issue edit <number> --add-assignee @me`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default roles mapped 1:1: category `bug`/`enhancement`, artifact `spec`, readiness/disposition
`needs-triage`, `needs-info`, `ready-for-tickets`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

## Conventions

- `bun`, not npm. `uv`, not pip.
- Tests: `bun run test` — every test file runs in its own `bun test --isolate`
  invocation. One browser-backed suite per process is the stable shape; the
  per-file topology is green on both Bun 1.3.14 and ≥1.4.0. The underlying
  single-process deadlock (#27) was Bun's CDP-pipe defect (oven-sh/bun #15679,
  fixed in Bun 1.4.0): on Bun ≥1.4.0 a bare single-process `bun test` over the
  whole suite is verified 10/10, so `--isolate` is defense-in-depth (module
  isolation), not a flake mask. On Bun 1.3.14 the single-process topology
  still hangs (~60% of runs) — upgrade with `bun upgrade` before trusting a
  bare `bun test`. The shared render page (`src/browser.ts` withRenderPage)
  serializes and self-heals; a hung or crashed run is worth reporting, not
  silently re-running.
- Model costs: measure from real Gateway billing (`✓` figures only) — never copy from price tables.
- The tool must keep working offline for everything except generation itself.
  Creator isolation is local inference (BiRefNet via `onnxruntime-node`,
  ADR-0006): weights are cached under `models/` (gitignored), pinned by
  sha-256 in `src/segment.ts`, and never loaded by the unit suite — tests
  inject a fake `MatteEngine`, and the live check in `test/segment.test.ts`
  skips when the weights are absent.
- Final composition stays local. ADR-0014 allows caller-chosen text pixels;
  the category-specific generation gates were retired with their commands
  (#114) — the caller's own policy lives in the consuming repositories and
  the visual-authoring skill. The numeric YouTube region baseline stays
  until its separately scoped migration. Do not present the accepted
  destination as already shipped.

## Rendering gotchas

If you change `src/scene-render.ts`, **look at the output image** — these bugs
can be invisible in logs:

- Nested double quotes inside an HTML `style="..."` attribute truncate
  silently. Prefer stylesheet rules or carefully escaped attributes.
- A block element's `getBoundingClientRect().width` is the container width;
  to detect font fallback, measure an inline element.
- CSS selectors aimed at one path group can hit SVG marker paths too. Scope
  selectors precisely.
- `vector-effect: non-scaling-stroke` makes `stroke-width` mean CSS pixels;
  fractional widths go sub-pixel and vanish. Connectors use pixel-space SVG.
- In batch renders, check the output file list, not just timing.
- An `@font-face` rule inside a `:root {}` block is invalid CSS and ignored.
  Font-face rules go at the stylesheet's top level, and the render probe must
  re-verify that each requested family resolves.

## Assets and provenance

- Generation references are arbitrary local image files supplied by the
  caller. Preserve their order, derive their sha-256 identities once at Job
  creation, and verify/read their bytes once at generation.
- Generation has no subject categories, mandatory identity References, or
  likeness gates (ADR-0014, #114): those are caller policy, preserved in
  `.agents/skills/visual-authoring/SKILL.md` and the consuming repositories.
  Legacy generated-asset adoption is retired (#115, #114): legacy `jobs`
  records remain inspectable and reviewable only, and generated or matted
  content enters Projects as ordinary Layers, never the asset library.
- Design decisions and their rationale: `docs/adr/`.
