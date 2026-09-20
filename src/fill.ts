/**
 * The ONE fill representation (spec #207 DEC-003): a fill is one
 * discriminated value — `solid`, `linear` gradient, or `radial` gradient —
 * normalized at one ingestion boundary. The `solid` variant shipped in #208;
 * #210 joins the gradient variants. This module, not the shape Layer, owns
 * the representation so gradient text (ISC-33) reuses it rather than growing
 * a shape-specific second form.
 *
 * Command spelling (spec #207 DEC-009, settled here): `--fill` accepts either
 * a bare hex color or an explicit discriminator followed by the fill —
 *
 *   #22c55e              the same as solid:#22c55e
 *   solid:#22c55e        one hex color (#RGB/#RRGGBB/#RRGGBBAA — alpha)
 *   linear:45deg,<stop>,<stop>[,...]
 *                        a linear gradient: an angle in degrees, then two or
 *                        more comma-separated stops
 *   radial:<stop>,<stop>[,...]
 *                        a radial gradient: two or more comma-separated
 *                        stops (no angle — the gradient radiates from the
 *                        content box's centre)
 *
 * A stop is `<color>` or `<color>:<position>`, where position is 0–100
 * percent (the `%` suffix is optional). A stop colour takes the same hex
 * forms as a solid (#RGB/#RRGGBB/#RRGGBBAA — alpha is first-class). Omitted
 * positions are distributed evenly — every position omitted means first
 * stop 0 and last stop 100 (the CSS default); otherwise each omitted run
 * interpolates evenly between the surrounding explicit positions (0 at the
 * start, 100 at the end). Explicit positions, after that resolution, must
 * not decrease — CSS would clamp a decreasing list silently, and the stored
 * form must describe the paint.
 */

/** One gradient stop in canonical form: a hex color and its position
 * (0–100, percent of the gradient line, kept as a number). */
export type LayerFillStop = { color: string; position: number };

/** The canonical fill value every consumer reads. One discriminated union;
 *  `solid` paints one hex color; `linear` paints a linear gradient over the
 *  content box at `angleDeg` (degrees clockwise from bottom-to-top, the CSS
 *  convention, normalized to 0–360); `radial` paints a circle centered on
 *  the content box whose radius reaches the box's farthest side. Every stop
 *  stores its resolved position, so the canonical form is self-describing. */
export type LayerFill =
  | { type: "solid"; color: string }
  | { type: "linear"; angleDeg: number; stops: LayerFillStop[] }
  | { type: "radial"; stops: LayerFillStop[] };

/** The known fill discriminators (the union's arms, one home). */
export const FILL_TYPES = ["solid", "linear", "radial"] as const;

/**
 * The fill color grammar: the same hex forms the effects use
 * (#RGB/#RRGGBB/#RRGGBBAA). Alpha is a first-class part of a fill.
 */
