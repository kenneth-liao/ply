/**
 * Operation × Layer-kind matrix coverage audit for #145 (spec #132, TEST-002).
 *
 * The connected qualification (test/connected-editing-offline.test.ts) owns
 * only the COMBINED interaction of the new capabilities — US-006's connected
 * outcome. Each individual operation × Layer-kind cell is owned, with its own
 * retention, sharing/history, and invalid-input evidence, by the predecessor
 * suite below; this audit records that ownership and fails loudly if a cited
 * predecessor suite goes missing, instead of duplicating its tests.
 *
 * | Operation (canonical edit)      | Image Layer evidence | Text Layer evidence            | Owning suite                  |
 * | ------------------------------- | -------------------- | ------------------------------ | ----------------------------- |
 * | relative resize (--resize)      | "image Layer --resize advances revision" | "text Layer resizes by factor, refuses --resize-to" | test/layer-resize.test.ts |
 * | absolute resize (--resize-to)   | "--resize-to normalizes to scale with documented aspect-ratio behavior" | (refusal owned by the same text test) | test/layer-resize.test.ts |
 * | rotation (--rotate)             | "image Layer --rotate sets an absolute angle" | "text Layer rotates and keeps its retained font bytes" | test/layer-rotate.test.ts |
 * | reflection (--flip)             | "image Layer --flip sets an absolute reflection state" | "text Layer flips vertically / horizontally" | test/layer-flip.test.ts |
 * | layout/content measurement      | "measure reports an identity image Layer's layout box" | "text measurement uses the retained face" | test/composition-measure.test.ts |
 * | painted bounds / padding        | "measure reports painted extents separately from layout boxes" | "text painted extents are tight glyph ink" | test/composition-measure.test.ts |
 * | canvas clipping                 | "canvas clipping is judged against painted extents" | (same seam, both kinds) | test/composition-measure.test.ts |
 * | anchored placement (--anchor)   | "image Layer --anchor center,center resolves placement" | text anchor tests in the same suite | test/layer-anchor.test.ts |
 * | shadow (--shadow)               | "image Layer --shadow paints drop-shadow pixels" | "text Layer --shadow paints at the glyph ink" | test/layer-shadow.test.ts |
 * | outline (--outline)             | "image Layer --outline paints outline pixels" | "text Layer --outline paints at the glyph ink" | test/layer-outline.test.ts |
 * | placement/opacity editing       | "single-referrer image Layer edit advances revision" | "single-referrer text Layer edit advances revision" | test/layer-edit.test.ts |
 * | explicit fork isolation         | "fork-editing a shared image Layer" | "text fork follows the same identity rules" | test/layer-fork.test.ts |
 * | shared propagation / refusers   | "multi-referrer Layer edit without --in-place fails" | (same seam, both kinds) | test/layer-edit.test.ts |
 * | transform/effect lineage retention | "resizes never touch retained generation lineage" (rotate/flip analogues in their suites) | (same seam) | test/layer-resize.test.ts et al. |
 * | pinned replay / relocation      | "replay survives Project relocation and deletion of external source files" | "capture covers text Layers with their pinned revisions" | test/render-history.test.ts |
 * | nano-2 default / GPT quality (US-005, not this workflow's cells) | — | — | test/generation-cli.test.ts, test/quality-selection.test.ts |
 *
 * The combined cells this suite alone owns: resize+anchor+shadow on real
 * retained evidence in one lifecycle, sharing/forked variation across a
 * non-thumbnail Composition, and the offline/deletion/relocation/replay
 * continuation under kernel network denial.
 */
import { expect, test } from "bun:test";
import path from "node:path";

const audit: Array<{ suite: string; markers: string[] }> = [
  {
    suite: "layer-resize.test.ts",
    markers: [
      "image Layer --resize advances revision, keeps content bytes",
      "--resize-to normalizes to scale with documented aspect-ratio behavior",
      "text Layer resizes by factor, refuses --resize-to",
      "resizes never touch retained generation lineage or source bytes",
    ],
  },
  {
    suite: "layer-rotate.test.ts",
    markers: [
      "image Layer --rotate sets an absolute angle, keeps content bytes",
      "text Layer rotates and keeps its retained font bytes",
      "rotation never touches retained generation lineage or source bytes",
    ],
  },
  {
    suite: "layer-flip.test.ts",
    markers: [
      "image Layer --flip sets an absolute reflection state, keeps content bytes",
      "text Layer flips vertically",
      "text Layer flips horizontally",
      "flip never touches retained generation lineage or source bytes",
    ],
  },
  {
    suite: "layer-anchor.test.ts",
    markers: [
      "image Layer --anchor center,center resolves placement so the painted ink centers on the target",
      "rendered pixels agree with the anchored resolution",
    ],
  },
  {
    suite: "layer-shadow.test.ts",
    markers: [
      "image Layer --shadow paints drop-shadow pixels and keeps content bytes",
      "text Layer --shadow paints at the glyph ink and keeps font bytes",
      "anchored placement uses the shadow-extended ink",
    ],
  },
  {
    suite: "layer-outline.test.ts",
    markers: [
      "image Layer --outline paints outline pixels and keeps content bytes",
      "text Layer --outline paints at the glyph ink and keeps font bytes",
      "outline paints before the shadow; the shadow is cast from the outlined composite",
    ],
  },
  {
    suite: "layer-edit.test.ts",
    markers: [
      "single-referrer image Layer edit advances revision in-place",
      "single-referrer text Layer edit advances revision in-place",
      "multi-referrer Layer edit without --in-place fails with exit 1",
      "layer edit succeeds after Project relocation",
    ],
  },
  {
    suite: "layer-fork.test.ts",
    markers: [
      "fork-editing a shared image Layer from B publishes a new identity and retargets only B",
      "text fork follows the same identity rules, preserves retained font bytes offline",
    ],
  },
  {
    suite: "composition-measure.test.ts",
    markers: [
      "measure reports an identity image Layer's layout box at its intrinsic size and placement",
      "text measurement uses the retained face and agrees with painted pixels",
      "measure reports painted extents separately from layout boxes",
      "text painted extents are tight glyph ink that agrees with rendered pixels",
      "canvas clipping is judged against painted extents, never the layout box",
    ],
  },
  {
    suite: "render-history.test.ts",
    markers: [
      "capture covers text Layers with their pinned revisions and font content identity",
      "replay survives Project relocation and deletion of external source files",
    ],
  },
  {
    suite: "generation-cli.test.ts",
    markers: ["omitting --model sends nano-2 outbound and retains it as effective provenance"],
  },
  {
    suite: "quality-selection.test.ts",
    markers: [
      "each qualified tier is forwarded and retained as request and run provenance",
      "an unsupported combination fails before any provider call",
    ],
  },
];

test("the operation × Layer-kind matrix is owned by the cited predecessor suites", async () => {
  for (const row of audit) {
    const file = path.resolve(import.meta.dir, row.suite);
    const source = await Bun.file(file).text(); // missing file throws: fails loudly
    for (const marker of row.markers) {
      expect(source.includes(marker), `${row.suite} must still own: ${marker}`).toBe(true);
    }
  }
});
