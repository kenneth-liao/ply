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

  it("skips an odd-length UTF-16 name record instead of throwing a raw decoder error", () => {
    // Minimal sfnt: a name table whose first family record (name ID 1,
    // platform 3) declares an odd byte length — malformed, must be skipped
    // like any other malformed record, never a raw swap16 RangeError. A
    // valid Mac-Roman (platform 1) record carries the family so the file
    // still parses.
    const odd = Buffer.alloc(5, 0x41);
    const family = Buffer.from("OddRecord", "latin1");
    const nameRecords = Buffer.alloc(2 * 12);
    // Record 1: platform 3, name ID 1, odd length 5, string at offset 0.
    nameRecords.writeUInt16BE(3, 0);
    nameRecords.writeUInt16BE(1, 2);
    nameRecords.writeUInt16BE(0x409, 4);
    nameRecords.writeUInt16BE(1, 6);
    nameRecords.writeUInt16BE(odd.length, 8);
    nameRecords.writeUInt16BE(0, 10);
    // Record 2: platform 1, name ID 1, the usable family name.
    nameRecords.writeUInt16BE(1, 12);
    nameRecords.writeUInt16BE(0, 14);
    nameRecords.writeUInt16BE(0, 16);
    nameRecords.writeUInt16BE(1, 18);
    nameRecords.writeUInt16BE(family.length, 20);
    nameRecords.writeUInt16BE(odd.length, 22);
    const strings = Buffer.concat([odd, family]);
    const nameTable = Buffer.concat([
      (() => {
        const head = Buffer.alloc(6);
        head.writeUInt16BE(0, 0);
        head.writeUInt16BE(2, 2);
        head.writeUInt16BE(6 + 2 * 12, 4);
        return head;
      })(),
      nameRecords,
      strings,
    ]);
    // Stub tables for the parser's other requirements: OS/2 (the weight
    // fact), glyph outlines, and a character map.
    const os2 = Buffer.alloc(8);
    os2.writeUInt16BE(4, 0);
    os2.writeUInt16BE(400, 4);
    const glyf = Buffer.alloc(8);
    const cmap = Buffer.alloc(8);
    const tables: Array<[string, Buffer]> = [
      ["name", nameTable], ["OS/2", os2], ["glyf", glyf], ["cmap", cmap],
    ];
    const headerLength = 12 + tables.length * 16;
    let offset = headerLength;
    const header = Buffer.alloc(headerLength);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(tables.length, 4);
    for (const [tag, bytes] of tables) {
      const rec = 12 + tables.findIndex(([t]) => t === tag) * 16;
      header.write(tag, rec, "latin1");
      header.writeUInt32BE(offset, rec + 8);
      header.writeUInt32BE(bytes.length, rec + 12);
      offset += bytes.length;
    }
    const full = Buffer.concat([header, nameTable, os2, glyf, cmap]);
    const facts = parseCallerFont(full);
    expect(facts.family).toBe("OddRecord");
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