export const FILL_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Canonical color form (the established effect-color recipe, #140): lowercase
 * hex with `#RGB` expanded to `#RRGGBB`, applied at the ONE ingestion boundary
 * (`parseFillSpec`). Case and shorthand variants of the same paint can no
 * longer hash into redundant revisions.
 */
function canonicalizeFillColor(color: string): string {
  const lower = color.toLowerCase();
  if (lower.length === 4) {
    // #RGB → #RRGGBB: duplicate each digit.
    const [, r, g, b] = lower;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

/** Parse one comma-separated stop token: `<color>` or `<color>:<position>`.
 *  Returns the canonicalized colour plus a parsed-or-absent position. */
function parseGradientStop(token: string, label: string): { color: string; position?: number } {
  const colon = token.indexOf(":");
  const colorPart = colon === -1 ? token : token.slice(0, colon);
  const positionPart = colon === -1 ? undefined : token.slice(colon + 1);
  if (!FILL_COLOR_PATTERN.test(colorPart)) {
    throw new Error(
      `Invalid ${label} stop colour "${colorPart}": a stop takes a hex color like #22c55e, #2c5, or #22c55e80 (alpha allowed).`,
    );
  }
  if (positionPart === undefined || positionPart === "") {
    return { color: canonicalizeFillColor(colorPart) };
  }
  const withUnit = positionPart.endsWith("%") ? positionPart.slice(0, -1) : positionPart;
  // Strict decimal only: Number() would read 0x10 as 16 and 1e2 as 100 —
  // spellings outside the documented 0–100 percent grammar.
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(withUnit.trim()) ||
      !Number.isFinite(Number(withUnit)) ||
      Number(withUnit) < 0 ||
      Number(withUnit) > 100) {
    throw new Error(
      `Invalid ${label} stop position "${positionPart}" (stop colour ${canonicalizeFillColor(colorPart)}): must be a number between 0 and 100 (percent of the gradient line).`,
    );
  }
  return { color: canonicalizeFillColor(colorPart), position: Number(withUnit) };
}

/**
 * The ONE single-colour ingestion point (the fill grammar's solid arm): a
 * vector colour (#215, spec #207 US-005, DEC-008) takes one hex color — the
 * same grammar a fill's solid arm and a gradient stop take (#RGB/#RRGGBB/
 * #RRGGBBAA, alpha first-class, canonicalized at this one boundary). Reusing
 * `parseFillSpec` keeps ONE colour parser: a gradient spec is refused here
 * naming the control gradients belong to (a shape's `--fill`), so the vector
 * colour can never grow a second colour grammar.
 */
export function parseFillColorSpec(spec: string, what: string): string {
  const fill = parseFillSpec(spec);
  if (fill.type !== "solid") {
    throw new Error(
      `Invalid ${what} "${spec.trim()}": a vector colour takes one hex color like #22c55e, #2c5, or #22c55e80 (alpha allowed) — ` +
        `a gradient paints a shape Layer's --fill, not a vector colour.`,
    );
  }
  return fill.color;
}

/** Canonicalize a stop list for storage: ≥2 stops, every position present,
 *  non-decreasing. Shared by the command-boundary parser and the stored-fill
 *  normalizer. */
function canonicalizeStops(stops: LayerFillStop[], label: string): LayerFillStop[] {
  if (stops.length < 2) {
    throw new Error(
      `Invalid ${label} gradient: it needs at least two stops (got ${stops.length}) — a gradient interpolates between colours.`,
    );
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.position < stops[i - 1]!.position) {
      throw new Error(
        `Invalid ${label} gradient: stop positions must not decrease (${stops[i - 1]!.color} at ${stops[i - 1]!.position} is followed by ${stops[i]!.color} at ${stops[i]!.position}).`,
      );
    }
  }
  return stops;
}

/** Canonicalize a gradient angle to 0–360 (CSS degrees clockwise from
 *  bottom-to-top): equivalent angles normalize to one form, so `-45deg` and
 *  `315deg` hash to the same fill. */
function canonicalizeAngleDeg(angleDeg: number): number {
  const normalized = ((angleDeg % 360) + 360) % 360;
  // -0 normalizes to 0 so equivalent forms hash identically.
  return normalized === 0 ? 0 : normalized;
}

/** Split the comma-separated stop tokens, refusing empty segments (a
 *  typo'd double or trailing comma would otherwise be silently dropped,
 *  erasing the fault this boundary exists to name). */
function splitStopTokens(value: string, type: "linear" | "radial"): string[] {
  const tokens = value.split(",").map((t) => t.trim());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "") {
      throw new Error(
        `Invalid ${type} gradient: an empty stop at comma ${i + 1} — every comma must be followed by a stop (got "${value}").`,
      );
    }
  }
  return tokens;
}

/**
 * Parse a `--fill` spec at the command boundary and at ingestion — the ONE
 * normalization boundary for fills (DEC-003). Accepts a bare hex color, an
 * explicit `solid:` discriminator followed by the color, or a gradient
 * (`linear:<angle>deg,...` / `radial:<stop>,...` — see the module
 * docstring for the grammar). Anything else is refused naming the fault and
 * the grammar; a malformed colour, a lone stop, or an out-of-range position
 * is refused here, before anything is published (US-001).
 */
