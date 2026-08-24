/**
 * `npm run build:radicals` — fill the canon's reserved `radical` field.
 *
 * Emits data/radicals.json: a character -> Kangxi radical map plus the radical
 * table it joins to.
 *
 * This does NOT edit src/build/canon.ts. `radical` is a field the canon has
 * never emitted and that src/build/packs.ts already reads; wiring it up is a
 * two-line change in canon.ts, which belongs to whoever owns it. The exact
 * lines are in scripts/radical-source.md.
 *
 * It also does not read the canon. data/radicals.json is an INPUT to the canon
 * build, so taking the canon's own output as its character inventory would make
 * the two builds circular. The inventory comes from scripts/hsk30.csv instead —
 * a pinned source, and the file the canon's simplified and traditional columns
 * are copied from, so it is a superset of anything the canon can contain. The
 * canon is read only if it happens to exist, and only to print a coverage line.
 *
 * ---------------------------------------------------------------------------
 * SOURCE AND LICENCE
 * ---------------------------------------------------------------------------
 *
 * Unicode Character Database 17.0.0, under UNICODE LICENSE V3 — permissive,
 * MIT-family, explicitly allowing modification and redistribution of derived
 * data provided the copyright and permission notice travels with the copies or
 * with the documentation. It is not copyleft, so it composes with this repo's
 * CC BY-SA 4.0 data licence instead of fighting it.
 *
 * Two files, both pinned to 17.0.0 rather than /latest/ so the build is
 * reproducible after the next Unicode release:
 *
 *   Unihan.zip -> Unihan_IRGSources.txt   field kRSUnicode: the radical-stroke
 *                                         index, "radical.residual strokes"
 *   CJKRadicals.txt                       radical number -> radical character
 *
 * The full evaluation of this source against CC-CEDICT, cjkvi-ids and
 * make-me-a-hanzi, with licence quotations and why the other three were
 * rejected, is in scripts/radical-source.md.
 *
 * ---------------------------------------------------------------------------
 * REPRODUCIBILITY
 * ---------------------------------------------------------------------------
 *
 * Unihan.zip is 8.1 MB and its IRG member is 13.4 MB, which is too much to put
 * in everyone's clone for one field. So the build reads a vendored reduction —
 * scripts/unihan-radicals.tsv, 102,998 lines of `character<TAB>kRSUnicode` —
 * and never touches the network. `npm run radicals:fetch` regenerates that file
 * from unicode.org and refuses to write it unless the download hashes to the
 * SHA-256 pinned below, so the reduction is re-derivable byte for byte by
 * anyone who runs the same command.
 *
 * CJKRadicals.txt is 5.5 KB and is vendored verbatim, header comments and all,
 * because at that size provenance is worth more than the bytes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const DATA_DIR = join(ROOT, "data");

const HSK_CSV_PATH = join(SCRIPTS_DIR, "hsk30.csv");
const CANON_PATH = join(DATA_DIR, "hsk_bands.json");
const OUT_PATH = join(DATA_DIR, "radicals.json");
const VENDORED_KRS = join(SCRIPTS_DIR, "unihan-radicals.tsv");
const VENDORED_RADICALS = join(SCRIPTS_DIR, "cjk-radicals.txt");

const UNICODE_VERSION = "17.0.0";
const UCD_BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;

/**
 * Pinned digests. A mismatch stops the fetch rather than silently vendoring
 * whatever unicode.org served today; bumping Unicode is meant to be a visible
 * edit to these four lines, not a surprise in someone's diff.
 */
const UNIHAN_ZIP_SHA256 = "f7a48b2b545acfaa77b2d607ae28747404ce02baefee16396c5d2d7a8ef34b5e";
const IRG_MEMBER = "Unihan_IRGSources.txt";
const IRG_MEMBER_SHA256 = "d1c817dd7db84295dab0643c277d97c2fa742c245f8824e6736c2a0935095325";
const CJK_RADICALS_SHA256 = "826f83be25cd18fb8a5015a514704504e1982e840ea14d058bf583e1cc620c83";

