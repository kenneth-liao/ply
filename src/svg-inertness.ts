/**
 * External-reference scan for SVG ingestion (#214, spec #207 US-006, DEC-007):
 * the trust boundary that keeps an imported vector inert. The browser's
 * `<img>` paint path disables scripts and external loads by construction —
 * this is the ingestion gate so a file never renders with a silently missing
 * part (fail fast). The scan is generic, not a per-element allowlist: EVERY
 * attribute value on EVERY element is judged — any `url(…)` occurrence
 * anywhere (paint servers on `fill`/`stroke`/`filter`/`mask`/`clip-path`
 * included), any `href`/`src`/`data`/`base`/`poster` value, and each
 * `srcset` candidate separately — plus `<style>` bodies, `<?xml-stylesheet?>`
 * processing instructions, and the DOCTYPE.
 *
 * Values are normalized before judging, in the order the consuming parsers
 * apply them, so an encoding cannot hide a reference from the verdict: XML
 * character/entity references are decoded once (CDATA content kept verbatim,
 * as XML delivers it), CDATA sections are joined into the text they
 * represent (style bodies included), and CSS backslash escapes are unescaped
 * exactly as CSS tokenization decodes them — so `@\\69 mport` is matched as
 * `@import`. Nested `data:image/svg+xml` payloads are re-scanned once
 * (bounded depth 1) instead of being trusted to the browser's recursive
 * image-mode blocking.
 *
 * What is refused:
 *
 * - **Images** — remote and local: `http(s)://`, `file://`, relative and
 *   absolute local paths, protocol-relative, unknown schemes. Either href
 *   spelling, any case, any whitespace around `=`.
 * - **Fonts** — `url(…)` inside an `@font-face` block.
 * - **Stylesheets** — `<?xml-stylesheet …?>` (a missing href refuses on
 *   doubt), `<link … href=…>`, `@import`, and any CSS `url()`.
 * - **`use` targets outside the file**; the DOCTYPE's own DTD identifier is
 *   NOT a reference and does not block import.
 * - **DOCTYPE entity declarations — internal or external.** A conformant XML
 *   parser expands internal entities, so `<!ENTITY x "<image href='…'/>">`
 *   used as `&x;` injects markup the text-level scan cannot judge. Without
 *   DOCTYPE entities there is nothing to expand; the fix inlines the values.
 * - **Malformed structure** — an unterminated comment, CDATA section,
 *   `<script>`, `<style>`, processing instruction, DOCTYPE, or tag refuses
 *   as malformed. Never accept on doubt.
 *
 * What is accepted:
 *
 * - Same-document fragment references (`#id`), embedded `data:` URIs (the
 *   fix the refusal names), and `javascript:` hrefs.
 * - References inside comments (stripped first) and plain text content —
 *   text mentioning a URL is not a reference.
 * - A script — `<script>` element, `src`, inline body, `on*` handlers —
 *   never blocks import and never runs: its body and attributes are skipped
 *   wholesale.
 *
 * The scan is text-level like src/svg-meta.ts — no XML parser is pulled in —
 * and bounds its own work and message against pathological files (see the
 * MAX_* constants). Line numbers are diagnostic, best-effort.
 */

/** One out-of-file reference found in the document. */
interface ExternalRef {
  /** What kind of reference it is — the words the refusal names. */
  kind: string;
  /** The reference target as it appears (normalized, bounded). */
  target: string;
  /** 1-based line of the document the scan judged, best-effort. */
  line: number;
}

/** Findings collection with the pathological-input bounds: a bounded number
 *  of distinct references is collected (the message reports the bound when
 *  it is hit) and `capped()` lets the walk stop early. Nested scans share
 *  one collector, so a nested payload's references are named in the same
 *  refusal as the outer document's. */
interface Collector extends ScanParent {
  readonly findings: readonly ExternalRef[];
  push(kind: string, target: string, line: number): void;
  capped(): boolean;
}

/** The findings sink every document in one scan shares: the collector at the
 *  top, with the nesting-aware push supplied by each scanDocument level. */
interface ScanParent {
  push(kind: string, target: string, line: number): void;
  capped(): boolean;
}

/** One document's scan context: sub-scans push offsets and the context maps
 *  them to the line the OUTER refusal should name (this document's lines at
 *  depth 0; the outer document's nesting point below it), with the kind
 *  prefix that says where a nested finding came from. */
interface DocScan extends ScanParent {
  push(kind: string, target: string, offset: number): void;
  lineAt(offset: number): number;
  capped(): boolean;
}

