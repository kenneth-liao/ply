/**
 * Composition painting — paint a resolved Layer snapshot to PNG bytes through
 * the shared render page (ADR-0013, DEC-001–006, #77 US-006; extracted by #87).
 *
 * This module is the one paint path for both current-state rendering
 * (`composition render`, #80) and historical replay (`composition replay`,
 * #87): given a canvas and a resolved Layer snapshot — exact verified bytes
 * plus discriminated revision metadata — it produces PNG bytes at exactly the
 * canvas dimensions. It never reads Project state; callers own resolution.
 *
 * Paint contract: Layers paint in reference-list order — later Layers paint
 * over earlier ones — at each revision's stored position (x, y) and opacity in
 * [0, 1], at the retained content's intrinsic size, clipped to the canvas.
 * A revision's shadow (#139, ADR-0018) applies to the content in its LOCAL
 * coordinate space (image alpha or text glyphs alike) before the canonical
 * transform, which maps content+shadow together, and the Layer's opacity
 * fades both.
 * Areas no Layer covers stay transparent. Text Layers (#81) paint as DOM text
 * with their retained font bytes declared under an internal @font-face
 * family (never re-consulting assets/fonts/), and every text layer's family
 * is probed for actual load/resolution after page load — an unresolved face
 * or unavailable font fails the render before any output is produced.
 *
 * The same paint callback also captures the rendering-environment identity
 * (#87): the tool, runtime, platform, and the actual browser used to paint.
 * Replay requires an exact match on this identity, checked after the paint
 * pass and before any output is published.
 */
import { withRenderPage } from "./browser.js";
import { familyResolved } from "./fonts.js";
import type { Page } from "playwright";
import { toolIdentity } from "./manifest.js";
import type { ResolvedLayerRevision } from "./layer.js";

const MIME: Record<"png" | "jpeg" | "webp", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * A resolved snapshot layer: the exact verified bytes plus discriminated
 * revision metadata. Resolution is the caller's concern (current state: #80;
 * pinned history: #87) — this module only paints.
 */
export type SnapshotLayer = {
  name: string;
  layerId: string;
  revision: ResolvedLayerRevision;
  contentBytes: Buffer;
};

/**
 * The rendering environment that produced a paint: identity fields only.
 * Byte-identical replay is guaranteed within this environment, never claimed
 * universally across machines that merely report equal version strings
 * (#87, US-007).
 */
export interface PaintEnvironment {
  tool: { name: string; version: string };
  runtime: string;
  browser: string;
  platform: string;
}

/**
 * Capture the environment identity of the page that actually painted, inside
 * the same paint callback — the identity must describe the browser that
 * produced the pixels, not a separately consulted one (#87).
 */
