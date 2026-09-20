/**
 * External-reference scan for SVG ingestion (#214, spec #207 US-006, DEC-007):
 * the trust boundary that keeps an imported vector inert. The browser's
 * `<img>` paint path disables scripts and external loads by construction —
 * this scan is the additional ingestion gate so a file never renders with a
 * silently missing part (fail fast): any reference to a resource outside the
 * file is refused at import, naming each reference and the fix.
 *
 * What is scanned, and why — the threat model:
 *
 * - **href / xlink:href, both spellings, any case, whitespace around `=`** —
 *   every attribute whose local name is `href`, `src`, `data`, `srcset`, or
 *   `base` (xml:base) is evaluated on every element, so `<image>`, `<use>`,
 *   `<feImage>`, `<cursor>`, foreignObject HTML (`<img src>`, `<iframe src>`,
 *   `<object data>`), and `<link>` are all covered without an element list.
 * - **Entity-encoded values** — attribute values are XML-decoded first
 *   (numeric character references and the five predefined entities), so
 *   `&#104;ttps://…` is caught. An entity the processor cannot resolve
 *   without a DTD (`&custom;`) refuses on doubt.
 * - **Stylesheets** — `<?xml-stylesheet … href=…?>`, `<link …>`, `@import`,
 *   and any CSS `url()` inside `<style>` bodies or `style` attributes
 *   (`@font-face src: url(…)` is the font case of the same rule).
 * - **External entity declarations** — `<!ENTITY … SYSTEM/PUBLIC …>` inside
 *   the DOCTYPE, scanned quote-aware (a quoted value may contain `>` or
 *   `]`): the one DOCTYPE construct whose external replacement text could
 *   change what the document shows when resolved. The DOCTYPE's own
 *   external identifier — the conventional SVG 1.1 DTD boilerplate design
 *   tools emit — is not a rendered resource and is never fetched in the
 *   browser's image path, so it does not block import.
 * - **Comments and `<script>` bodies are excluded**: a URL mentioned inside a
 *   comment or a script's source text is not a reference the browser can
 *   act on in image mode, and a script must never block import (below).
 *
 * What is accepted:
 *
 * - Same-document fragment references (`#id`) — e.g. `<use href="#dot">`.
 * - Embedded `data:` URIs — the fix the refusal names.
 * - `javascript:` hrefs, `<script>` elements, and `on*` handlers — a script
 *   does not block import and is never executed: the vector is painted as an
 *   image, where scripts are disabled by construction. Script source text is
 *   opaque, never scanned for references.
 *
 * The scan is text-level like src/svg-meta.ts — no XML parser is pulled in —
 * and refuses on doubt: any value that is not a fragment, `data:`, or
 * `javascript:` (relative paths, absolute local paths, `http(s)://`,
 * protocol-relative, `file://`, mailto, unknown schemes) is a refusal.
 * Line numbers are diagnostic, best-effort, and derived from a scan that
 * preserves line structure.
 */

/** One out-of-file reference found in the document. */
interface ExternalRef {
  /** What kind of reference it is — the words the refusal names. */
  kind: string;
  /** The reference target as it appears (entity-decoded, bounded). */
  target: string;
  /** 1-based line, best-effort. */
  line: number;
}

/** Findings collection with the pathological-input bounds: a bounded number
 *  of distinct references is collected (the message reports the bound when
 *  it is hit), and the collector answers `capped()` so callers can skip
 *  further expensive target extraction once the bound is hit. */
interface Collector {
  push(kind: string, target: string, offset: number): void;
  capped(): boolean;
}

const ACCEPTED_SCHEMES = new Set(["data", "javascript"]);

/** The XML decode a conformant processor applies without a DTD: numeric
 *  character references and the five predefined entities. A custom entity
 *  (`&name;`) is left encoded and refuses on doubt below — its replacement
 *  text is unknowable without the DOCTYPE that declares it. */
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
 * The verdict for one URL-ish value. Returns the reference to name when the
 * value points outside the file, or undefined when it is inert: a
 * same-document fragment, an embedded data URI, or a javascript: href (a
 * script never blocks import and never runs — image mode disables scripts).
 * Whitespace is compacted before the scheme check so `h ttps://` cannot slip
 * past, and an entity the processor cannot resolve refuses on doubt.
 */