/**
 * Bounds that keep a pathological file (up to the 64 MB ingestion cap) from
 * turning the refusal itself into a hang or an unbounded message: distinct
 * references collected, references shown in the message, and the length of
 * one named target. When the collection bound is hit the message says so —
 * the count it reports is a lower bound, never an invented total.
 */
const MAX_COLLECTED = 64;
const MESSAGE_CAP = 20;
const TARGET_MAX = 200;

/** Attributes whose value is a resource reference, by local name (namespace
 *  prefix stripped, case-folded) — element-agnostic: both href spellings via
 *  href, foreignObject HTML via src/data/poster, xml:base (it silently
 *  re-roots every relative reference in its scope). srcset is judged
 *  candidate-by-candidate, not as one string. */
const URL_ATTRS = new Set(["href", "src", "data", "base", "poster"]);

/** The XML decode a conformant processor applies without a DTD: numeric
 *  character references and the five predefined entities, applied ONCE —
 *  this module judges exactly the value the XML parser hands the consumer.
 *  A custom entity (`&name;`) is left encoded: a document using one is
 *  malformed without a DOCTYPE, and DOCTYPE entities are refused on their
 *  own. */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return match;
    }
  });
}

/**
 * CSS unescape, exactly as CSS tokenization decodes backslash escapes:
 * `\` + 1–6 hex digits (plus one consumed trailing whitespace) is a code
 * point; `\` + any other char is that char literally. Applied AFTER the XML
 * decode and BEFORE any `url(`/`@import` matching, so `@\\69 mport` cannot
 * hide the keyword.
 */
function cssUnescape(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex?: string, ch?: string) => {
    if (hex !== undefined) {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ch ?? "";
  });
}

/** One maximal run of text the XML parser delivers verbatim: either ordinary
 *  character data (entity references still encoded) or CDATA content
 *  (delivered verbatim). */
interface TextSegment {
  text: string;
  cdata: boolean;
}

/** Split text into its CDATA and ordinary-character-data segments. CDATA
 *  sections represent their inner text verbatim; joining them into the text
 *  closes the CDATA-split-keyword evasion (`@imp<![CDATA[ort …]]>`). */
function splitCdata(text: string): { segments: TextSegment[]; unterminated: boolean } {
  if (!text.includes("<![CDATA[")) return { segments: [{ text, cdata: false }], unterminated: false };
  const segments: TextSegment[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("<![CDATA[", i);
    if (start === -1) {
      segments.push({ text: text.slice(i), cdata: false });
      return { segments, unterminated: false };
    }
    if (start > i) segments.push({ text: text.slice(i, start), cdata: false });
    const close = text.indexOf("]]>", start + 9);
    if (close === -1) {
      segments.push({ text: text.slice(start + 9), cdata: true });
      return { segments, unterminated: true };
    }
    segments.push({ text: text.slice(start + 9, close), cdata: true });
    i = close + 3;
  }
}

/** The text a style body or CSS-bearing attribute value represents, with
 *  entity references decoded only where XML would decode them and CSS
 *  escapes unescaped where the CSS tokenizer would. */
function cssTextOf(raw: string): { text: string; unterminatedCdata: boolean } {
  const { segments, unterminated } = splitCdata(raw);
  const joined = segments.map((s) => (s.cdata ? s.text : decodeXmlEntities(s.text))).join("");
  return { text: cssUnescape(joined), unterminatedCdata: unterminated };
}

/** Replace each comment's characters (newlines kept) with spaces, so the
 *  comment's text can never look like markup and line numbers survive. An
 *  unterminated comment is malformed — the caller refuses it. */
function stripComments(text: string): { text: string; unterminated: boolean } {
  let out = "";
  let i = 0;
  for (;;) {
    const start = text.indexOf("<!--", i);
    if (start === -1) return { text: out + text.slice(i), unterminated: false };
    out += text.slice(i, start);
    const end = text.indexOf("-->", start + 4);
    if (end === -1) return { text: out + text.slice(start), unterminated: true };
    out += text.slice(start, end + 3).replace(/[^\n]/g, " ");
    i = end + 3;
  }
}

/**
 * The verdict for one already-XML-decoded URL value: the reference to name
 * when the value points outside the file, or undefined when it is inert — a
 * same-document fragment, an embedded data URI, or a javascript: href (a
 * script never blocks import and never runs in the image path). Whitespace
 * is compacted before the scheme check so `h ttps://` cannot slip past, and
 * an unresolvable custom entity (`&name;` — a malformed document without a
 * DOCTYPE) refuses on doubt.
 */
