import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BUNDLED_FACES,
  faceByContentHash,
  fontAssetPath,
  readFontAsset,
  fontFaceCss,
  faceDefaultWeight,
  familyResolved,
  resolveTextAxes,
  resolveFace,
  STATIC_FACE_WIDTH,
  type FontFace,
} from "../src/fonts.js";
import { chromium } from "playwright";

describe("bundled fonts", () => {
  it("every bundled face resolves to a font file on disk", () => {
    for (const face of BUNDLED_FACES.values()) {
      expect(
        existsSync(fontAssetPath(face)),
        `"${face.family}" → ${face.file}`,
      ).toBe(true);
    }
  });

  it("emits @font-face rules from local bytes (no network, no system fonts)", () => {
    const [first, second] = [...BUNDLED_FACES.values()];
    const css = fontFaceCss(first!, second!);
    const faces = css.match(/@font-face/g)!;
    expect(faces.length).toBe(2);
    expect(css).toContain(`"${first!.family}"`);
    expect(css).toContain(`font-weight: ${faceDefaultWeight(first!)}`);
    expect(css).toContain("data:font/ttf;base64,");
  });

  it("fails loud when a requested font file is missing", () => {
    const ghost: FontFace = { variant: "static", family: "Ghost", weight: 400, file: "ghost.ttf" };
    expect(() => readFontAsset(ghost)).toThrow(/Ghost/);
    expect(() => fontFaceCss(ghost)).toThrow(/Ghost/);
  });
});

