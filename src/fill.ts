/**
 * The ONE fill representation (spec #207 DEC-003): a fill is one
 * discriminated value — `solid`, `linear` gradient, or `radial` gradient —
 * normalized at one ingestion boundary. Delivered in #208 with the `solid`
 * variant only; the discriminated shape (and this module, not the shape
 * Layer) owns the representation so gradient fills (#210) and gradient text
 * (ISC-33) reuse it rather than growing a shape-specific second form.
 *
 * Command spelling (spec #207 DEC-009, settled here): `--fill` accepts
 * either a bare hex color or an explicit `solid:` discriminator followed by
 * the color — `#22c55e` and `solid:#22c55e` are the same fill. The
 * discriminator prefix is the one grammar the gradient variants will join
 * (e.g. `linear:...`), so a later gradient never re-parses bare strings.
 */

/** The canonical fill value every consumer reads. One discriminated union;
 *  `solid` paints one hex color (#RGB/#RRGGBB/#RRGGBBAA — alpha allowed). */
export type LayerFill = { type: "solid"; color: string };

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

/**
 * Parse a `--fill` spec at the command boundary and at ingestion — the ONE
 * normalization boundary for fills (DEC-003). Accepts a bare hex color or an
 * explicit `solid:` discriminator followed by the color; anything else is
 * refused naming the grammar and the allowed color forms. A malformed color
 * is refused here, before anything is published (US-001).
 */
export function parseFillSpec(spec: string): LayerFill {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error(
      '--fill takes a solid color like "#22c55e" or "solid:#22c55e" (hex #RGB, #RRGGBB, or #RRGGBBAA).',
    );
  }
  const colon = trimmed.indexOf(":");
  const type = colon === -1 ? "solid" : trimmed.slice(0, colon).trim().toLowerCase();
  const value = colon === -1 ? trimmed : trimmed.slice(colon + 1).trim();
  if (type !== "solid") {
    throw new Error(
      `Unknown fill type "${type}": #208 delivers the solid fill — use a hex color like "#22c55e" or "solid:#22c55e".`,
    );
  }
  if (!FILL_COLOR_PATTERN.test(value)) {
    throw new Error(
      `Invalid fill color "${value}": a solid fill takes a hex color like #22c55e, #2c5, or #22c55e80 (got "${spec.trim()}").`,
    );
  }
  return { type: "solid", color: canonicalizeFillColor(value) };
}

/**
 * Canonical stored-fill validation and normalization: the one boundary every
 * stored revision document's `fill` field projects through. A present field
 * must be a valid fill object of a known type — anything else is a malformed
 * document, refused loudly before the revision hash is consulted. Absence is
 * never normalized here: a shape revision's fill is a required field, so a
 * missing fill is the caller's malformed-document error (raised by the shape
 * normalizer). The canonical colour form (lowercase, #RGB expanded) is
 * enforced here too — the same recipe the ingestion parser applies — so a
 * stored shorthand and a freshly ingested equivalent fill project to ONE
 * form (the same content identity, fill equality, and revision-hash
 * encoding). No shipped documents carry a fill: the field is new in #208.
 */
export function normalizeStoredFill(value: unknown): LayerFill {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Malformed revision document: fill must be a fill object when present (got ${JSON.stringify(value)}).`,
    );
  }
  const raw = value as Record<string, unknown>;
  if (raw.type !== "solid") {
    throw new Error(
      `Malformed revision document: fill.type must be a known fill type (got ${JSON.stringify(raw.type)}).`,
    );
  }
  if (typeof raw.color !== "string" || !FILL_COLOR_PATTERN.test(raw.color)) {
    throw new Error(
      `Malformed revision document: fill.color must be a hex color like #22c55e, #2c5, or #22c55e80 (got ${JSON.stringify(raw.color)}).`,
    );
  }
  return { type: "solid", color: canonicalizeFillColor(raw.color) };
}