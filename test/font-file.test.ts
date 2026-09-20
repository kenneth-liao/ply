/**
 * Caller font ingestion (#232, spec #226 US-005, TEST-007): the sfnt facts
 * are read from the file's own tables — family name from `name`, the
 * weight fact from `OS/2`, the real axis ranges from `fvar` — and anything
 * that is not a usable TrueType/OpenType font is refused with the reason
 * named. Pure unit seams: no browser, no Project, no network.
 */
import { describe, expect, it, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCallerFont, readCallerFontFile } from "../src/font-file.js";

const FIXTURES = path.resolve(import.meta.dir, "fixtures/fonts");
const SILKSCREEN = path.join(FIXTURES, "Silkscreen-Regular.ttf");
const HANDJET = path.join(FIXTURES, "Handjet.ttf");

async function bytesOf(p: string): Promise<Buffer> {
  return Buffer.from(await readFile(p));
}

describe("parseCallerFont (#232)", () => {
  it("reads a static face's facts from its own tables", async () => {
    const facts = parseCallerFont(await bytesOf(SILKSCREEN));
    expect(facts.family).toBe("Silkscreen");
    expect(facts.variant).toBe("static");
    expect(facts.format).toBe("truetype");
    expect(facts.weight).toBe(400);
    expect(facts.axes).toBeUndefined();
  });

  it("reads a variable face's real fvar ranges", async () => {
    const facts = parseCallerFont(await bytesOf(HANDJET));
    expect(facts.family).toBe("Handjet");
    expect(facts.variant).toBe("variable");
    expect(facts.format).toBe("truetype");
    // Handjet's real fvar: wght 100-400-900, no wdth axis (the common
    // case — the implicit-width rule applies). Its ELGR/ELSH axes are not
    // Ply controls and are not read.
    expect(facts.axes?.wght).toEqual({ min: 100, default: 400, max: 900 });
    expect(facts.axes?.wdth).toBeUndefined();
    expect(facts.weight).toBeUndefined();
  });

  it("refuses a non-font file naming the reason", async () => {
    const notAFont = Buffer.from("this is not a font, it is a text file");
    expect(() => parseCallerFont(notAFont)).toThrow(/not a usable font/);
    expect(() => parseCallerFont(Buffer.alloc(4))).toThrow(/not a usable font|too short/);
  });

  it("refuses WOFF, WOFF2, and TrueType collections", () => {
    const woff = Buffer.alloc(44);
    woff.write("wOFF", 0, "latin1");
    expect(() => parseCallerFont(woff)).toThrow(/WOFF/);
    const woff2 = Buffer.alloc(44);
    woff2.write("wOF2", 0, "latin1");
    expect(() => parseCallerFont(woff2)).toThrow(/WOFF/);
    const ttc = Buffer.alloc(64);
    ttc.write("ttcf", 0, "latin1");
    ttc.writeUInt16BE(2, 4);
    expect(() => parseCallerFont(ttc)).toThrow(/collections/);
  });

  it("refuses a truncated table directory and out-of-bounds tables", () => {
    const header = Buffer.alloc(12 + 3 * 16);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(3, 4);
    expect(() => parseCallerFont(header.subarray(0, 20))).toThrow(/truncated/);
    // A table whose (offset, length) runs past EOF.
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(1, 4);
    header.write("glyf", 12, "latin1");
    header.writeUInt32BE(0, 20);
    header.writeUInt32BE(0xffffff, 24);
    expect(() => parseCallerFont(header)).toThrow(/past the end/);
  });

  it("readCallerFontFile names a missing file and returns parsed facts", async () => {
    await expect(readCallerFontFile(path.join(FIXTURES, "missing.ttf"))).rejects.toThrow(
      /does not exist/,
    );
    const { bytes, facts } = await readCallerFontFile(SILKSCREEN);
    expect(bytes.length).toBeGreaterThan(0);
    expect(facts.family).toBe("Silkscreen");
  });
});