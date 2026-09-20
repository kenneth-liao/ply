/**
 * Bounded SVG parsing for vector image ingestion (#213, spec #207 US-004,
 * DEC-007): an SVG file accepted at the one image ingestion point is parsed —
 * never validated as a whole — for exactly the facts the Layer machinery
 * needs: the intrinsic pixel size from the file's own `width`/`height`
 * attributes or, when those are unusable, its `viewBox`.
 *
 * The parse is text-level and bounds-checked like src/raster-meta.ts: a
 * malformed or non-SVG file with an `.svg` name is a refusal naming the
 * problem, never a guess and never a throw past the caller. No XML parser is
 * pulled in: the root start tag is located with a quote-aware scan, and the
 * three consumed attributes are read from it alone. Everything else in the
 * file is opaque — the browser's own `<img>` decode (the paint path, which
 * disables scripts and external loads by construction) is the well-formedness
 * gate, run once at ingestion.
 *
 * The returned geometry feeds the same dimension gates a raster header feeds,
 * and the format fact `"svg"` rides the same resolved projection the raster
 * sniff produces — an SVG is image-kind content with a vector format, not a
 * fourth kind (DEC-007).
 */

export type SvgFormat = "svg";

export interface SvgMeta {
  format: SvgFormat;
  width: number;
  height: number;
}

/** CSS absolute-length units to px at 96 px/in — the same conversion every
 *  CSS renderer applies. Percentages and font-relative units are not
 *  intrinsic pixel facts, so they are unusable here (the viewBox decides). */
const ABSOLUTE_UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

/** Parse one viewBox attribute: four finite numbers separated by whitespace
 *  and/or commas, with positive width and height. Returns undefined for
 *  anything else. */
function parseViewBox(raw: string): { width: number; height: number } | undefined {
  const parts = raw.trim().split(/[\s,]+/);
  if (raw.trim() === "" || parts.length !== 4 || parts.some((p) => p === "")) return undefined;
  const [x, y, w, h] = parts.map(Number);
  if (
    x === undefined || y === undefined || w === undefined || h === undefined ||
    ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0
  ) {
    return undefined;
  }
  return { width: w, height: h };
}

/** Parse one SVG length: a finite positive number in a unit the conversion
 *  table knows. Returns undefined for anything else — a fallback to the
 *  next source, never a guess. */
function parseLength(raw: string): number | undefined {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([a-zA-Z%]+))?$/.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const factor = match[2] === undefined ? ABSOLUTE_UNIT_PX[""] : ABSOLUTE_UNIT_PX[match[2]];
  if (factor === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value * factor;
}

interface RootStartTag {
  /** The attributes region between `<svg` and the tag's closing `>`. */
  attrs: string;
  /** The root element closes itself (`<svg .../>`), which stands in for the
   *  truncation scan's `</svg>` check. */
  selfClosing: boolean;
}

/**
 * The root `<svg>` start tag's attributes, found past exactly the prolog a
 * real SVG file may carry: a byte-order mark, whitespace, an XML declaration,
 * comments, a DOCTYPE. Anything else before the first tag — text, garbage,
 * another element — is not an SVG document. Returns undefined when no `svg`
 * start tag is the first element or the tag itself is malformed.
 */
function findRootStartTag(bytes: Buffer): RootStartTag | undefined {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<")) return undefined;
  let i = 0;
  for (;;) {
    // Whitespace between prolog constructs is allowed.
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    if (i >= trimmed.length || trimmed[i] !== "<") return undefined;
    const rest = trimmed.slice(i);
    if (rest.startsWith("<?")) {
      const end = rest.indexOf("?>");
      if (end === -1) return undefined; // unterminated declaration — malformed
      i += end + 2;
      continue;
    }
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end === -1) return undefined;
      i += end + 3;
      continue;
    }
    if (rest.startsWith("<!DOCTYPE") || rest.startsWith("<!doctype")) {
      const end = rest.indexOf(">");
      if (end === -1) return undefined;
      i += end + 1;
      // A DOCTYPE with an internal subset (`<!DOCTYPE svg [ ... ] >`) holds
      // its own `>`-terminated declarations; the subset's `]` closes it.
      const subsetOpen = rest.indexOf("[", 0) !== -1 && rest.indexOf("[") < end;
      if (subsetOpen) {
        const close = trimmed.indexOf("]", i);
        if (close === -1) return undefined;
        i = close + 1;
        // The declaration's own `>` follows the subset's `]`.
        if (trimmed[i] === ">") i += 1;
      }
      continue;
    }
    // The root element: case-sensitive `svg` per the SVG grammar.
    if (!/^<svg[\s>]/.test(rest)) return undefined;
    // Scan to the start tag's closing `>` respecting quoted attribute values —
    // an attribute value may contain `>`, so a naive search is wrong.
    let j = 4;
    let quote: string | undefined;
    while (j < rest.length) {
      const ch = rest[j]!;
      if (quote !== undefined) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    if (j >= rest.length) return undefined; // the start tag never closes
    return { attrs: rest.slice(4, j), selfClosing: rest[j - 1] === "/" };
  }
}

