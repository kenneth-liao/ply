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
  migration has shipped by spec #172 (#177, #178, #180, #181).
  Do not remove existing gates in a docs pass.
- The AP kit-managed `visual-authoring` skill owns relocated authoring knowledge
  (Workspace source, installed to every bound host by `apkit install`).
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
  invocation. Per-file `--isolate` is **required**: module-mock tripwire tests
  (added in #104–#107) mock a module for the whole `bun test` process and are
  never undone, so any other test file that imports the mocked module fails in
  a shared process. The per-file topology predates that (#27, Bun's CDP-pipe
  defect oven-sh/bun #15679, fixed in Bun 1.4.0) and is now load-bearing for
  module isolation, not just process separation. The shared render page (`src/browser.ts` withRenderPage)
  serializes and self-heals; a hung or crashed run is worth reporting, not
  silently re-running.
- Model costs: measure from real Gateway billing (`✓` figures only) — never copy from price tables.
- The tool must keep working offline for everything except generation itself.
  Creator isolation is local inference (BiRefNet Dynamic on PyTorch/MPS,
  ADR-0020): weights are cached under `models/` (gitignored), pinned by
  sha-256 in `src/segment.ts`, and never loaded by the default suite — tests
  inject a fake `MatteEngine`. The weight-backed live checks
  (`test/matting-live.test.ts`, the live block in `test/segment.test.ts`)
  run only with `PLY_RUN_LIVE=1` (`bun run test:live`) and skip otherwise,
  even with a warm weights cache.
- Final composition stays local. ADR-0014 allows caller-chosen text pixels;
  the category-specific generation gates were retired with their commands
  (#114) — the caller's own policy lives in the consuming repositories and
  the visual-authoring skill. The numeric YouTube region baseline left
  `src/` (#176): the legacy Scene machinery reads its rectangles from
  `examples/youtube-regions.json` through the single region ingestion
  point. Do not present the accepted
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
  the AP kit-managed `visual-authoring` skill and the consuming repositories.
  Legacy generated-asset adoption is retired (#115, #114): legacy `jobs`
  records remain inspectable and reviewable only, and generated or matted
  content enters Projects as ordinary Layers, never the asset library.
- Design decisions and their rationale: `docs/adr/`.