const LICENSE_ATTRIBUTION = [
  `Radical data derived from the Unicode Character Database ${UNICODE_VERSION}: ` +
    `Unihan.zip (${IRG_MEMBER}, field kRSUnicode) and CJKRadicals.txt, ` +
    `retrieved from ${UCD_BASE}/`,
  "Copyright © 1991-2026 Unicode, Inc. Distributed under UNICODE LICENSE V3 " +
    "(https://www.unicode.org/license.txt). Unicode and the Unicode Logo are " +
    "registered trademarks of Unicode, Inc. in the U.S. and other countries.",
];

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* kRSUnicode                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A kRSUnicode value, per UAX #38: `[1-9]\d{0,2}\'{0,3}\.-?\d{1,2}`.
 *
 * Three things about this syntax bite anyone who guesses at it:
 *
 *  - The apostrophes are part of the radical, not noise. One means the Chinese
 *    simplified form of that radical, two or three mean non-Chinese simplified
 *    forms, and they get their own rows in CJKRadicals.txt with their own
 *    characters. 149' is 讠, not 言; strip the apostrophe and 245 canon
 *    headwords get the wrong radical.
 *  - The residual stroke count can be negative, because a few ideographs are
 *    built by removing strokes from a radical. `\d+` is the wrong regex.
 *  - A character can carry several space-separated values when it is
 *    reasonably classifiable under more than one radical. The first is the
 *    standard one; that is the one taken here.
 *
 * kRSKangXi is deliberately not used: UAX #38 lists it under "Properties
 * Removed" as of Unicode 15.1.0, so it does not exist in a current UCD.
 */
const KRS_VALUE = /^([1-9]\d{0,2}'{0,3})\.-?\d{1,2}$/u;

/** Parses `character<TAB>kRSUnicode` lines into character -> radical number. */
function parseVendoredKrs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const [character, value] = line.split("\t");
    if (character === undefined || value === undefined) {
      throw new Error(`${VENDORED_KRS}: "${line}" is not character<TAB>value.`);
    }
    const matched = KRS_VALUE.exec(value);
    if (matched === null) throw new Error(`${VENDORED_KRS}: "${value}" is not a kRSUnicode value.`);
    out.set(character, matched[1] ?? "");
  }
  if (out.size === 0) throw new Error(`${VENDORED_KRS} holds no entries.`);
  return out;
}

/** Reduces the raw IRG sources file to the vendored two-column form. */
function reduceIrgSources(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 3 || fields[1] !== "kRSUnicode") continue;
    const codepoint = fields[0] ?? "";
    const value = (fields[2] ?? "").split(" ")[0] ?? "";
    if (!codepoint.startsWith("U+")) throw new Error(`unexpected codepoint "${codepoint}".`);
    if (!KRS_VALUE.test(value)) throw new Error(`unexpected kRSUnicode value "${value}".`);
    lines.push(`${String.fromCodePoint(Number.parseInt(codepoint.slice(2), 16))}\t${value}`);
  }
  return lines.join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/* CJKRadicals.txt                                                             */
/* -------------------------------------------------------------------------- */

interface RadicalEntry {
  /** Radical number, apostrophes included: "64", "149'". */
  readonly n: string;
  /** The ordinary unified ideograph formed from the radical: 手, 讠. */
  readonly char: string;
  /**
   * The radical presentation character from the KangXi Radicals or CJK Radicals
   * Supplement block: ⼿, ⻈. May be absent upstream, which is why `char` and
   * not this is what the canon's `radical` field would carry — `char` is the
   * one users can type and search for.
   */
  readonly glyph: string | null;
}

/**
 * `number; radical character; unified ideograph`, semicolon separated, with the
 * middle field allowed to be empty. The simplified variants live in the CJK
 * Radicals Supplement block rather than KangXi Radicals, so the mapping is read
 * from the file and never computed as an offset from the radical number.
 */
