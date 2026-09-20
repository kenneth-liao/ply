/**
 * Caller font ingestion (#232, spec #226 US-005, DEC-006, OOS-005): reads a
 * caller-supplied font file — TrueType or OpenType at minimum — and reads
 * its font facts ONCE from the file's own tables. The returned facts are
 * stored with the text revision that retains the bytes (`LayerTextRevision.
 * callerFont`), so later edits validate weight and width against the file's
 * real axes without ever needing the original file again.
 *
 * The sfnt tables are read directly (name, OS/2, fvar) — no font-library
 * dependency, no system fonts, no remote fetching, no subsetting (OOS-005).
 * A file that is not a usable font is refused with the reason named, before
 * anything can be published.
 *
 * Fact model (ADR-0021 extended to caller fonts):
 * - A face whose fvar table exposes a `wght` axis is VARIABLE: the revision
 *   stores the resolved weight/width pair, validated against the real fvar
 *   ranges. A missing `wdth` axis is the common case (Handjet, most text
 *   families) — the face's single look is the width-100 instance, the same
 *   implicit-width rule a static face has. Other axes (ELGR, opsz, ...) are
 *   not Ply controls and are ignored.
 * - Everything else is STATIC: the bytes fix one look. `weight` accepts only
 *   the face's own weight (OS/2 `usWeightClass`), width only the implicit
 *   100. A variable font without a `wght` axis is treated as static — Ply
 *   has no weight control to offer beyond the face's own weight, and it
 *   never synthesizes one.
 */
import { readFile } from "node:fs/promises";
import type { CallerFontFacts, FontAxis } from "./fonts.js";

/** sfnt version tags this tool accepts: TrueType (0x00010000, `true`) and
 *  CFF-based OpenType (`OTTO`). Anything else — WOFF, WOFF2, TrueType
 *  collections, or garbage — is refused naming the file. */
const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_TRUE = 0x74727565; // "true"
const SFNT_VERSION_CFF = 0x4f54544f; // "OTTO"
const SFNT_TAG_TTC = 0x74746366; // "ttcf"
const SFNT_TAG_WOFF = 0x774f4646; // "wOFF"
const SFNT_TAG_WOFF2 = 0x774f4632; // "wOF2"

/** The name-table IDs that carry a family name: 16 (typographic family)
 *  preferred over 1 (legacy family) when both exist. */
const NAME_ID_TYPOGRAPHIC_FAMILY = 16;
const NAME_ID_FAMILY = 1;

/** A 16.16 Fixed value as the fvar table stores it. */
function fixed16(b: Buffer, offset: number): number {
  return b.readInt32BE(offset) / 65536;
}

/** Refusal text for anything that is not a usable font file. Names the
 *  reason so the caller can fix the input; nothing is published after a
 *  refusal here. */
function unusable(reason: string): Error {
  return new Error(`The file is not a usable font: ${reason}`);
}

interface SfntTable {
  offset: number;
  length: number;
}

/** Read the sfnt table directory. Throws for truncated headers and
 *  out-of-bounds table records — the common shapes of a non-font file. */
function readTableDirectory(bytes: Buffer): Map<string, SfntTable> {
  const numTables = bytes.readUInt16BE(4);
  if (numTables === 0) {
    throw unusable("the table directory declares no tables");
  }
  if (12 + numTables * 16 > bytes.length) {
    throw unusable("the table directory is truncated");
  }
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = bytes.toString("latin1", rec, rec + 4);
    const offset = bytes.readUInt32BE(rec + 8);
    const length = bytes.readUInt32BE(rec + 12);
    if (offset + length > bytes.length) {
      throw unusable(`table "${tag}" extends past the end of the file`);
    }
    tables.set(tag, { offset, length });
  }
  return tables;
}

/** One decoded name-table string record. */
interface NameRecord {
  nameId: number;
  text: string;
}

/** Read the `name` table's string records. Windows (platform 3) and
 *  Unicode (platform 0) strings are UTF-16BE; Macintosh (platform 1) Roman
 *  strings are latin1. Malformed records are skipped, not fatal — the
 *  family lookup below only needs one well-formed family record. */
function readNameRecords(bytes: Buffer, table: SfntTable): NameRecord[] {
  const count = bytes.readUInt16BE(table.offset + 2);
  const stringOffset = table.offset + bytes.readUInt16BE(table.offset + 4);
  const records: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const rec = table.offset + 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const platformId = bytes.readUInt16BE(rec);
    const nameId = bytes.readUInt16BE(rec + 6);
    const length = bytes.readUInt16BE(rec + 8);
    const offset = bytes.readUInt16BE(rec + 10);
    const start = stringOffset + offset;
    if (start + length > bytes.length) continue;
    // UTF-16 records must decode in whole code units: an odd-length
    // platform-0/3 record is malformed, skipped like any other malformed
    // record (never a raw decoder error).
    if ((platformId === 0 || platformId === 3) && length % 2 !== 0) continue;
    const raw = bytes.subarray(start, start + length);
    const text =
      platformId === 0 || platformId === 3
        ? Buffer.from(raw).swap16().toString("utf16le")
        : raw.toString("latin1");
    records.push({ nameId, text });
  }
  return records;
}

/** The family name the file's own name table declares: the typographic
 *  family (name ID 16) when present, else the legacy family (name ID 1).
 *  This is the name `inspect` and `measure` report — never a Ply-side
 *  opinion. */