describe("fallback rejection probe", () => {
  it("accepts a bundled family loaded via @font-face and rejects an unregistered one", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const face = BUNDLED_FACES.values().next().value!;
      await page.setContent(
        `<style>${fontFaceCss(face)}</style><body>x</body>`,
      );
      expect(await page.evaluate(familyResolved, face.family)).toBe(true);
      expect(await page.evaluate(familyResolved, "NoSuch Font")).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("fails loud when a requested variable face file is missing", () => {
    const ghost: FontFace = {
      variant: "variable",
      family: "Ghost",
      file: "ghost.ttf",
      axes: { wght: { min: 100, max: 900, default: 400 }, wdth: { min: 62, max: 125, default: 100 } },
    };
    expect(() => readFontAsset(ghost)).toThrow(/Ghost/);
    expect(() => fontFaceCss(ghost)).toThrow(/Ghost/);
  });

  it("emits @font-face range declarations for a variable face (no synthesis)", () => {
    const archivo = resolveFace("Archivo");
    expect(archivo.variant).toBe("variable");
    const css = fontFaceCss(archivo);
    // The @font-face rule declares the real axis ranges so CSS weight and
    // stretch map onto the font's own axes — the browser never synthesizes.
    expect(css).toContain(`font-weight: 100 900`);
    expect(css).toContain(`font-stretch: 62% 125%`);
    expect(css).toContain("data:font/ttf;base64,");
  });

  it("rejects a registered family whose bytes fail to parse", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      // Corrupt/unparseable bundled bytes are exactly what a Linux-like env
      // with missing files degrades to — the face registers but never loads.
      await page.setContent(
        `<style>@font-face { font-family: "Garbage"; font-weight: 400;
          src: url(data:font/ttf;base64,bm90LWFmb250) format("truetype"); }</style>
          <body>x</body>`,
      );
      expect(await page.evaluate(familyResolved, "Garbage")).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

describe("Groundline faces (#179, ADR-0021)", () => {
  it("bundles Archivo as a variable face with its real axis ranges and default instance", () => {
    const archivo = resolveFace("Archivo");
    expect(archivo.variant).toBe("variable");
    if (archivo.variant !== "variable") throw new Error("unreachable");
    expect(archivo.file).toBe("Archivo[wdth,wght].ttf");
    expect(archivo.axes.wght).toEqual({ min: 100, max: 900, default: 400 });
    expect(archivo.axes.wdth).toEqual({ min: 62, max: 125, default: 100 });
  });

  it("bundles IBM Plex Mono as a static 500 face", () => {
    const plex = resolveFace("IBM Plex Mono");
    expect(plex.variant).toBe("static");
    if (plex.variant !== "static") throw new Error("unreachable");
    expect(plex.file).toBe("IBMPlexMono-Medium.ttf");
    expect(plex.weight).toBe(500);
  });

  it("ships the exact upstream bytes — full files, not latin subsets (SHA-256 pinned)", () => {
    const archivoBytes = readFileSync(fontAssetPath(resolveFace("Archivo")));
    expect(
      createHash("sha256").update(archivoBytes).digest("hex"),
    ).toBe("0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053");
    const plexBytes = readFileSync(fontAssetPath(resolveFace("IBM Plex Mono")));
    expect(
      createHash("sha256").update(plexBytes).digest("hex"),
    ).toBe("a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755");
  });

  describe("resolveTextAxes", () => {
    const archivo = resolveFace("Archivo");
    const plex = resolveFace("IBM Plex Mono");
    const oswald = resolveFace("Oswald");

    it("a variable face resolves omitted controls to its default instance (400/100)", () => {
      expect(resolveTextAxes(archivo, {})).toEqual({ weight: 400, width: 100 });
 expect(resolveTextAxes(archivo, { weight: 800, width: 122 })).toEqual({ weight: 800, width: 122 });
      expect(resolveTextAxes(archivo, { weight: 600 })).toEqual({ weight: 600, width: 100 });
      expect(resolveTextAxes(archivo, { width: 62 })).toEqual({ weight: 400, width: 62 });
    });

    it("a variable face refuses out-of-range values, naming the family and allowed range", () => {
      expect(() => resolveTextAxes(archivo, { weight: 950 })).toThrow(/"Archivo".*100-900.*950/);
      expect(() => resolveTextAxes(archivo, { width: 130 })).toThrow(/"Archivo".*62-125.*130/);
      expect(() => resolveTextAxes(archivo, { weight: 99 })).toThrow(/100-900/);
      expect(() => resolveTextAxes(archivo, { width: 61 })).toThrow(/62-125/);
    });

    it("a static face accepts only its own weight and refuses width, naming what it allows", () => {
      expect(resolveTextAxes(plex, {})).toEqual({});
      expect(resolveTextAxes(plex, { weight: 500 })).toEqual({});
      expect(() => resolveTextAxes(plex, { weight: 700 })).toThrow(/"IBM Plex Mono".*500.*700/);
      expect(() => resolveTextAxes(plex, { width: 100 })).toThrow(/"IBM Plex Mono".*width/i);
      expect(resolveTextAxes(oswald, { weight: 700 })).toEqual({});
      expect(() => resolveTextAxes(oswald, { weight: 400 })).toThrow(/"Oswald".*700/);
      expect(() => resolveTextAxes(oswald, { width: 100 })).toThrow(/"Oswald".*width/i);
    });

    it("every static face accepts only its own weight and refuses width", () => {
    for (const face of BUNDLED_FACES.values()) {
      if (face.variant !== "static") continue;
      expect(resolveTextAxes(face, {}), face.family).toEqual({});
      expect(resolveTextAxes(face, { weight: face.weight }), face.family).toEqual({});
      expect(() => resolveTextAxes(face, { weight: face.weight + 1 })).toThrow(face.family);
      expect(() => resolveTextAxes(face, { width: STATIC_FACE_WIDTH })).toThrow(/width axis/);
    }
  });

  it("refuses non-finite axis values", () => {
      expect(() => resolveTextAxes(archivo, { weight: NaN })).toThrow(/finite/);
      expect(() => resolveTextAxes(archivo, { width: Infinity })).toThrow(/finite/);
    });
  });

  it("resolves a retained font's face by content hash — the retained bytes are the only font identity", () => {
    const archivo = resolveFace("Archivo");
    const bytes = readFileSync(fontAssetPath(archivo));
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(faceByContentHash(hash)).toBe(archivo);
    expect(faceByContentHash("0".repeat(64))).toBeUndefined();
  });
});