function externalTarget(raw: string): string | undefined {
  const decoded = decodeXmlEntities(raw).trim();
  if (decoded === "") return undefined;
  if (/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(decoded)) {
    return decoded; // a custom entity — its replacement text is unknowable
  }
  const compact = decoded.replace(/\s+/g, "");
  if (compact.startsWith("#")) return undefined; // same-document fragment
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (scheme && ACCEPTED_SCHEMES.has(scheme[1]!.toLowerCase())) return undefined;
  return decoded; // remote, local, relative, protocol-relative, or unknown scheme
}

/** Replace each comment's characters (newlines kept) with spaces, so the
 *  comment's text can never look like markup and line numbers survive. An
 *  unterminated comment runs to the end of the file. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = text.indexOf("<!--", i);
    if (start === -1) return out + text.slice(i);
    out += text.slice(i, start);
    const end = text.indexOf("-->", start + 4);
    if (end === -1) return out + text.slice(start).replace(/[^\n]/g, " ");
    out += text.slice(start, end + 3).replace(/[^\n]/g, " ");
    i = end + 3;
  }
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

/** The quoted strings at-or-after `from`, in order, XML-decoded. */
function quotedAfter(text: string, from: number): string[] {
  const values: string[] = [];
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c !== '"' && c !== "'") continue;
    const close = text.indexOf(c, i + 1);
    if (close === -1) break;
    values.push(decodeXmlEntities(text.slice(i + 1, close)));
    i = close;
  }
  return values;
}

/**
 * Scan one DOCTYPE (possibly with an internal subset) for the one construct
 * that can change what the document shows when resolved: an external entity
 * declaration (`<!ENTITY … SYSTEM/PUBLIC …>`). Quoted values may contain
 * `>` and `]`, so the region and the keyword search are quote-aware. The
 * DOCTYPE's own SYSTEM/PUBLIC identifier — the conventional SVG DTD
 * boilerplate — is not a rendered resource and is ignored by the browser's
 * image path, so it does not block import. Returns the index to resume the
 * document walk from.
 */
function scanDoctype(text: string, start: number, out: Collector): number {
  // Quote-aware walk from the declaration's start: the subset opens at a `[`
  // OUTSIDE a quoted SystemLiteral — `<!DOCTYPE svg SYSTEM "x[y">` is
  // well-formed XML, and treating its quoted `[` as a subset start would
  // swallow the rest of the document and silently skip every reference in it.
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
  if (subsetStart !== -1 && (firstGt === -1 || subsetStart < firstGt)) {
    // Internal subset: scan to the subset's closing `]`, quote-aware, then
    // the declaration's own `>` after it. An unterminated subset is
    // malformed XML (the browser decode gate refuses it later), but the
    // scan still falls back to the next `>` so the rest of the document —
    // and any references in it — is never skipped.
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
      const gt = text.indexOf(">", subsetStart);
      end = gt === -1 ? text.length : gt + 1;
    } else {
      const gt = text.indexOf(">", j);
      end = gt === -1 ? text.length : gt + 1;
    }
  } else {
    end = firstGt === -1 ? text.length : firstGt + 1;
  }

  const region = text.slice(start, end);
  // Quote-aware SYSTEM/PUBLIC keyword search over the whole declaration.
  let kwQuote: string | undefined;
  for (let i = 0; i < region.length; i++) {
    const c = region[i]!;
    if (kwQuote !== undefined) {
      if (c === kwQuote) kwQuote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      kwQuote = c;
      continue;
    }
    if (c !== "S" && c !== "s" && c !== "P" && c !== "p") continue;
    const keyword = /^(SYSTEM|PUBLIC)\b/i.exec(region.slice(i, i + 7));
    if (!keyword) continue;
    // A declaration keyword is inside an ENTITY declaration when the nearest
    // opening `<` begins one — only that construct can change the document's
    // content when its external replacement text resolves.
    const lastLt = region.lastIndexOf("<", i);
    const inEntity = lastLt !== -1 && /^<\s*!entity/i.test(region.slice(lastLt, lastLt + 30));
    if (inEntity && !out.capped()) {
      // A SYSTEM declaration names one URI; a PUBLIC declaration names a
      // public identifier followed by the system URI that is the actual
      // fetch target — name the system URI, falling back to the first
      // quoted literal.
      const literals = quotedAfter(region, i + keyword[1]!.length);
      const target =
        (keyword[1]!.toUpperCase() === "PUBLIC" ? literals[1] : literals[0]) ??
        literals[0] ??
        "(unquoted external identifier)";
      out.push("external entity declaration", target, start + i);
    }
    i += keyword[1]!.length;
  }
  return end;
}