function parseCjkRadicals(text: string): Map<string, RadicalEntry> {
  const out = new Map<string, RadicalEntry>();
  for (const raw of text.split("\n")) {
    const line = (raw.split("#")[0] ?? "").trim();
    if (line.length === 0) continue;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length !== 3) throw new Error(`${VENDORED_RADICALS}: "${line}" is not three fields.`);
    const n = fields[0] ?? "";
    const glyphHex = fields[1] ?? "";
    const charHex = fields[2] ?? "";
    if (!/^[1-9]\d{0,2}'{0,3}$/u.test(n)) throw new Error(`${VENDORED_RADICALS}: "${n}" is not a radical number.`);
    out.set(n, {
      n,
      char: String.fromCodePoint(Number.parseInt(charHex, 16)),
      glyph: glyphHex.length === 0 ? null : String.fromCodePoint(Number.parseInt(glyphHex, 16)),
    });
  }
  if (out.size === 0) throw new Error(`${VENDORED_RADICALS} holds no entries.`);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fetch (only `npm run radicals:fetch`; the build itself is offline)          */
/* -------------------------------------------------------------------------- */

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

/**
 * Pulls one member out of a zip. Node ships a deflate decoder and nothing that
 * reads a zip container, and this repo does not add dependencies for one file
 * a year, so: read the end-of-central-directory record, walk the central
 * directory to the wanted name, then inflate at its local header.
 *
 * (`tar -xf` would be three lines but GNU tar cannot read zip archives, so it
 * would work on a Mac and fail on the Ubuntu runner.)
 */
function readZipMember(zip: Buffer, name: string): Buffer {
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === ZIP_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: no end-of-central-directory record.");

  const entries = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(cursor) !== ZIP_CENTRAL) throw new Error("corrupt central directory.");
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const entryName = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (entryName === name) {
      if (zip.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new Error(`corrupt local header for ${name}.`);
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const body = zip.subarray(start, start + compressed);
      const out = method === 0 ? Buffer.from(body) : inflateRawSync(body);
      if (out.length !== uncompressed) {
        throw new Error(`${name}: inflated ${String(out.length)} bytes, expected ${String(uncompressed)}.`);
      }
      return out;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the archive.`);
}

async function download(url: string, expected: string): Promise<Buffer> {
  process.stdout.write(`fetching ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${String(response.status)} ${response.statusText}.`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected) {
    throw new Error(
      `${url} hashes to ${actual}, not the pinned ${expected}. Unicode has ` +
        `republished this file or the download is damaged. Verify the new bytes, ` +
        `then update the pinned digest in src/build/radicals.ts and re-run.`,
    );
  }
  process.stdout.write(`  ${String(body.length)} bytes, sha256 ${actual} (matches pin)\n`);
  return body;
}

async function refreshVendoredFiles(): Promise<void> {
  const zip = await download(`${UCD_BASE}/Unihan.zip`, UNIHAN_ZIP_SHA256);
  const irg = readZipMember(zip, IRG_MEMBER);
  const irgHash = sha256(irg);
  if (irgHash !== IRG_MEMBER_SHA256) {
    throw new Error(`${IRG_MEMBER} hashes to ${irgHash}, not the pinned ${IRG_MEMBER_SHA256}.`);
  }
  process.stdout.write(`  ${IRG_MEMBER}: ${String(irg.length)} bytes, sha256 ${irgHash} (matches pin)\n`);

  const radicals = await download(`${UCD_BASE}/CJKRadicals.txt`, CJK_RADICALS_SHA256);

  const reduced = reduceIrgSources(irg.toString("utf8"));
  writeFileSync(VENDORED_KRS, Buffer.from(reduced, "utf8"));
  writeFileSync(VENDORED_RADICALS, radicals);
  process.stdout.write(
    `vendored ${VENDORED_KRS} (${String(Buffer.byteLength(reduced))} bytes) and ` +
      `${VENDORED_RADICALS} (${String(radicals.length)} bytes)\n`,
  );
}

/* -------------------------------------------------------------------------- */
/* Character inventory                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every Han character in the pinned HSK 3.0 word list, in code point order.
 *
 * Deliberately not a CSV parse. The file has quoted fields, so reading a column
 * correctly would mean duplicating canon.ts's RFC 4180 reader here — and this
 * does not need columns. A radical map is keyed by character, so scanning the
 * whole file for characters is both simpler and strictly safer: quoting cannot
 * change which characters are present, and picking up a stray character from
 * the Variants or OCR columns costs one unused map entry, where missing one
 * would cost a null in the canon.
 */
const HAN_RANGES = /[㐀-䶿一-鿿豈-﫿]/gu;

function characterInventory(): string[] {
  if (!existsSync(HSK_CSV_PATH)) {
    throw new Error(`${HSK_CSV_PATH} is missing. It is a pinned source; restore it from git.`);
  }
  const characters = new Set(readFileSync(HSK_CSV_PATH, "utf8").match(HAN_RANGES) ?? []);
  if (characters.size === 0) throw new Error(`${HSK_CSV_PATH} contains no Han characters.`);
  return [...characters].sort();
}

/**
 * The canon's simplified headwords, if the canon has been built.
 *
 * Reporting only — never an input to the emitted file. Returns null on a clean
 * checkout, where the coverage line is simply not printed.
 */
function canonHeadwordsIfBuilt(): string[] | null {
  if (!existsSync(CANON_PATH)) return null;
  const parsed: unknown = JSON.parse(readFileSync(CANON_PATH, "utf8"));
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const simplified = (row as Record<string, unknown>)["simplified"];
    if (typeof simplified === "string" && simplified.length > 0) out.push(simplified);
  }
  return out.length === 0 ? null : out;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

interface CharRadical {
  /** Radical number, apostrophes included. Joins to the `radicals` table. */
  readonly n: string;
  /** The radical as an ordinary ideograph. This is the value `radical` wants. */
  readonly r: string;
}

function build(): void {
  for (const path of [VENDORED_KRS, VENDORED_RADICALS]) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing. Run \`npm run radicals:fetch\` to vendor it from unicode.org.`);
    }
  }
  const krsBytes = readFileSync(VENDORED_KRS);
  const radicalBytes = readFileSync(VENDORED_RADICALS);
  const krs = parseVendoredKrs(krsBytes.toString("utf8"));
  const table = parseCjkRadicals(radicalBytes.toString("utf8"));
  const inventory = characterInventory();

  const chars = new Map<string, CharRadical>();
  const used = new Set<string>();
  const unmapped: string[] = [];
  for (const character of inventory) {
    const n = krs.get(character);
    if (n === undefined) {
      unmapped.push(character);
      continue;
    }
    if (!table.has(n)) {
      throw new Error(
        `CJKRadicals.txt has no character for radical ${n}, which ${character} uses. ` +
          `The two vendored files are from different Unicode versions; re-run \`npm run radicals:fetch\`.`,
      );
    }
    used.add(n);
    chars.set(character, { n, r: (table.get(n) as RadicalEntry).char });
  }

  // Kangxi order: radical number ascending, base form before its simplified
  // variants, which is what the apostrophe count gives.
  const radicals = [...used]
    .map((n) => table.get(n) as RadicalEntry)
    .sort((a, b) => {
      const an = Number.parseInt(a.n, 10);
      const bn = Number.parseInt(b.n, 10);
      return an - bn || a.n.length - b.n.length;
    })
    .map((entry) => ({ n: entry.n, char: entry.char, glyph: entry.glyph }));

  const charsObject: Record<string, CharRadical> = {};
  for (const [character, entry] of chars) charsObject[character] = entry;

  const document = {
    schema: "zhongdex/radicals/v1",
    generator: "src/build/radicals.ts",
    license: { data: "Unicode-3.0", attribution: LICENSE_ATTRIBUTION },
    unicodeVersion: UNICODE_VERSION,
    inputs: [
      { path: `${UCD_BASE}/Unihan.zip`, sha256: UNIHAN_ZIP_SHA256, bytes: 8518517 },
      { path: `${UCD_BASE}/Unihan.zip!${IRG_MEMBER}`, sha256: IRG_MEMBER_SHA256, bytes: 13352717 },
      { path: `${UCD_BASE}/CJKRadicals.txt`, sha256: CJK_RADICALS_SHA256, bytes: radicalBytes.length },
      { path: "scripts/unihan-radicals.tsv", sha256: sha256(krsBytes), bytes: krsBytes.length },
      { path: "scripts/cjk-radicals.txt", sha256: sha256(radicalBytes), bytes: radicalBytes.length },
      { path: "scripts/hsk30.csv", sha256: sha256(readFileSync(HSK_CSV_PATH)), bytes: statSync(HSK_CSV_PATH).size },
    ],
    characters: chars.size,
    distinctRadicals: radicals.length,
    radicals,
    chars: charsObject,
  };

  writeFileSync(OUT_PATH, Buffer.from(JSON.stringify(document, null, 2) + "\n", "utf8"));

  process.stdout.write(
    `radicals: ${String(chars.size)} of ${String(inventory.length)} Han characters in ` +
      `scripts/hsk30.csv mapped to ${String(radicals.length)} of the ${String(table.size)} ` +
      `Kangxi radicals, from ${String(krs.size)} Unihan kRSUnicode entries\n`,
  );
  if (unmapped.length > 0) {
    process.stdout.write(`  no kRSUnicode: ${unmapped.join(" ")}\n`);
  }
  process.stdout.write(`wrote ${OUT_PATH}\n`);

  report(chars);
}

