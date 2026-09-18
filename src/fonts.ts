/**
 * Fonts bundled under assets/fonts/ as OFL-licensed TTFs. Most faces are
 * latin subsets; the Archivo variable face and IBM Plex Mono ship as the
 * exact full upstream files (#179, ADR-0021). Faces load through @font-face
 * from local bytes: no system fonts, no network, and no silent fallback.
 * See assets/fonts/LICENSE.md.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** One axis of a variable font face: the range its bytes actually contain
 * (the no-synthesis boundary, verified against the shipped bytes' fvar
 * table in test/fonts.test.ts) and the value an omitted control resolves
 * to (#179, ADR-0021). That default is a Ply-side resolution, not the
 * bytes' fvar default — Archivo's fvar default instance is wght 600, while
 * Ply resolves omitted Archivo controls to the ADR-pinned 400/100 and
 * paints the stored axes explicitly, so the fvar default never applies. */
export interface FontAxis {
  min: number;
  max: number;
  default: number;
}

/** A static face: the bytes fix one weight, and there is no width axis.
 * A text revision that retains these bytes stores no axis fields. */
export interface StaticFontFace {
  variant: "static";
  /** The family name the CSS and @font-face rule use. */
  family: string;
  /** The face's real weight — the @font-face declaration and the CSS font-weight use it. */
  weight: number;
  /** File name under assets/fonts/. */
  file: string;
}

/**
 * A variable face: one file carrying many looks along real axis ranges
 * (#179, ADR-0021). A text revision that retains these bytes stores the
 * resolved weight and width it selects; an omitted control resolves to the
 * face's default instance.
 */
export interface VariableFontFace {
  variant: "variable";
  /** The family name the CSS and @font-face rule use. */
  family: string;
  /** File name under assets/fonts/. */
  file: string;
  /** The axes the font actually contains — the one home of its axis facts.
   * Every weight/width control validates against these ranges and nothing
   * else, so Ply never renders a synthesized weight or width. */
  axes: { wght: FontAxis; wdth: FontAxis };
}

export type FontFace = StaticFontFace | VariableFontFace;

/** A static face's implicit width: the face has no width axis, and its
 * single look is the width-100 (normal) instance. The one home for that
 * fact — a carried width of this value across a font switch to a static
 * face changes nothing; any other width is refused (#179, ADR-0021). */
export const STATIC_FACE_WIDTH = 100;

/** The face's default-instance weight — a static face's own weight, or a
 * variable face's `wght` default. The one reader for that fact. */
export function faceDefaultWeight(face: FontFace): number {
  return face.variant === "variable" ? face.axes.wght.default : face.weight;
}

/** Optional weight/width controls on a text Layer (#179, ADR-0021). The
 * same shape flows both ways — callers pass it as controls to
 * `resolveTextAxes`, which returns the resolved axes — so it is one type
 * with two names for its two roles. */
export type TextAxesControls = TextAxes;

/** Resolved text axes: present if and only if the retained face is variable. */
export interface TextAxes {
  weight?: number;
  width?: number;
}

/**
 * The ONE validator for text weight/width controls against a bundled face
 * (#179, ADR-0021): a variable face resolves omitted controls to its default
 * instance and refuses anything outside the axis ranges it actually contains;
 * a static face accepts only its own weight and refuses width outright — the
 * bytes already fix the look. Every refusal names the family and the values
 * it allows. Never synthesizes: out-of-range and unsupported values are
 * refused here, before anything is published.
 *
 * Scope note for the one split in that story (#179, INT-FONTS-3): EVERY
 * explicit width is refused on a static face — including the implicit
 * `STATIC_FACE_WIDTH` — because an explicit control must name a width the
 * face has. The edit path's carried-axes rule (`resolveEditTextAxes` in
 * src/layer.ts) tolerates a carried width equal to `STATIC_FACE_WIDTH` as
 * nothing-to-store, since a static look IS the width-100 instance; that
 * carry tolerance is edit semantics, deliberately not part of this
 * validator. #187 did extend the control surface alongside this validator
 * (as this note directed, never a second weight/width validator) — but its
 * tracking/line-height controls are font-independent (ADR-0021: stored only
 * when set, validated against fixed Ply ranges, not a face's bytes), so they
 * live in their own one validator, `resolveTextTypographyControls` in
 * src/layer.ts, shared by the add path, the edit path, and both CLI
 * boundaries.
 */
