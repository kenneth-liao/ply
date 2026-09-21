# Pre-spec Render fixture (#260, spec #226 A226-003)

A minimal Project whose Render was captured by Ply **4.23.0** — the last
pre-#226 release — to prove that the #226 delivery left retained Renders
unchanged: current code repaints this manifest byte-identically, and
`composition replay` still refuses the unmodified manifest because the
recorded Ply version differs (the ISC-14 recorded-environment gate,
unchanged).

## Provenance

| Fact | Value |
| --- | --- |
| Recording commit | `e0e126b` (merge of PR #204; base of PR #236, the first #226 PR) |
| Recording version | Ply `4.23.0` (package.json at that commit) |
| Recording date | 2026-09-21 (UTC) |
| Recorded environment | tool `ply 4.23.0`, runtime `bun 1.4.0`, browser `chromium 151.0.7922.34`, platform `darwin-arm64` |

The Project was built inside a temporary detached checkout of `e0e126b`
(`git worktree add --detach`, removed afterwards) with its own
`bun install`, so the paint ran exactly that release's code.

## Commands used (run in the e0e126b checkout)

```sh
bun -e 'import { encodePngRgba } from "./src/png.ts"; /* 48×36 two-band swatch */'   # → swatch.png
bun run src/cli.ts project init /tmp/ply-fixture-proj --name pre-spec-fixture
bun run src/cli.ts composition create hero --width 320 --height 240 --project /tmp/ply-fixture-proj
bun run src/cli.ts composition add hero backdrop --image swatch.png --x 40 --y 30 --project /tmp/ply-fixture-proj
bun run src/cli.ts composition add hero tagline --text "pre-spec render" --font "Passion One" --font-size 40 --x 60 --y 120 --project /tmp/ply-fixture-proj
bun run src/cli.ts composition render hero --project /tmp/ply-fixture-proj
```

`composition replay` at the recording commit reproduced the committed PNG
byte-identically before the fixture was copied here (sanity check).

## Contents

- `project/` — the captured Project: `ply.json`, the `hero` Composition
  (one image Layer from a tiny 48×36 committed-sourced PNG, one text Layer
  in the bundled Passion One face), their pinned revisions and retained
  content bytes, and the recorded manifest + output PNG under `renders/`.
- The committed PNG `project/renders/hero-mubtt4wv-af1f94e2.png` is the
  exact bytes 4.23.0 published; the test asserts the repaint matches them.

`test/pre-spec-render-fixture.test.ts` consumes this fixture. The test
substitutes only the Ply-version comparison (the manifest carries no
integrity hash over `environment`, so the test rewrites that one field in a
temp copy); runtime, browser, and platform checks stay live and the test
skips with a stated reason if any of them differs from this recording.