function externalTarget(xmlDecoded: string): string | undefined {
  const value = xmlDecoded.trim();
  if (value === "") return undefined;
  if (/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(value)) {
    return value; // a custom entity — its replacement text is unknowable
  }
  const compact = value.replace(/\s+/g, "");
  if (compact.startsWith("#")) return undefined; // same-document fragment
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (scheme && (scheme[1]!.toLowerCase() === "data" || scheme[1]!.toLowerCase() === "javascript")) {
    return undefined;
  }
  return value; // remote, local, relative, protocol-relative, or unknown scheme
}

/** `url(` as CSS tokenizes it — an ident followed by `(`, never the tail of
 *  a longer name like `bgurl(`. */
const CSS_URL = /(?<![\w-])url\(/i;

/** 1-based line of an offset in `text`: a lazy newline index (one pass) and
 *  a binary search per finding — never a rescan of the document. */
function makeLineAt(text: string): (offset: number) => number {
  let lineIndex: number[] | undefined;
  return (offset: number): number => {
    if (lineIndex === undefined) {
      lineIndex = [];
      for (let pos = text.indexOf("\n"); pos !== -1; pos = text.indexOf("\n", pos + 1)) {
        lineIndex.push(pos);
      }
    }
    let lo = 0;
    let hi = lineIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineIndex[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

function createCollector(): Collector {
  const findings: ExternalRef[] = [];
  let capped = false;
  return {
    findings,
    push(kind, target, line) {
      if (findings.length >= MAX_COLLECTED) {
        capped = true;
        return;
      }
      // The named target is bounded and stripped of control characters: a
      // huge or control-bearing value cannot blow up the refusal message or
      // spoof its line structure.
      const cleaned =
        target.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, TARGET_MAX) +
        (target.length > TARGET_MAX ? "…" : "");
      if (findings.some((f) => f.kind === kind && f.target === cleaned)) return;
      findings.push({ kind, target: cleaned, line });
    },
    capped: () => capped,
  };
}

/**
 * Scan one DOCTYPE (possibly with an internal subset). Quoted SystemLiterals
 * may contain `[`, `]`, and `>`, so the region is found quote-aware — a
 * quoted `[` never opens a subset and a `>` inside a literal never closes
 * the declaration. ANY entity declaration — internal or external — is
 * refused: a conformant XML parser expands internal entities, so entity
 * expansion to markup cannot be judged at text level; without DOCTYPE
 * entities there is nothing to expand. The DOCTYPE's own DTD identifier is
 * not an entity declaration and does not block import. Returns the index to
 * resume the walk from, plus a malformed-document refusal when the
 * declaration never closes.
 */
function scanDoctype(
  text: string,
  start: number,
  doc: DocScan,
  file: string,
): { end: number; refusal?: string } {
  let quote: string | undefined;
  let subsetStart = -1;
  let firstGt = -1;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" && subsetStart === -1) {
      subsetStart = i;
    } else if (c === ">") {
      firstGt = i;
      break;
    }
  }
  let end: number;
  let refusal: string | undefined;
  if (subsetStart !== -1 && (firstGt === -1 || subsetStart < firstGt)) {
    // Internal subset: scan to the subset's closing `]`, quote-aware, then
    // the declaration's own `>` after it.
    let j = subsetStart;
    quote = undefined;
    while (j < text.length) {
      const c = text[j]!;
      if (quote !== undefined) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "]") {
        break;
      }
      j++;
    }
    if (j >= text.length) {
      // Unterminated subset: the file is malformed XML. Judge what is
      // present (its entity declarations are still refused) and resume at
      // the next `>` so the rest of the document is walked, not skipped.
      const gt = text.indexOf(">", subsetStart);
      end = gt === -1 ? text.length : gt + 1;
    } else {
      const gt = text.indexOf(">", j);
      end = gt === -1 ? text.length : gt + 1;
    }
  } else if (firstGt === -1) {
    end = text.length;
    refusal =
      `"${file}" is not a valid SVG document: the <!DOCTYPE declaration is unterminated ` +
      `(line ${doc.lineAt(start)}) — close or remove it, then import again.`;
  } else {
    end = firstGt + 1;
  }

  const region = text.slice(start, end);
  // Every entity declaration is refused, internal or external, general or
  // parameter — each named.
  for (const m of region.matchAll(/<\s*!entity\s+(?:%\s+)?([^\s>]+)/gi)) {
    doc.push("DOCTYPE entity declaration", decodeXmlEntities(m[1]!), start + (m.index ?? 0));
  }
  return { end, refusal };
}

