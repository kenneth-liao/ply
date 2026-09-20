/**
 * Caller font ingestion (#232, spec #226 US-005, TEST-007): the sfnt facts
 * are read from the file's own tables — family name from `name`, the
 * weight fact from `OS/2`, the real axis ranges from `fvar` — and anything
 * that is not a usable TrueType/OpenType font is refused with the reason
 * named. Pure unit seams: no browser, no Project, no network. Synthetic
 * sfnt builders exercise the hostile shapes a real font never has (fvar
 * records outside the table, duplicate tags, invalid stride, odd name
 * records); the committed OFL fixtures (test/fixtures/fonts) carry the
 * end-to-end seams.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCallerFont, readCallerFontFile } from "../src/font-file.js";

const FIXTURES = path.resolve(import.meta.dir, "fixtures/fonts");
const SILKSCREEN = path.join(FIXTURES, "Silkscreen-Regular.ttf");
const SILKSCREEN_OTF = path.join(FIXTURES, "Silkscreen-Regular.otf");
const HANDJET = path.join(FIXTURES, "Handjet.ttf");

async function bytesOf(p: string): Promise<Buffer> {
  return Buffer.from(await readFile(p));
}

/** A 16.16 fvar axis record: tag, min/default/max as Fixed, flags, name id. */
function fvarAxisRecord(tag: string, min: number, def: number, max: number): Buffer {
  const rec = Buffer.alloc(20);
  rec.write(tag, 0, "latin1");
  rec.writeInt32BE(Math.round(min * 65536), 4);
  rec.writeInt32BE(Math.round(def * 65536), 8);
  rec.writeInt32BE(Math.round(max * 65536), 12);
  return rec;
}

/**
 * Build a minimal sfnt from named tables: header + table directory, then
 * the tables concatenated in the given order. Enough shape for
 * parseCallerFont when the required tables (name, OS/2, glyf, cmap) are
 * present; `version` selects the sfnt flavor.
 */
function buildSfnt(
  tables: Array<[string, Buffer]>,
  version = 0x00010000,
): Buffer {
  const headerLength = 12 + tables.length * 16;
  let offset = headerLength;
  const header = Buffer.alloc(headerLength);
  header.writeUInt32BE(version, 0);
  header.writeUInt16BE(tables.length, 4);
  for (const [tag, bytes] of tables) {
    const rec = 12 + tables.findIndex(([t]) => t === tag) * 16;
    header.write(tag, rec, "latin1");
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(bytes.length, rec + 12);
    offset += bytes.length;
  }
  return Buffer.concat([header, ...tables.map(([, bytes]) => bytes)]);
}

/** A minimal `name` table with a single platform-3 family record. */
function nameTable(family: string): Buffer {
  const text = Buffer.from(family, "utf16le").swap16();
  const record = Buffer.alloc(12);
  record.writeUInt16BE(3, 0); // platform: Windows
  record.writeUInt16BE(1, 2); // encoding: Unicode BMP
  record.writeUInt16BE(0x409, 4); // language: en-US
  record.writeUInt16BE(1, 6); // name ID 1: family
  record.writeUInt16BE(text.length, 8);
  record.writeUInt16BE(0, 10);
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(6 + 12, 4);
  return Buffer.concat([head, record, text]);
}

/** The stub tables every parseable font needs beyond `name`. */
function requiredStubs(): Array<[string, Buffer]> {
  const os2 = Buffer.alloc(8);
  os2.writeUInt16BE(4, 0);
  os2.writeUInt16BE(400, 4);
  return [["OS/2", os2], ["glyf", Buffer.alloc(8)], ["cmap", Buffer.alloc(8)]];
}

/** A minimal fvar table around the given axis records. `overrides` patches
 *  the header fields (offsets are table-relative) for hostile shapes. */
function fvarTable(records: Buffer[], overrides: Partial<{ axesArrayOffset: number; axisCount: number; axisSize: number }> = {}): Buffer {
  const axesArrayOffset = overrides.axesArrayOffset ?? 16;
  const axisCount = overrides.axisCount ?? records.length;
  const axisSize = overrides.axisSize ?? 20;
  const head = Buffer.alloc(16);
  head.writeUInt16BE(1, 0); // majorVersion
  head.writeUInt16BE(0, 2); // minorVersion
  head.writeUInt16BE(axesArrayOffset, 4);
  head.writeUInt16BE(0, 6); // reserved
  head.writeUInt16BE(axisCount, 8);
  head.writeUInt16BE(axisSize, 10);
  head.writeUInt16BE(0, 12); // instanceCount
  head.writeUInt16BE(0, 14); // instanceSize
  return Buffer.concat([head, ...records]);
}