/** CSS text scan: every `url()` target and `@import` string, with a url()
 *  inside an `@font-face` block named as the font case. */
function scanCss(css: string, baseOffset: number, out: Collector): void {
  const decoded = decodeXmlEntities(css);
  const fontFaceRanges: Array<[number, number]> = [];
  for (const m of decoded.matchAll(/@font-face\b/gi)) {
    const open = decoded.indexOf("{", m.index);
    const close = open === -1 ? -1 : decoded.indexOf("}", open);
    fontFaceRanges.push([open === -1 ? m.index : open, close === -1 ? decoded.length : close]);
  }
  const kindFor = (pos: number): string =>
    fontFaceRanges.some(([a, b]) => pos >= a && pos <= b)
      ? "font reference (@font-face src)"
      : "CSS url() reference";

  for (const m of decoded.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi)) {
    const target = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const refused = externalTarget(target);
    if (refused !== undefined) out.push(kindFor(m.index), refused, baseOffset + m.index);
  }
  // @import with a plain string target; the url() form is covered above.
  for (const m of decoded.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const target = (m[1] ?? m[2] ?? "").trim();
    const refused = externalTarget(target);
    if (refused !== undefined) out.push("stylesheet @import", refused, baseOffset + m.index);
  }
}

/** The attributes whose values are resource references, by local name
 *  (namespace prefix stripped, case-folded): both href spellings via href,
 *  foreignObject HTML via src/data/srcset, and xml:base (it silently
 *  re-roots every relative reference in its scope). */
const REFERENCE_ATTRS = new Set(["href", "src", "data", "srcset", "base", "poster"]);