function captureEnvironment(page: Page): PaintEnvironment {
  const browser = page.context().browser();
  if (!browser) {
    throw new Error("Cannot capture the render environment: the render page has no browser.");
  }
  return {
    tool: toolIdentity(),
    runtime: `bun ${Bun.version}`,
    browser: `${browser.browserType().name()} ${browser.version()}`,
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * Paint the snapshot's exact bytes through the render page: one
 * absolutely-positioned element per Layer at its stored position and opacity,
 * in reference-list order, over a transparent canvas sized to the
 * Composition. Images paint at intrinsic size; text layers paint as DOM text
 * with their retained font bytes declared under an internal @font-face
 * family (#81). The screenshot is taken only after every image has fully
 * decoded AND every text family has actually loaded — an unresolved face
 * fails the render instead of falling back silently.
 *
 * Returns the PNG bytes plus the environment identity captured from the same
 * page pass. A caller-owned `page` (tests: route-aborted offline evidence)
 * is used directly and never closed; otherwise the shared render page runs
 * the paint, serialized against every other browser-backed render.
 */
export async function paintComposition(
  canvas: { width: number; height: number },
  layers: SnapshotLayer[],
  options: { page?: Page } = {},
): Promise<{ png: Buffer; environment: PaintEnvironment }> {
  const paint = async (page: Page) => {
    await page.setViewportSize({ width: canvas.width, height: canvas.height });
    await page.setContent(buildCompositionHtml(canvas, layers), { waitUntil: "load" });
    // Awaited decode: a partially painted canvas is never screenshotted.
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    await rejectUnresolvedFonts(page, layers);
    const png = await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    });
    return { png, environment: captureEnvironment(page) };
  };
  return options.page ? paint(options.page) : withRenderPage(paint);
}

/**
 * Internal @font-face family name for a retained font blob (#81). Derived
 * from the content hash — the retained bytes are the only font identity, so
 * the renderer never needs the bundled registry or the original family name.
 *
 * Deliberately module-private: family names are minted only inside this
 * builder (the one font/geometry authority, DEC-004), never by callers that
 * only consume the builder's markup. If painted-bounds work (#137) ever
 * needs the family outside this module, that ticket re-exports it with its
 * own consuming evidence — no speculative surface now.
 */
function internalFontFamily(contentHash: string): string {
  return `ply-face-${contentHash.slice(0, 16)}`;
}

/**
 * Verify each text layer's font actually loaded and resolved in the page via
 * the shared family-resolution probe. Garbage bytes, undecodable faces, or a
 * failed load fall through to a fallback font — detected here and rejected
 * before any output is published.
 *
 * Shared with layout measurement (#136, DEC-004): measurement applies the
 * exact same retained-font resolution gate as painting, so an unresolved
 * face can never yield measured numbers.
 */
export async function rejectUnresolvedFonts(page: Page, layers: SnapshotLayer[]): Promise<void> {
  const byFamily = new Map<string, string[]>();
  for (const l of layers) {
    if (l.revision.kind !== "text") continue;
    const family = internalFontFamily(l.revision.contentHash);
    byFamily.set(family, [...(byFamily.get(family) ?? []), l.name]);
  }
  const unresolved: string[] = [];
  for (const [family, names] of byFamily) {
    if (!(await page.evaluate(familyResolved, family))) {
      unresolved.push(`Layer "${names.join('", "')}"`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Font face failed to load from retained bytes for ${unresolved.join(", ")} — ` +
        `silent fallback is not allowed; the retained font content may be invalid or corrupted.`,
    );
  }
}

/** Minimal HTML escaping for text layer content (#81). */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The page HTML for one Composition. Layer names never reach the markup;
 * every interpolated value is a validated finite number, a whitelisted MIME
 * type, a hash-derived internal family, or the strict-hex validated color —
 * except text content, which is HTML-escaped.
 *
 * This builder is the ONE geometry-and-font authority for Composition
 * layout (DEC-004): current-state painting (#80), historical replay (#87),
 * and read-only layout measurement (#136) all render and measure through
 * the exact markup it produces — the same retained font bytes under the
 * same internal @font-face families, the same emitted rotate∘flip∘scale
 * transforms about (x, y) with transform-origin 0 0, the same canvas and
 * text wrapping. There is no second markup builder to drift from.
 */
export function buildCompositionHtml(canvas: { width: number; height: number }, layers: SnapshotLayer[]): string {
  const faces = new Map<string, Buffer>();
  for (const l of layers) {
    if (l.revision.kind === "text" && !faces.has(l.revision.contentHash)) {
      faces.set(l.revision.contentHash, l.contentBytes);
    }
  }
  const fontCss = [...faces]
    .map(
      ([hash, bytes]) =>
        `@font-face { font-family: "${internalFontFamily(hash)}"; ` +
        `src: url(data:font/ttf;base64,${bytes.toString("base64")}) format("truetype"); }`,
    )
    .join("\n");
  const els = layers
    .map((l) => {
      const rev = l.revision;
      const base = `position:absolute;left:${rev.x}px;top:${rev.y}px;opacity:${rev.opacity};`;
      // Canonical transform (#133/#134/#135, ADR-0016): applied about the
      // Layer's (x, y) top-left placement point. Flip and scale act on the
      // content along its own axes first (both are diagonal transforms and
      // commute, so their emitted order among themselves is immaterial), then
      // rotation rotates the transformed result — CSS composes left-to-right
      // as rotate∘flip∘scale. Each factor is emitted only when non-identity,
      // so revisions written before #133/#134/#135 and identity-transform
      // revisions paint exactly as before (pinned history stays
      // byte-identical).
      const transformParts: string[] = [];
      if (rev.rotationDeg !== 0) {
        transformParts.push(`rotate(${rev.rotationDeg}deg)`);
      }
      if (rev.flipX) {
        transformParts.push("scaleX(-1)");
      }
      if (rev.flipY) {
        transformParts.push("scaleY(-1)");
      }
      if (rev.scaleX !== 1 || rev.scaleY !== 1) {
        transformParts.push(`scale(${rev.scaleX},${rev.scaleY})`);
      }
      const transformed =
        transformParts.length > 0
          ? `transform:${transformParts.join(" ")};transform-origin:0 0;`
          : "";
      // Canonical shadow (#139, ADR-0018): drop-shadow applies to the
      // Layer's content in its LOCAL coordinate space — the transform above
      // then maps content+shadow together, and the element's opacity fades
      // both. Emitted only when a shadow exists, so pre-#139 revisions and
      // their pinned Render history paint exactly as before.
      const shadowFilter =
        rev.shadow !== undefined
          ? `filter:drop-shadow(${rev.shadow.dx}px ${rev.shadow.dy}px ${rev.shadow.blur}px ${rev.shadow.color});`
          : "";
      if (rev.kind === "text") {
        const style =
          `${base}${transformed}${shadowFilter}font-family:'${internalFontFamily(rev.contentHash)}';` +
          `font-size:${rev.fontSize}px;color:${rev.color};white-space:pre-wrap;`;
        return `<div style="${style}">${escapeHtml(rev.text)}</div>`;
      }
      return `<img src="data:${MIME[rev.format]};base64,${l.contentBytes.toString("base64")}" style="${base}${transformed}${shadowFilter}">`;
    })
    .join("");
  return (
    `<!doctype html><html><head><style>` +
    fontCss +
    `html,body{margin:0;padding:0;background:transparent}` +
    `#canvas{position:relative;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden}` +
    `</style></head>` +
    `<body><div id="canvas">${els}</div></body></html>`
  );
}