describe("parseCallerFont (#232)", () => {
  it("reads a static TrueType face's facts from its own tables", async () => {
    const facts = parseCallerFont(await bytesOf(SILKSCREEN));
    expect(facts.family).toBe("Silkscreen");
    expect(facts.variant).toBe("static");
    expect(facts.format).toBe("truetype");
    expect(facts.weight).toBe(400);
    expect(facts.axes).toBeUndefined();
  });

  it("reads a CFF OpenType face's facts (the .otf half of the format minimum, INT-parser-1)", async () => {
    const facts = parseCallerFont(await bytesOf(SILKSCREEN_OTF));
    expect(facts.family).toBe("Silkscreen");
    expect(facts.variant).toBe("static");
    // OTTO sfnt with CFF outlines: the OpenType flavor, stored verbatim so
    // the paint path declares format("opentype") for the retained bytes.
    expect(facts.format).toBe("opentype");
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

  it("refuses a non-font file naming the reason", () => {
    const notAFont = Buffer.from("this is not a font, it is a text file");
    expect(() => parseCallerFont(notAFont)).toThrow(/not a usable font/);
    expect(() => parseCallerFont(Buffer.alloc(4))).toThrow(/not a usable font|too short/);
  });

  it("skips an odd-length UTF-16 name record instead of throwing a raw decoder error", () => {
    // A name table whose first family record (name ID 1, platform 3)
    // declares an odd byte length — malformed, must be skipped like any
    // other malformed record, never a raw swap16 RangeError. A valid
    // Mac-Roman (platform 1) record carries the family so the file still
    // parses.
    const odd = Buffer.alloc(5, 0x41);
    const family = Buffer.from("OddRecord", "latin1");
    const records = Buffer.alloc(2 * 12);
    // Record 1: platform 3, name ID 1, odd length 5, string at offset 0.
    records.writeUInt16BE(3, 0);
    records.writeUInt16BE(1, 2);
    records.writeUInt16BE(0x409, 4);
    records.writeUInt16BE(1, 6);
    records.writeUInt16BE(odd.length, 8);
    records.writeUInt16BE(0, 10);
    // Record 2: platform 1, name ID 1, the usable family name.
    records.writeUInt16BE(1, 12);
    records.writeUInt16BE(0, 14);
    records.writeUInt16BE(0, 16);
    records.writeUInt16BE(1, 18);
    records.writeUInt16BE(family.length, 20);
    records.writeUInt16BE(odd.length, 22);
    const strings = Buffer.concat([odd, family]);
    const head = Buffer.alloc(6);
    head.writeUInt16BE(0, 0);
    head.writeUInt16BE(2, 2);
    head.writeUInt16BE(6 + 2 * 12, 4);
    const name = Buffer.concat([head, records, strings]);
    const bytes = buildSfnt([["name", name], ...requiredStubs()]);
    expect(parseCallerFont(bytes).family).toBe("OddRecord");
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

  it("reads a synthetic variable face's fvar ranges", () => {
    const fvar = fvarTable([
      fvarAxisRecord("wght", 100, 400, 900),
      fvarAxisRecord("wdth", 62, 100, 125),
    ]);
    const bytes = buildSfnt([["name", nameTable("Synth")], ["fvar", fvar], ...requiredStubs()]);
    const facts = parseCallerFont(bytes);
    expect(facts.variant).toBe("variable");
    expect(facts.axes?.wght).toEqual({ min: 100, default: 400, max: 900 });
    expect(facts.axes?.wdth).toEqual({ min: 62, default: 100, max: 125 });
  });
});

describe("hostile fvar shapes are refused naming the reason (INT-parser-2)", () => {
  it("refuses axis records that extend past the fvar table (in-bounds non-fvar bytes cannot pose as axis data)", () => {
    // axesArrayOffset points past the fvar table's own extent (into the
    // OS/2 stub that follows it): the whole array must fit the table.
    const fvar = fvarTable([fvarAxisRecord("wght", 100, 400, 900)], {
      axesArrayOffset: 200,
    });
    const bytes = buildSfnt([["name", nameTable("Hostile")], ["fvar", fvar], ...requiredStubs()]);
    expect(() => parseCallerFont(bytes)).toThrow(/extend past the fvar table/);
  });

  it("refuses duplicate axis records", () => {
    const fvar = fvarTable([
      fvarAxisRecord("wght", 100, 400, 900),
      fvarAxisRecord("wght", 200, 500, 800),
    ]);
    const bytes = buildSfnt([["name", nameTable("Dup")], ["fvar", fvar], ...requiredStubs()]);
    expect(() => parseCallerFont(bytes)).toThrow(/duplicate "wght" axes/);
  });

  it("refuses an axis record size smaller than the record itself (overlapping layout)", () => {
    const fvar = fvarTable([fvarAxisRecord("wght", 100, 400, 900)], { axisSize: 10 });
    const bytes = buildSfnt([["name", nameTable("Overlap")], ["fvar", fvar], ...requiredStubs()]);
    expect(() => parseCallerFont(bytes)).toThrow(/invalid axis record size/);
  });

  it("refuses an fvar array declared by a hostile axis count that runs past the table", () => {
    const fvar = fvarTable([fvarAxisRecord("wght", 100, 400, 900)], { axisCount: 60000 });
    const bytes = buildSfnt([["name", nameTable("Count")], ["fvar", fvar], ...requiredStubs()]);
    expect(() => parseCallerFont(bytes)).toThrow(/extend past the fvar table/);
  });
});

describe("readCallerFontFile (#232)", () => {
  it("names a missing file and returns parsed facts", async () => {
    await expect(readCallerFontFile(path.join(FIXTURES, "missing.ttf"))).rejects.toThrow(
      /does not exist/,
    );
    const { bytes, facts } = await readCallerFontFile(SILKSCREEN);
    expect(bytes.length).toBeGreaterThan(0);
    expect(facts.family).toBe("Silkscreen");
  });
});