/** Scan one start tag's attribute region. */
function scanAttrs(tag: string, attrs: string, baseOffset: number, out: Collector): void {
  const attrRe = /([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  for (const m of attrs.matchAll(attrRe)) {
    const rawName = m[1]!;
    const local = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;
    const lower = local.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined) continue;
    if (lower === "style") {
      scanCss(value, baseOffset + (m.index ?? 0), out);
      continue;
    }
    if (!REFERENCE_ATTRS.has(lower)) continue;
    const refused = externalTarget(value);
    if (refused !== undefined) {
      const kind =
        tag === "use"
          ? "use target outside the file"
          : lower === "base"
          ? "xml:base reference"
          : `${lower} on <${tag}>`;
      out.push(kind, refused, baseOffset + (m.index ?? 0));
    }
  }
}

/**
 * The one out-of-file reference scan over an SVG document's text: comments
 * stripped (a URL in a comment is not a reference), script bodies skipped
 * (a script never blocks import and its source is inert text), style bodies
 * CSS-scanned, everything else walked for reference-bearing attributes,
 * processing instructions, and external entity declarations. Every finding
 * is collected — the refusal names EACH reference, not the first.
 */
export function scanSvgExternalReferences(bytes: Buffer, file: string): string | undefined {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = stripComments(text);
  const lower = text.toLowerCase();
  const findings: ExternalRef[] = [];
  const seen = new Set<string>();
  let capped = false;
  // 1-based line of an offset: a lazy newline index (one O(n) pass, built
  // only when a first finding needs it) and a binary search per finding —
  // never a rescan of the document per reference.
  let lineIndex: number[] | undefined;
  const lineAt = (offset: number): number => {
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
  const out: Collector = {
    push(kind, target, offset) {
      if (findings.length >= MAX_COLLECTED) {
        capped = true;
        return;
      }
      // The named target is bounded and stripped of control characters: a
      // huge or control-bearing attribute value cannot blow up the refusal
      // message or spoof its line structure.
      const cleaned =
        target.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, TARGET_MAX) +
        (target.length > TARGET_MAX ? "…" : "");
      const key = `${kind}\n${cleaned}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ kind, target: cleaned, line: lineAt(offset) });
    },
    capped: () => capped,
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (lower.startsWith("<![cdata[", lt)) {
      const close = lower.indexOf("]]>", lt + 9);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (lower.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      const body = text.slice(lt + 2, close === -1 ? text.length : close);
      // The stylesheet processing instruction: its href is a reference.
      if (/^[\s]*xml-stylesheet\b/i.test(body)) {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
        const target = href ? (href[1] ?? href[2] ?? "") : undefined;
        if (href === undefined) {
          out.push("xml-stylesheet reference", "(no href)", lt);
        } else {
          const refused = externalTarget(target!);
          if (refused !== undefined) out.push("xml-stylesheet reference", refused, lt);
        }
      }
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (lower.startsWith("<!doctype", lt)) {
      i = scanDoctype(text, lt, out);
      continue;
    }
    if (lower.startsWith("<!", lt) || lower.startsWith("</", lt)) {
      const close = text.indexOf(">", lt);
      i = close === -1 ? text.length : close + 1;
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
    const attrsStart = lt + 1 + nameEnd[1]!.length;
    const attrs = text.slice(attrsStart, j < text.length ? j : text.length);
    const selfClosing = text[j - 1] === "/";
    if (tag === "script") {
      // A script element — self-closing, paired, src or inline — is never a
      // reference source: a script does not block import and never runs in
      // the image path, so its source text is skipped wholesale. The same
      // rule covers src on <script>: refusing a paired script's src while
      // accepting an inline body would be an inconsistency, not a boundary.
      if (selfClosing) {
        i = j < text.length ? j + 1 : text.length;
        continue;
      }
      const closeTag = lower.indexOf("</script", j);
      if (closeTag === -1) return assemble(findings, capped, file);
      const gt = text.indexOf(">", closeTag);
      i = gt === -1 ? text.length : gt + 1;
      continue;
    }
    scanAttrs(tag, attrs, attrsStart, out);
    if (tag === "style" && !selfClosing) {
      const closeTag = lower.indexOf("</style", j);
      const bodyEnd = closeTag === -1 ? text.length : closeTag;
      scanCss(text.slice(j + 1, bodyEnd), j + 1, out);
      if (closeTag === -1) return assemble(findings, capped, file);
      const gt = text.indexOf(">", closeTag);
      i = gt === -1 ? text.length : gt + 1;
      continue;
    }
    i = j < text.length ? j + 1 : text.length;
  }
  return assemble(findings, capped, file);
}

/** The refusal message: every collected reference named, each with its kind
 *  and line, and the one fix. The message shows the first MESSAGE_CAP
 *  references; when the collection bound was hit it says so — the count it
 *  reports is a lower bound, never an invented total. */
function assemble(findings: ExternalRef[], capped: boolean, file: string): string | undefined {
  if (findings.length === 0) return undefined;
  const shown = findings.slice(0, MESSAGE_CAP);
  const more = findings.length - shown.length;
  return (
    `"${file}" references resources outside itself — import refused. Found:\n` +
    shown.map((f) => `  - ${f.kind} "${f.target}" (line ${f.line})`).join("\n") +
    (capped
      ? `\n  ...and more — the scan stopped listing distinct references at ${MAX_COLLECTED}.`
      : more > 0
      ? `\n  ...and ${more} more reference(s)`
      : "") +
    `\nThe fix: embed each referenced resource as a data URI inside the SVG file, then import again.`
  );
}