/** CSS scan of one style body or CSS-bearing attribute value: normalize
 *  (CDATA joined, entities decoded, CSS escapes unescaped), then judge
 *  every `url()` target and `@import` string, with a url() inside an
 *  `@font-face` block named as the font case. Accepted
 *  `data:image/svg+xml` targets are re-scanned (bounded depth 1). */
function scanCss(
  label: string,
  raw: string,
  baseOffset: number,
  doc: DocScan,
  file: string,
  depth: number,
): string | undefined {
  const { text: css, unterminatedCdata } = cssTextOf(raw);
  if (unterminatedCdata) {
    return (
      `"${file}" is not a valid SVG document: an unterminated CDATA section inside ${label} ` +
      `(line ${doc.lineAt(baseOffset)}) — close or remove it, then import again.`
    );
  }
  const fontFaceRanges: Array<[number, number]> = [];
  for (const m of css.matchAll(/@font-face\b/gi)) {
    const open = css.indexOf("{", m.index);
    const close = open === -1 ? -1 : css.indexOf("}", open);
    fontFaceRanges.push([open === -1 ? m.index : open, close === -1 ? css.length : close]);
  }
  const kindFor = (pos: number): string =>
    fontFaceRanges.some(([a, b]) => pos >= a && pos <= b)
      ? "font reference (@font-face src)"
      : `CSS url() in ${label}`;

  for (const m of css.matchAll(/(?<![\w-])url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi)) {
    const target = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const refused = externalTarget(target);
    if (refused !== undefined) {
      doc.push(kindFor(m.index), refused, baseOffset + (m.index ?? 0));
    } else {
      const nested = nestedDataSvg(target, file, depth, doc, baseOffset + (m.index ?? 0));
      if (nested) return nested;
    }
  }
  // @import with a plain string target; the url() form is covered above.
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const target = (m[1] ?? m[2] ?? "").trim();
    const refused = externalTarget(target);
    if (refused !== undefined) {
      doc.push(`@import in ${label}`, refused, baseOffset + (m.index ?? 0));
    } else {
      const nested = nestedDataSvg(target, file, depth, doc, baseOffset + (m.index ?? 0));
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Judge one already-XML-decoded URL value: push the refusal naming it, or —
 *  when accepted — re-scan a nested data:image/svg+xml payload. */
function judgeUrl(
  kind: string,
  xmlDecoded: string,
  offset: number,
  doc: DocScan,
  file: string,
  depth: number,
): string | undefined {
  const refused = externalTarget(xmlDecoded);
  if (refused !== undefined) {
    doc.push(kind, refused, offset);
    return undefined;
  }
  return nestedDataSvg(xmlDecoded, file, depth, doc, offset);
}

/** Depth-1 re-scan of a decodable nested data:image/svg+xml payload: the
 *  browser blocks the inner document's external loads by construction, but
 *  the gate refuses on doubt rather than trust recursion. Malformed inner
 *  markup refuses the import (it would fail the decode gate anyway). */
function nestedDataSvg(
  xmlDecoded: string,
  file: string,
  depth: number,
  doc: DocScan,
  offset: number,
): string | undefined {
  if (depth >= 1) return undefined;
  const compact = xmlDecoded.replace(/\s+/g, "");
  if (!/^data:image\/svg\+xml(;|,|$)/i.test(compact)) return undefined;
  const comma = xmlDecoded.indexOf(",");
  if (comma === -1) return undefined;
  const meta = compact.slice(4, compact.indexOf(","));
  const payload = xmlDecoded.slice(comma + 1);
  let inner: string | undefined;
  if (/;base64/i.test(meta)) {
    const bytes = Buffer.from(payload.replace(/\s+/g, ""), "base64");
    inner = bytes.length > 0 ? bytes.toString("utf8") : undefined;
  } else {
    try {
      const decoded = decodeURIComponent(payload);
      inner = decoded.length > 0 ? decoded : undefined;
    } catch {
      return undefined; // not decodable — the decode gate owns it
    }
  }
  if (inner === undefined) return undefined;
  return scanDocument(
    inner,
    `${file} (inside a nested data:image/svg+xml URI)`,
    depth + 1,
    doc,
    "nested data:image/svg+xml: ",
    doc.lineAt(offset),
  );
}

/** Scan one start tag's attribute region — every attribute value on every
 *  element: the url() extractor over any value containing one, the
 *  reference-attribute verdicts, and each srcset candidate separately. */
function scanAttrs(
  tag: string,
  attrs: string,
  baseOffset: number,
  doc: DocScan,
  file: string,
  depth: number,
): string | undefined {
  const attrRe = /([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  for (const m of attrs.matchAll(attrRe)) {
    const rawName = m[1]!;
    const local = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;
    const lower = local.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined) continue;
    // Normalize once, in the order the consuming parser would: XML entity
    // references decoded (the value the XML parser hands over), then CSS
    // escapes unescaped for the url(/@import probe. An encoding cannot hide
    // a reference or a url() keyword from the verdict.
    const xmlDecoded = decodeXmlEntities(value);
    const offset = baseOffset + (m.index ?? 0);
    if (lower === "style" || CSS_URL.test(cssUnescape(xmlDecoded))) {
      const label = lower === "style" ? `style attribute on <${tag}>` : `${lower} attribute on <${tag}>`;
      const early = scanCss(label, xmlDecoded, offset, doc, file, depth);
      if (early) return early;
    }
    if (URL_ATTRS.has(lower)) {
      const kind =
        tag === "use" ? "use target outside the file" : `${lower} on <${tag}>`;
      const early = judgeUrl(kind, xmlDecoded, offset, doc, file, depth);
      if (early) return early;
    } else if (lower === "srcset") {
      // Each candidate is judged separately — a fragment- or data:-first
      // list cannot smuggle a remote candidate past the gate.
      for (const candidate of xmlDecoded.split(",")) {
        const urlToken = candidate.trim().split(/\s+/)[0] ?? "";
        if (urlToken === "") continue;
        const early = judgeUrl(`srcset candidate on <${tag}>`, urlToken, offset, doc, file, depth);
        if (early) return early;
      }
    }
  }
  return undefined;
}

/**
 * The one out-of-file reference scan over an SVG document's text. Comments
 * are stripped (a URL in a comment is not a reference); script elements are
 * skipped wholesale (a script never blocks import and its source is inert
 * text); style bodies, every attribute value, processing instructions, and
 * the DOCTYPE are judged with normalized text. Every finding is collected —
 * the refusal names EACH reference, not the first. Unterminated constructs
 * refuse as malformed; never accept on doubt.
 */
function scanDocument(
  rawText: string,
  file: string,
  depth: number,
  parent: ScanParent,
  kindPrefix: string,
  topLine: number,
): string | undefined {
  const comments = stripComments(rawText);
  if (comments.unterminated) {
    return (
      `"${file}" is not a valid SVG document: an unterminated <!-- comment ` +
      `is malformed XML — close or remove it, then import again.`
    );
  }
  const text = comments.text;
  const lower = text.toLowerCase();
  const lineAt = makeLineAt(text);
  const doc: DocScan = {
    push: (kind, target, offset) =>
      parent.push(`${kindPrefix}${kind}`, target, depth === 0 ? lineAt(offset) : topLine),
    lineAt,
    capped: () => parent.capped(),
  };
  const malformed = (what: string, offset: number): string =>
    `"${file}" is not a valid SVG document: ${what} (line ${lineAt(offset)}) is unterminated — ` +
    `close or remove it, then import again.`;

  let i = 0;
  while (i < text.length && !doc.capped()) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (lower.startsWith("<![cdata[", lt)) {
      const close = lower.indexOf("]]>", lt + 9);
      if (close === -1) return malformed("an unterminated CDATA section", lt);
      // Top-level CDATA is element character data — text, not a reference.
      // Inside a <style> body the whole body slice is CSS-scanned instead.
      i = close + 3;
      continue;
    }
    if (lower.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      if (close === -1) return malformed("a processing instruction", lt);
      const body = text.slice(lt + 2, close);
      if (/^\s*xml-stylesheet\b/i.test(body)) {
        // Processing-instruction content is opaque text in XML: entity
        // references are NOT decoded there, so the href is judged literally.
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s?>]+))/i.exec(body);
        if (!href) {
          // Refuse on doubt, never crash: an xml-stylesheet PI without a
          // quoted or unquoted href is a malformed instruction.
          doc.push("xml-stylesheet reference", "(no href — the instruction names no embedded stylesheet)", lt);
        } else {
          const target = (href[1] ?? href[2] ?? href[3] ?? "").trim();
          const early = judgeUrl("xml-stylesheet reference", target, lt, doc, file, depth);
          if (early) return early;
        }
      }
      i = close + 2;
      continue;
    }
    if (lower.startsWith("<!doctype", lt)) {
      const dt = scanDoctype(text, lt, doc, file);
      if (dt.refusal) return dt.refusal;
      i = dt.end;
      continue;
    }
    if (lower.startsWith("<!", lt) || lower.startsWith("</", lt)) {
      const close = text.indexOf(">", lt);
      if (close === -1) {
        return malformed(lower.startsWith("</", lt) ? "an end tag" : "a declaration", lt);
      }
      i = close + 1;
      continue;
    }
    // Start tag: name, then a quote-aware scan to the closing `>`.
    const nameEnd = /^<([^\s/>]+)/.exec(text.slice(lt, lt + 64));
    if (!nameEnd) {
      // Not a well-formed tag opening — skip one char and keep walking; the
      // browser's image decode is the well-formedness gate.
      i = lt + 1;
      continue;
    }
    const tag = nameEnd[1]!.toLowerCase();
    let j = lt + 1 + nameEnd[1]!.length;
    let quote: string | undefined;
    while (j < text.length) {
      const c = text[j]!;
      if (quote !== undefined) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    if (j >= text.length) return malformed(`a <${tag}> start tag`, lt);
    const attrsStart = lt + 1 + nameEnd[1]!.length;
    const attrs = text.slice(attrsStart, j);
    const selfClosing = text[j - 1] === "/";
    if (tag === "script") {
      // A script element — self-closing, paired, src or inline — is never a
      // reference source: a script does not block import and never runs in
      // the image path, so its body and attributes are skipped wholesale.
      if (selfClosing) {
        i = j + 1;
        continue;
      }
      const closeTag = lower.indexOf("</script", j);
      if (closeTag === -1) return malformed("a <script> element", lt);
      const gt = text.indexOf(">", closeTag);
      i = gt === -1 ? text.length : gt + 1;
      continue;
    }
    const early = scanAttrs(tag, attrs, attrsStart, doc, file, depth);
    if (early) return early;
    if (tag === "style" && !selfClosing) {
      const closeTag = lower.indexOf("</style", j);
      if (closeTag === -1) return malformed("a <style> element", lt);
      const early2 = scanCss("<style> body", text.slice(j + 1, closeTag), j + 1, doc, file, depth);
      if (early2) return early2;
      const gt = text.indexOf(">", closeTag);
      i = gt === -1 ? text.length : gt + 1;
      continue;
    }
    i = j + 1;
  }
  return undefined;
}