export function resolveTextAxes(face: FontFace, controls: TextAxesControls): TextAxes {
  for (const name of ["weight", "width"] as const) {
    const value = controls[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Invalid ${name} ${value} for font "${face.family}": must be a finite number.`);
    }
  }
  if (face.variant === "variable") {
    const weight = controls.weight ?? face.axes.wght.default;
    const width = controls.width ?? face.axes.wdth.default;
    if (weight < face.axes.wght.min || weight > face.axes.wght.max) {
      throw new Error(
        `Font "${face.family}" supports weight ${face.axes.wght.min}-${face.axes.wght.max} — weight ${weight} is out of range.`,
      );
    }
    if (width < face.axes.wdth.min || width > face.axes.wdth.max) {
      throw new Error(
        `Font "${face.family}" supports width ${face.axes.wdth.min}-${face.axes.wdth.max} — width ${width} is out of range.`,
      );
    }
    return { weight, width };
  }
  if (controls.width !== undefined) {
    throw new Error(
      `Font "${face.family}" is a static face at weight ${face.weight} — it has no width axis; width is not supported.`,
    );
  }
  if (controls.weight !== undefined && controls.weight !== face.weight) {
    throw new Error(
      `Font "${face.family}" is a static face at weight ${face.weight} — weight ${controls.weight} is not available.`,
    );
  }
  return {};
}

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

/**
 * Every bundled face keyed by family — the single home of font facts. Scene
 * text layers can only name fonts whose bytes the renderer ships.
 */
const FACES: FontFace[] = [
  { variant: "static", family: "Source Sans 3", weight: 600, file: "source-sans-3.ttf" },
  { variant: "static", family: "Anton", weight: 400, file: "anton.ttf" },
  { variant: "static", family: "Archivo Black", weight: 400, file: "archivo-black.ttf" },
  { variant: "static", family: "Oswald", weight: 700, file: "oswald.ttf" },
  { variant: "static", family: "Passion One", weight: 900, file: "passion-one.ttf" },
  { variant: "static", family: "Permanent Marker", weight: 400, file: "permanent-marker.ttf" },
  { variant: "static", family: "Bevan", weight: 400, file: "bevan.ttf" },
  { variant: "static", family: "Lora", weight: 700, file: "lora.ttf" },
  { variant: "static", family: "Nunito Sans", weight: 700, file: "nunito-sans.ttf" },
  { variant: "static", family: "Alegreya", weight: 900, file: "alegreya.ttf" },
  { variant: "static", family: "Marcellus", weight: 400, file: "marcellus.ttf" },
  { variant: "static", family: "Bitter", weight: 700, file: "bitter.ttf" },
  { variant: "static", family: "Montserrat", weight: 600, file: "montserrat.ttf" },
  // Groundline faces (#179, ADR-0021): the Archivo variable font ships as
  // the exact full upstream file — one file, many looks. IBM Plex Mono is
  // the static Medium cut.
  {
    variant: "variable",
    family: "Archivo",
    file: "Archivo[wdth,wght].ttf",
    axes: { wght: { min: 100, max: 900, default: 400 }, wdth: { min: 62, max: 125, default: 100 } },
  },
  { variant: "static", family: "IBM Plex Mono", weight: 500, file: "IBMPlexMono-Medium.ttf" },
];

export const BUNDLED_FACES: ReadonlyMap<string, FontFace> = new Map(
  FACES.map((face) => [face.family, face]),
);

/**
 * Resolve a text layer's font family to its bundled face. Throws naming the
 * available families when nothing matches, so a Scene never falls back silently.
 */
export function resolveFace(family: string): FontFace {
  const hit = BUNDLED_FACES.get(family);
  if (hit) return hit;
  throw new Error(
    `unknown font family "${family}" — bundled families: ${[...BUNDLED_FACES.keys()].join(", ")}`,
  );
}

export function fontAssetPath(face: FontFace): string {
  return path.join(FONTS_DIR, face.file);
}

/**
 * Single gate for bundled bytes: throws the one canonical message naming the
 * family when its file is absent. Returns the resolved file path.
 */
function requireFontAsset(face: FontFace): string {
  const file = fontAssetPath(face);
  if (!existsSync(file)) {
    throw new Error(
      `Font "${face.family}" is not bundled: assets/fonts/${face.file} is missing`,
    );
  }
  return file;
}

// data: URIs are pure per file — encode once, reuse across a batch sweep.
const dataUriCache = new Map<string, string>();

function fontDataUri(face: FontFace): string {
  const file = requireFontAsset(face);
  let uri = dataUriCache.get(file);
  if (!uri) {
    uri = `data:font/ttf;base64,${readFileSync(file).toString("base64")}`;
    dataUriCache.set(file, uri);
  }
  return uri;
}

/** Reads the bundled bytes and throws naming the family when they are
 * absent. `weight` is a static face's own weight; for a variable face it is
 * the default-instance weight (a convenient fallback for callers without
 * stored axes — a text Layer's real look is its revision's stored axes,
 * never this number). */
export function readFontAsset(face: FontFace): { family: string; weight: number; dataUri: string } {
  return {
    family: face.family,
    weight: faceDefaultWeight(face),
    dataUri: fontDataUri(face),
  };
}

/**
 * Resolve a retained font's bundled face by its content hash (#179, ADR-0021):
 * retained text bytes are the only font identity, and this is the one lookup
 * from those bytes back to the face facts the registry holds. Returns
 * undefined when the hash matches no bundled face — the caller decides
 * whether that is a refusal or a tolerated legacy blob.
 */
const contentHashIndex = new Map<string, FontFace>();
let contentHashIndexBuilt = false;
export function faceByContentHash(contentHash: string): FontFace | undefined {
  if (!contentHashIndexBuilt) {
    for (const face of BUNDLED_FACES.values()) {
      contentHashIndex.set(
        createHash("sha256").update(fontAssetBytes(face)).digest("hex"),
        face,
      );
    }
    contentHashIndexBuilt = true;
  }
  return contentHashIndex.get(contentHash);
}

/**
 * Reads the bundled face's raw bytes through the same requireFontAsset gate
 * (#81): callers that retain font bytes into a Project ingest from here, so
 * the bundled directory stays the single font-fact home and retained bytes
 * are exactly the shipped face bytes.
 */
export function fontAssetBytes(face: FontFace): Buffer {
  return readFileSync(requireFontAsset(face));
}

/** @font-face rules for the given faces, each from its bundled bytes. A
 * variable face declares its real axis ranges (`font-weight`/`font-stretch`)
 * so CSS weight and stretch map onto the font's own axes — the browser never
 * synthesizes a weight or width (#179, ADR-0021). */
export function fontFaceCss(...faces: FontFace[]): string {
  return faces
    .map((f) => {
      const { family, dataUri } = readFontAsset(f);
      const ranges =
        f.variant === "variable"
          ? ` font-weight: ${f.axes.wght.min} ${f.axes.wght.max}; font-stretch: ${f.axes.wdth.min}% ${f.axes.wdth.max}%;`
          : ` font-weight: ${f.weight};`;
      return `@font-face { font-family: "${family}";${ranges} src: url(${dataUri}) format("truetype"); }`;
    })
    .join("\n");
}

/**
 * Browser-side family resolution probe, evaluated in the compositor page:
 * measures a proportional-glyph string with the requested family followed by
 * monospace in the font stack, then monospace alone; equal widths mean the
 * family fell through to monospace, i.e. it silently failed to resolve.
 * The family is force-loaded first so unused faces are not false negatives.
 * Must stay self-contained — Playwright serializes it into the page.
 */
export const familyResolved = async (family: string): Promise<boolean> => {
  try {
    await document.fonts.load(`32px "${family}"`);
  } catch {
    return false;
  }
  const probe = "mmmmwwwwmmmm";
  const el = document.createElement("span");
  el.style.cssText =
    "position:absolute;visibility:hidden;white-space:nowrap;font-size:32px;";
  el.textContent = probe;
  document.body.appendChild(el);
  const width = (stack: string) => {
    el.style.fontFamily = stack;
    return el.getBoundingClientRect().width;
  };
  const withFamily = width(`"${family}", monospace`);
  const fallback = width("monospace");
  el.remove();
  return withFamily !== fallback;
};