function readFamilyName(bytes: Buffer, tables: Map<string, SfntTable>): string {
  const table = tables.get("name");
  if (table === undefined || table.length < 6) {
    throw unusable("it has no name table, so it declares no family name");
  }
  const records = readNameRecords(bytes, table);
  const familyOf = (nameId: number): string | undefined =>
    records
      .filter((r) => r.nameId === nameId)
      .map((r) => r.text.replace(/\0+$/, "").trim())
      .find((t) => t.length > 0);
  const family = familyOf(NAME_ID_TYPOGRAPHIC_FAMILY) ?? familyOf(NAME_ID_FAMILY);
  if (family === undefined) {
    throw unusable("its name table declares no family name");
  }
  return family;
}

/** Read `OS/2` `usWeightClass` — the one weight fact a static face has. */
function readWeightClass(bytes: Buffer, tables: Map<string, SfntTable>): number {
  const table = tables.get("OS/2");
  if (table === undefined || table.length < 8) {
    throw unusable("it has no OS/2 table, so it declares no weight");
  }
  const weight = bytes.readUInt16BE(table.offset + 4);
  if (weight < 1 || weight > 1000) {
    throw unusable(`its OS/2 table declares an out-of-range weight ${weight}`);
  }
  return weight;
}

/**
 * Read the `fvar` axes Ply controls — `wght` and `wdth` — as their real
 * ranges. Other axes are not Ply controls and are ignored.
 */
function readFvarAxes(
  bytes: Buffer,
  tables: Map<string, SfntTable>,
): { wght?: FontAxis; wdth?: FontAxis } {
  const table = tables.get("fvar");
  if (table === undefined) return {};
  if (table.length < 16) {
    throw unusable("its fvar table is truncated");
  }
  const axesArrayOffset = bytes.readUInt16BE(table.offset + 4);
  const axisCount = bytes.readUInt16BE(table.offset + 8);
  const axisSize = bytes.readUInt16BE(table.offset + 10);
  if (axisSize < 20) {
    throw unusable("its fvar table declares an invalid axis record size");
  }
  const axes: { wght?: FontAxis; wdth?: FontAxis } = {};
  for (let i = 0; i < axisCount; i++) {
    const rec = table.offset + axesArrayOffset + i * axisSize;
    if (rec + 20 > bytes.length) {
      throw unusable("its fvar axis records are truncated");
    }
    const tag = bytes.toString("latin1", rec, rec + 4);
    if (tag !== "wght" && tag !== "wdth") continue;
    const axis = {
      min: fixed16(bytes, rec + 4),
      default: fixed16(bytes, rec + 8),
      max: fixed16(bytes, rec + 12),
    };
    if (
      !Number.isFinite(axis.min) || !Number.isFinite(axis.default) || !Number.isFinite(axis.max) ||
      axis.min > axis.default || axis.default > axis.max
    ) {
      throw unusable(`its fvar table declares an inconsistent "${tag}" axis`);
    }
    axes[tag as "wght" | "wdth"] = axis;
  }
  return axes;
}

/**
 * Read a caller font file's bytes and its facts, once (DEC-006): family
 * name, static-vs-variable, glyph format, and the axis facts weight and
 * width controls validate against. Missing files, unreadable files, and
 * anything that is not a usable TrueType/OpenType font are refused with
 * the reason named.
 */
export async function readCallerFontFile(fontPath: string): Promise<{
  bytes: Buffer;
  facts: CallerFontFacts;
}> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await readFile(fontPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Font file "${fontPath}" does not exist.`);
    }
    throw new Error(`Font file "${fontPath}" cannot be read: ${(err as Error).message}`);
  }
  return { bytes, facts: parseCallerFont(bytes) };
}

/**
 * Parse font facts from font bytes. Pure: no filesystem access — the
 * stored-facts validator (normalizeStoredCallerFont in src/layer.ts) and
 * the tests reuse this shape.
 */
export function parseCallerFont(bytes: Buffer): CallerFontFacts {
  if (bytes.length < 12) {
    throw unusable("the file is too short to be a font");
  }
  const version = bytes.readUInt32BE(0);
  if (version === SFNT_TAG_TTC) {
    throw unusable("TrueType collections (ttcf) are not supported — pass a single .ttf or .otf face");
  }
  if (version === SFNT_TAG_WOFF || version === SFNT_TAG_WOFF2) {
    throw unusable("WOFF/WOFF2 are not supported — pass a TrueType (.ttf) or OpenType (.otf) face");
  }
  if (version !== SFNT_VERSION_TRUETYPE && version !== SFNT_VERSION_TRUE && version !== SFNT_VERSION_CFF) {
    throw unusable("the file is not a TrueType or OpenType font");
  }
  const format = version === SFNT_VERSION_CFF ? "opentype" : "truetype";
  const tables = readTableDirectory(bytes);
  // The tables rendering actually needs: outlines (glyf or CFF) and the
  // character map. Their absence means the browser could never paint with
  // the face, so the file is refused here rather than at render time.
  if (!tables.has("glyf") && !tables.has("CFF ")) {
    throw unusable("it has no glyph outline data (no glyf or CFF table)");
  }
  if (!tables.has("cmap")) {
    throw unusable("it has no character map (cmap table)");
  }

  const family = readFamilyName(bytes, tables);
  const weight = readWeightClass(bytes, tables);
  const { wght, wdth } = readFvarAxes(bytes, tables);
  if (wght !== undefined) {
    return {
      family,
      variant: "variable",
      format,
      axes: { wght, ...(wdth !== undefined ? { wdth } : {}) },
    };
  }
  // No fvar wght axis: the bytes fix one weight — the static-face model.
  return { family, variant: "static", format, weight };
}