/**
 * Trusted intrinsic geometry from an SVG file's own root attributes —
 * `width`/`height` first, the `viewBox` as the fallback. Every scan is
 * bounds-checked; a malformed, truncated, or non-SVG file is a refusal with
 * an actionable message, never an exception past the caller. The parse reads
 * exactly three attributes; nothing else in the file is interpreted (the
 * external-reference gate is a sibling ticket's concern).
 */
export function readSvgMeta(bytes: Buffer, file: string): SvgMeta | string {
  const root = findRootStartTag(bytes);
  if (!root) {
    return `"${file}" does not start with an <svg> root element — not an SVG document`;
  }
  if (!root.selfClosing && !bytes.toString("utf8").includes("</svg>")) {
    return `"${file}" ends before its <svg> root element closes — truncated, not a real SVG file`;
  }

  const attr = (name: string): string | undefined => {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(root.attrs);
    return match ? (match[2] ?? match[3]) : undefined;
  };

  const width = attr("width") !== undefined ? parseLength(attr("width")!) : undefined;
  const height = attr("height") !== undefined ? parseLength(attr("height")!) : undefined;

  // Intrinsic-size resolution mirrors the browser's own <img> computation
  // exactly, so the parsed facts and the painted box can never disagree:
  // both declared sizes win; one declared size borrows the missing axis from
  // the viewBox's aspect ratio; neither declared size falls back to the
  // viewBox's own pair. Percent and font-relative sizes are not intrinsic
  // pixel facts, so they are unusable, never guessed.
  // The rounded facts must still be placeable: a declared size that rounds
  // below 1 px is a refusal, never a zero-pixel Layer.
  const usable = (w: number, h: number) => w >= 1 && h >= 1;
  if (
    width !== undefined && height !== undefined &&
    usable(width, height)
  ) {
    return { format: "svg", width: Math.round(width), height: Math.round(height) };
  }

  const viewBoxRaw = attr("viewBox");
  const viewBox = viewBoxRaw !== undefined ? parseViewBox(viewBoxRaw) : undefined;
  if (viewBox !== undefined) {
    if (width !== undefined && usable(width, (width * viewBox.height) / viewBox.width)) {
      return {
        format: "svg",
        width: Math.round(width),
        height: Math.round((width * viewBox.height) / viewBox.width),
      };
    }
    if (height !== undefined && usable((height * viewBox.width) / viewBox.height, height)) {
      return {
        format: "svg",
        width: Math.round((height * viewBox.width) / viewBox.height),
        height: Math.round(height),
      };
    }
    if (usable(viewBox.width, viewBox.height)) {
      return { format: "svg", width: Math.round(viewBox.width), height: Math.round(viewBox.height) };
    }
  }

  if (width !== undefined || height !== undefined) {
    const declared = width !== undefined ? `width ${attr("width")}` : `height ${attr("height")}`;
    return (
      `"${file}" declares only ${declared} with no viewBox — add the missing ` +
      `dimension (or a viewBox) to the root <svg> element so Ply can place ` +
      `it, and import again.`
    );
  }
  return (
    `"${file}" declares no usable intrinsic size — add width and height ` +
    `attributes in px to the root <svg> element (or a viewBox) so Ply can ` +
    `place it, and import again.`
  );
}