/**
 * The entry point: the out-of-file reference scan over an SVG document.
 * Returns the refusal message when the file references anything outside
 * itself (or is malformed), undefined when the file is inert.
 */
export function scanSvgExternalReferences(bytes: Buffer, file: string): string | undefined {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = createCollector();
  const malformed = scanDocument(text, file, 0, out, "", 0);
  if (malformed !== undefined) return malformed;
  return assemble(out.findings, out.capped(), file);
}

/** The refusal message: every collected reference named, each with its kind
 *  and line, and the fixes. The message shows the first MESSAGE_CAP
 *  references; when the collection bound was hit it says so — the count it
 *  reports is a lower bound, never an invented total. */
function assemble(findings: readonly ExternalRef[], capped: boolean, file: string): string | undefined {
  if (findings.length === 0) return undefined;
  const shown = findings.slice(0, MESSAGE_CAP);
  const more = findings.length - shown.length;
  const hasEntity = findings.some((f) => f.kind.startsWith("DOCTYPE entity"));
  const fixes: string[] = [];
  if (findings.some((f) => !f.kind.startsWith("DOCTYPE entity"))) {
    fixes.push("embed each referenced resource as a data URI inside the SVG file");
  }
  if (hasEntity) {
    fixes.push("remove the DOCTYPE's entity declarations (replace each &name; reference with the value it declares)");
  }
  return (
    `"${file}" references resources outside itself — import refused. Found:\n` +
    shown.map((f) => `  - ${f.kind} "${f.target}" (line ${f.line})`).join("\n") +
    (capped
      ? `\n  ...and more — the scan stopped listing distinct references at ${MAX_COLLECTED}.`
      : more > 0
      ? `\n  ...and ${more} more reference(s)`
      : "") +
    `\nThe fix: ${fixes.join("; and ")}, then import again.`
  );
}