export function parseFillSpec(spec: string): LayerFill {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error(
      '--fill takes a solid color like "#22c55e", "solid:#22c55e", or a gradient like "linear:45deg,#ff0000,#00ff00" or "radial:#ff0000,#00ff00".',
    );
  }
  const colon = trimmed.indexOf(":");
  const type = colon === -1 ? "solid" : trimmed.slice(0, colon).trim().toLowerCase();
  const value = colon === -1 ? trimmed : trimmed.slice(colon + 1).trim();
  if (colon === -1 && /^(linear|radial)\b/i.test(trimmed)) {
    throw new Error(
      `Unknown fill type "${trimmed.split(",")[0]!}": a gradient needs the discriminator prefix followed by a colon — "linear:45deg,#ff0000,#00ff00" or "radial:#ff0000,#00ff00".`,
    );
  }
  if (!FILL_TYPES.includes(type as (typeof FILL_TYPES)[number])) {
    throw new Error(
      `Unknown fill type "${type}": known fill types are solid (or a bare hex color like "#22c55e"), linear, and radial — e.g. "linear:45deg,#ff0000,#00ff00".`,
    );
  }
  if (type === "solid") {
    if (!FILL_COLOR_PATTERN.test(value)) {
      throw new Error(
        `Invalid fill color "${value}": a solid fill takes a hex color like #22c55e, #2c5, or #22c55e80 (got "${spec.trim()}").`,
      );
    }
    return { type: "solid", color: canonicalizeFillColor(value) };
  }
  if (!value) {
    throw new Error(
      type === "linear"
        ? `A linear gradient needs an angle and at least two stops: "linear:45deg,#ff0000,#00ff00" (got "${spec.trim()}").`
        : `A radial gradient needs at least two stops: "radial:#ff0000,#00ff00" (got "${spec.trim()}").`,
    );
  }
  const kind = type as "linear" | "radial";
  const tokens = splitStopTokens(value, kind);
  if (type === "linear") {
    const angleMatch = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))deg$/i.exec(tokens[0] ?? "");
    if (angleMatch === null) {
      throw new Error(
        `Invalid linear gradient: the first part must be an angle in degrees like "45deg" (got "${tokens[0] ?? ""}") — e.g. "linear:45deg,#ff0000,#00ff00".`,
      );
    }
    const angleRaw = Number(angleMatch[1]);
    if (!Number.isFinite(angleRaw)) {
      throw new Error(
        `Invalid linear gradient: the angle must be a finite number of degrees (got "${tokens[0]}") — e.g. "linear:45deg,#ff0000,#00ff00".`,
      );
    }
    const angleDeg = canonicalizeAngleDeg(angleRaw);
    if (tokens.length < 3) {
      throw new Error(
        `Invalid linear gradient: it needs an angle plus at least two colour stops (got ${tokens.length - 1} stop${tokens.length - 1 === 1 ? "" : "s"}) — e.g. "linear:45deg,#ff0000,#00ff00".`,
      );
    }
    const stops = tokens
      .slice(1)
      .map((t) => parseGradientStop(t, "linear gradient"))
      .map((s) => ({ color: s.color, position: s.position ?? NaN }));
    return {
      type: "linear",
      angleDeg,
      stops: canonicalizeStops(resolveMissing(stops), "linear"),
    };
  }
  // radial
  const degToken = tokens.find((t) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)deg$/i.test(t));
  if (degToken !== undefined) {
    throw new Error(
      `Invalid radial gradient: a radial gradient takes no angle (got "${degToken}") — it radiates from the content box's centre — e.g. "radial:#ff0000,#00ff00".`,
    );
  }
  if (tokens.length < 2) {
    throw new Error(
      `Invalid radial gradient: it needs at least two colour stops (got ${tokens.length}) — e.g. "radial:#ff0000,#00ff00".`,
    );
  }
  const stops = tokens
    .map((t) => parseGradientStop(t, "radial gradient"))
    .map((s) => ({ color: s.color, position: s.position ?? NaN }));
  return {
    type: "radial",
    stops: canonicalizeStops(resolveMissing(stops), "radial"),
  };
}