/**
 * Coverage and radical yield, measured the way the canon would actually read
 * it: the first character of the simplified column, verbatim, with none of the
 * HSK list's editorial notation stripped first.
 */
function report(chars: ReadonlyMap<string, CharRadical>): void {
  const headwords = canonHeadwordsIfBuilt();
  if (headwords === null) {
    process.stdout.write("coverage: not measured — data/hsk_bands.json is not built yet.\n");
    return;
  }

  const perRadical = new Map<string, number>();
  const missed: string[] = [];
  for (const headword of headwords) {
    const entry = chars.get([...headword][0] ?? "");
    if (entry === undefined) {
      missed.push(headword);
      continue;
    }
    perRadical.set(entry.n, (perRadical.get(entry.n) ?? 0) + 1);
  }
  const covered = headwords.length - missed.length;
  process.stdout.write(
    `coverage: ${String(covered)} of ${String(headwords.length)} canon headwords ` +
      `(${((covered / headwords.length) * 100).toFixed(2)}%) resolve a radical from their first character\n`,
  );
  if (missed.length > 0) process.stdout.write(`  not resolved: ${missed.join(", ")}\n`);

  const glyphOf = new Map<string, string>();
  for (const entry of chars.values()) glyphOf.set(entry.n, entry.r);

  const ranked = [...perRadical.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  process.stdout.write(`distinct radicals across those headwords: ${String(ranked.length)}\n`);
  let cumulative = 0;
  for (const [n, count] of ranked.slice(0, 10)) {
    cumulative += count;
    process.stdout.write(
      `  ${n.padEnd(5)} ${glyphOf.get(n) ?? "?"} ${String(count).padStart(4)} headwords, ` +
        `cumulative ${((cumulative / covered) * 100).toFixed(1)}%\n`,
    );
  }
  for (const threshold of [200, 100, 50, 20, 10]) {
    const selected = ranked.filter(([, count]) => count >= threshold);
    const total = selected.reduce((sum, [, count]) => sum + count, 0);
    process.stdout.write(
      `  radicals with >=${String(threshold).padStart(3)} headwords: ${String(selected.length).padStart(3)} ` +
        `covering ${String(total).padStart(5)} headwords (${((total / covered) * 100).toFixed(1)}%)\n`,
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--fetch")) await refreshVendoredFiles();
  build();
}

await main();