/** Resolve omitted stop positions by even interpolation: an all-omitted
 *  stop list distributes evenly across the full gradient line (first stop
 *  0, last stop 100 — the CSS default); a mixed list interpolates each
 *  omitted run evenly between its surrounding explicit positions (0 at
 *  the start, 100 at the end), so `#f00:90,#0f0,#00f:100` puts the middle
 *  stop at 95 — not 50, which would falsely read as decreasing. The form
 *  painted, so the stored stops always carry explicit positions. */
function resolveMissing(
  stops: { color: string; position: number }[],
): LayerFillStop[] {
  if (stops.every((s) => Number.isNaN(s.position))) {
    const n = stops.length;
    return stops.map(
      (s, i) => ({ color: s.color, position: (i / (n - 1)) * 100 }),
    );
  }
  const resolved: LayerFillStop[] = [];
  let left = 0;
  let i = 0;
  while (i < stops.length) {
    if (!Number.isNaN(stops[i]!.position)) {
      left = stops[i]!.position;
      resolved.push(stops[i]!);
      i++;
      continue;
    }
    // One omitted run: stops[i..j) all carry the NaN sentinel.
    let j = i;
    while (j < stops.length && Number.isNaN(stops[j]!.position)) j++;
    const right = j < stops.length ? stops[j]!.position : 100;
    const m = j - i;
    for (let k = i; k < j; k++) {
      resolved.push({
        color: stops[k]!.color,
        position: left + ((right - left) * (k - i + 1)) / (m + 1),
      });
    }
    left = right;
    i = j;
  }
  return resolved;
}

/**
 * Canonical stored-fill validation and normalization: the one boundary every
 * stored revision document's `fill` field projects through. A present field
 * must be a valid fill object of a known type — anything else is a malformed
 * document, refused loudly before the revision hash is consulted. Absence is
 * never normalized here: a shape revision's fill is a required field, so a
 * missing fill is the caller's malformed-document error (raised by the shape
 * normalizer). The canonical colour form (lowercase, #RGB expanded) and the
 * canonical gradient form (angle in 0–360, every stop position a number in
 * 0–100) are enforced here too — the same recipes the ingestion parser
 * applies — so a stored shorthand and a freshly ingested equivalent fill
 * project to ONE form (the same content identity, fill equality, and
 * revision-hash encoding). No shipped documents carry a gradient: the
 * gradient variants are new in #210, added to the fill union additively
 * (DEC-010) — every #208 solid document validates exactly as before.
 */
export function normalizeStoredFill(value: unknown): LayerFill {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Malformed revision document: fill must be a fill object when present (got ${JSON.stringify(value)}).`,
    );
  }
  const raw = value as Record<string, unknown>;
  if (!FILL_TYPES.includes(raw.type as (typeof FILL_TYPES)[number])) {
    throw new Error(
      `Malformed revision document: fill.type must be a known fill type (got ${JSON.stringify(raw.type)}).`,
    );
  }
  if (raw.type === "solid") {
    if (typeof raw.color !== "string" || !FILL_COLOR_PATTERN.test(raw.color)) {
      throw new Error(
        `Malformed revision document: fill.color must be a hex color like #22c55e, #2c5, or #22c55e80 (got ${JSON.stringify(raw.color)}).`,
      );
    }
    return { type: "solid", color: canonicalizeFillColor(raw.color) };
  }
  const label = raw.type as "linear" | "radial";
  if (label === "linear") {
    if (typeof raw.angleDeg !== "number" || !Number.isFinite(raw.angleDeg) || raw.angleDeg < 0 || raw.angleDeg >= 360) {
      throw new Error(
        `Malformed revision document: fill.angleDeg must be a finite number between 0 and 360 (got ${JSON.stringify(raw.angleDeg)}).`,
      );
    }
  }
  if (!Array.isArray(raw.stops) || raw.stops.length < 2) {
    throw new Error(
      `Malformed revision document: fill.stops must be an array of at least two stops (got ${JSON.stringify(raw.stops)}).`,
    );
  }
  const stops = raw.stops.map((stop, i) => {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
      throw new Error(
        `Malformed revision document: fill.stops[${i}] must be a stop object (got ${JSON.stringify(stop)}).`,
      );
    }
    const s = stop as Record<string, unknown>;
    if (typeof s.color !== "string" || !FILL_COLOR_PATTERN.test(s.color)) {
      throw new Error(
        `Malformed revision document: fill.stops[${i}].color must be a hex color like #22c55e, #2c5, or #22c55e80 (got ${JSON.stringify(s.color)}).`,
      );
    }
    if (typeof s.position !== "number" || !Number.isFinite(s.position) || s.position < 0 || s.position > 100) {
      throw new Error(
        `Malformed revision document: fill.stops[${i}].position must be a finite number between 0 and 100 (got ${JSON.stringify(s.position)}).`,
      );
    }
    return { color: canonicalizeFillColor(s.color), position: s.position };
  });
  const canonical = canonicalizeStops(stops, label);
  return label === "linear"
    ? { type: "linear", angleDeg: raw.angleDeg as number, stops: canonical }
    : { type: "radial", stops: canonical };
}

/** Strict equality of two canonical fills — the whole identity of a fill
 *  (type, and per variant the angle or every stop). The edit idempotence
 *  check uses this so gradient edits never false-idempotent. */
export function fillsEqual(a: LayerFill, b: LayerFill): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "solid" && b.type === "solid") return a.color === b.color;
  if (a.type === "linear" && b.type === "linear") {
    return (
      a.angleDeg === b.angleDeg &&
      a.stops.length === b.stops.length &&
      a.stops.every((s, i) => s.color === b.stops[i]!.color && s.position === b.stops[i]!.position)
    );
  }
  if (a.type === "radial" && b.type === "radial") {
    return (
      a.stops.length === b.stops.length &&
      a.stops.every((s, i) => s.color === b.stops[i]!.color && s.position === b.stops[i]!.position)
    );
  }
  return false;
}

/**
 * The fill's encoding inside a shape content identity / revision id (DEC-001):
 * one deterministic string per canonical fill. The solid form is unchanged
 * from #208 (`solid:#22c55e`), so existing solid-fill revision ids do not
 * move (DEC-010); the gradient forms extend the encoding additively.
 */
export function fillIdentityString(fill: LayerFill): string {
  if (fill.type === "solid") return `solid:${fill.color}`;
  const stopList = fill.stops.map((s) => `${s.color} ${s.position}%`).join(",");
  return fill.type === "linear" ? `linear:${fill.angleDeg}deg:${stopList}` : `radial:${stopList}`;
}

/** Human-readable one-line form for `inspect`, `measure`, and review
 *  reporting: `solid #22c55e`, `linear 90deg #ff0000 0%, #00ff00 100%`,
 *  `radial #ff0000 0%, #00ff00 100%`. */
export function formatFill(fill: LayerFill): string {
  if (fill.type === "solid") return `solid ${fill.color}`;
  const stopList = fill.stops.map((s) => `${s.color} ${s.position}%`).join(", ");
  return fill.type === "linear" ? `linear ${fill.angleDeg}deg ${stopList}` : `radial ${stopList}`;
}

/**
 * The CSS `background` value a fill paints with (the paint projection of the
 * one canonical form — the same value a later gradient text consumer
 * reuses). A solid paints its colour; a linear paints a CSS linear-gradient
 * over the content box at the stored angle; a radial paints a circle
 * centered on the content box whose radius reaches the box's farthest side,
 * so the last stop's colour lands exactly on the box's farthest edge
 * midpoints (only those on the farthest side) and everything beyond them.
 * All colours are validated hex, so the value is
 * markup-safe (no quoting, no user text).
 */
export function fillCssBackground(fill: LayerFill): string {
  if (fill.type === "solid") return fill.color;
  const stopList = fill.stops.map((s) => `${s.color} ${s.position}%`).join(",");
  return fill.type === "linear"
    ? `linear-gradient(${fill.angleDeg}deg,${stopList})`
    : `radial-gradient(circle farthest-side at center,${stopList})`;
}