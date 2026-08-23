/**
 * Zhongdex canon build — `npm run build:canon`.
 *
 * Reads the pinned HSK 3.0 (2026) word list and the CC-CEDICT dump and emits
 * three deterministic artifacts into `data/`:
 *
 *   hsk_bands.json    one JSON record per source row
 *   hsk_bands.csv     the same rows, flat
 *   canon-stats.json  counts, join quality, and the input SHA-256s
 *
 * Determinism is a hard requirement: same inputs => byte-identical outputs.
 * No timestamps, no randomness, no locale-sensitive collation anywhere below.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  indexCedict,
  markedToNumbered,
  parseCedict,
  parseCedictKeys,
  resolveCedictKey,
  tonelessSlug,
  type CedictIndex,
} from "./cedict.js";
import type {
  Band,
  BandRange,
  CanonStats,
  CedictMatchTier,
  Definition,
  PinyinNumberedOrigin,
  WordRecord,
} from "./types.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const HSK30_CSV = fileURLToPath(new URL("scripts/hsk30.csv", REPO_ROOT));
const DATA_DIR = fileURLToPath(new URL("data/", REPO_ROOT));
/**
 * CC-CEDICT lives in the SayMei web repo, not here. Override with
 * ZHONGDEX_CEDICT when building somewhere else.
 */
const CEDICT_JSON =
  process.env["ZHONGDEX_CEDICT"] ?? "/Users/lelandchar/Desktop/SayMei-Web/server/data/cedict.json";

const BAND_RANGES: readonly BandRange[] = ["1", "2", "3", "4", "5", "6", "7-9"];

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/** RFC 4180 reader: quoted fields, doubled quotes, embedded newlines, CRLF. */
function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < body.length) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Code-unit comparison. `localeCompare` is locale-sensitive and would break determinism. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The source writes advanced words as "7-9" because the standard's bands 7, 8
 * and 9 share one vocabulary list and are not separated at source. We map the
 * whole range to band 7 and keep "7-9" in `hsk.bandRange` so no consumer can
 * read our 7 as "band 7 specifically".
 */
function toBand(level: string): { band: Band; range: BandRange } {
  switch (level) {
    case "1": return { band: 1, range: "1" };
    case "2": return { band: 2, range: "2" };
    case "3": return { band: 3, range: "3" };
    case "4": return { band: 4, range: "4" };
    case "5": return { band: 5, range: "5" };
    case "6": return { band: 6, range: "6" };
    case "7-9": return { band: 7, range: "7-9" };
    default: throw new Error(`hsk30.csv: unexpected Level value ${JSON.stringify(level)}`);
  }
}

function idSlug(numbered: string): string {
  return numbered.toLowerCase().replace(/u:/g, "v").replace(/[^a-z0-9]/g, "");
}

function posSlug(primary: string | undefined): string {
  const slug = (primary ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug === "" ? "x" : slug;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

interface BuildResult {
  records: WordRecord[];
  stats: CanonStats;
}

function build(csvBuffer: Buffer, cedictBuffer: Buffer): BuildResult {
  const rows = parseCsv(csvBuffer.toString("utf8"));
  const header = rows[0];
  if (header === undefined) throw new Error("hsk30.csv: empty file");
  const columns = new Map(header.map((name, index) => [name, index] as const));
  for (const required of ["ID", "Simplified", "Traditional", "Pinyin", "POS", "Level", "CEDICT"]) {
    if (!columns.has(required)) throw new Error(`hsk30.csv: missing column ${required}`);
  }
  const cell = (row: readonly string[], name: string): string => {
    const index = columns.get(name);
    if (index === undefined) throw new Error(`hsk30.csv: missing column ${name}`);
    return (row[index] ?? "").trim();
  };

  const cedictFile = parseCedict(cedictBuffer.toString("utf8"));
  const cedict: CedictIndex = indexCedict(cedictFile);

  const dataRows = rows.slice(1).filter((row) => row.some((value) => value.trim() !== ""));

  const matchTiers: Record<CedictMatchTier, number> = {
    "exact": 0,
    "case-insensitive": 0,
    "neutral-tone": 0,
    "pinyin-only": 0,
    "pinyin-only-neutral-tone": 0,
    "traditional-only": 0,
  };
  const pinyinOrigin: Record<PinyinNumberedOrigin, number> = {
    "cedict-key": 0,
    "derived-from-marked": 0,
    "toneless-fallback": 0,
  };
  let rowsWithKey = 0;
  let rowsMatched = 0;
  let keysSeen = 0;
  let keysMatched = 0;
  let definitionsEmitted = 0;

  const records: WordRecord[] = [];
  const simplifiedCounts = new Map<string, number>();

  for (const row of dataRows) {
    const listId = cell(row, "ID");
    const simplified = cell(row, "Simplified");
    const traditional = cell(row, "Traditional");
    const marked = cell(row, "Pinyin");
    const posRaw = cell(row, "POS");
    const { band, range } = toBand(cell(row, "Level"));

    const keys = parseCedictKeys(cell(row, "CEDICT"));
    if (keys.length > 0) rowsWithKey += 1;
    keysSeen += keys.length;

    const definitions: Definition[] = [];
    const seenGlosses = new Set<string>();
    const sourceIds: string[] = [`hsk30:${listId}`];
    let matchedNumbered: string | null = null;

    for (const key of keys) {
      const match = resolveCedictKey(cedict, key);
      if (match === null) continue;
      keysMatched += 1;
      matchTiers[match.tier] += 1;
      matchedNumbered ??= key.numbered;
      sourceIds.push(`cc-cedict:${key.raw}`);
      for (const entry of match.entries) {
        for (const gloss of entry.d) {
          if (seenGlosses.has(gloss)) continue;
          seenGlosses.add(gloss);
          definitions.push({
            text: gloss,
            source: "cc-cedict",
            sourceKey: key.raw,
            license: "CC-BY-SA-4.0",
          });
        }
      }
    }
    if (sourceIds.length > 1) rowsMatched += 1;
    definitionsEmitted += definitions.length;

    // The join key's numbered pinyin is authoritative when we have one; it is the
    // reading the list itself chose. Otherwise derive it from the tone marks.
    let numbered: string;
    if (matchedNumbered !== null) {
      numbered = matchedNumbered;
      pinyinOrigin["cedict-key"] += 1;
    } else {
      const derived = markedToNumbered(marked);
      if (derived !== null) {
        numbered = derived;
        pinyinOrigin["derived-from-marked"] += 1;
      } else {
        numbered = tonelessSlug(marked);
        pinyinOrigin["toneless-fallback"] += 1;
      }
    }

    const pos = posRaw === "" ? [] : posRaw.split("/").map((p) => p.trim()).filter((p) => p !== "");

    records.push({
      id: `dex:w:${idSlug(numbered)}:${simplified}:${posSlug(pos[0])}`,
      simplified,
      traditional,
      pinyin: { marked, numbered },
      pos,
      hsk: { band2026: band, bandRange: range, band2021: null, listId },
      definitions,
      sourceIds,
      audio: { female: null, male: null, status: "pending" },
    });
    simplifiedCounts.set(simplified, (simplifiedCounts.get(simplified) ?? 0) + 1);
  }

  // Sort: band, then simplified, then numbered pinyin. Primary POS and the source
  // list id break the remaining ties so the order is total, not merely stable.
  records.sort(
    (a, b) =>
      a.hsk.band2026 - b.hsk.band2026 ||
      compareStrings(a.simplified, b.simplified) ||
      compareStrings(a.pinyin.numbered, b.pinyin.numbered) ||
      compareStrings(a.pos[0] ?? "", b.pos[0] ?? "") ||
      compareStrings(a.hsk.listId, b.hsk.listId),
  );

  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`duplicate record id: ${record.id}`);
    ids.add(record.id);
  }

  const bands: Record<string, number> = {};
  const bandRanges: Record<string, number> = {};
  for (const range of BAND_RANGES) bandRanges[range] = 0;
  for (let band = 1; band <= 7; band += 1) bands[String(band)] = 0;
  for (const record of records) {
    bands[String(record.hsk.band2026)] = (bands[String(record.hsk.band2026)] ?? 0) + 1;
    bandRanges[record.hsk.bandRange] = (bandRanges[record.hsk.bandRange] ?? 0) + 1;
  }

  let formsOnMultipleRows = 0;
  let rowsSharingAForm = 0;
  let maxRowsForOneForm = 0;
  for (const count of simplifiedCounts.values()) {
    if (count > 1) {
      formsOnMultipleRows += 1;
      rowsSharingAForm += count;
    }
    if (count > maxRowsForOneForm) maxRowsForOneForm = count;
  }

  const rowsWithoutKey = records.length - rowsWithKey;
  const stats: CanonStats = {
    schema: "zhongdex/canon-stats/v1",
    generator: "src/build/canon.ts",
    license: {
      wordList: "HSK 3.0 (2026) word list, as vendored in scripts/hsk30.csv",
      definitions: "CC-BY-SA-4.0",
      attribution: [
        "Definitions from CC-CEDICT (https://cc-cedict.org/), CC BY-SA 4.0.",
        "HSK 3.0 (2026) banding from the vendored word list in scripts/hsk30.csv.",
      ],
    },
    inputs: {
      hsk30Csv: {
        path: "scripts/hsk30.csv",
        sha256: sha256(csvBuffer),
        bytes: csvBuffer.byteLength,
        rows: dataRows.length,
      },
      ccCedict: {
        path: CEDICT_JSON,
        sha256: sha256(cedictBuffer),
        bytes: cedictBuffer.byteLength,
        version: cedictFile.version,
        date: cedictFile.date,
        entries: cedictFile.entries,
        headwords: cedict.size,
      },
    },
    rows: { in: dataRows.length, out: records.length, dropped: dataRows.length - records.length },
    bands,
    bandRanges,
    cedict: {
      rowsWithKey,
      rowsWithoutKey,
      rowsMatched,
      rowsUnmatched: records.length - rowsMatched,
      rowsWithZeroDefinitions: records.filter((r) => r.definitions.length === 0).length,
      joinHitRateKeyedRows: rowsWithKey === 0 ? 0 : rowsMatched / rowsWithKey,
      joinHitRateAllRows: records.length === 0 ? 0 : rowsMatched / records.length,
      keysSeen,
      keysMatched,
      keysUnmatched: keysSeen - keysMatched,
      matchTiers,
      definitionsEmitted,
    },
    polyphones: {
      distinctSimplifiedForms: simplifiedCounts.size,
      simplifiedFormsOnMultipleRows: formsOnMultipleRows,
      rowsSharingASimplifiedForm: rowsSharingAForm,
      maxRowsForOneSimplifiedForm: maxRowsForOneForm,
    },
    pinyinNumberedOrigin: pinyinOrigin,
    band2021: {
      known: 0,
      unknown: records.length,
      note: "The 2021 banding is not one of this build's inputs; null means unknown, not absent.",
    },
    audio: {
      pending: records.length,
      resolved: 0,
      note: "Audio hosting does not exist yet. No URLs are emitted rather than URLs that would 404.",
    },
  };

  return { records, stats };
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

const CSV_HEADER = [
  "id",
  "simplified",
  "traditional",
  "pinyin_marked",
  "pinyin_numbered",
  "pos",
  "hsk_band_2026",
  "hsk_band_range",
  "hsk_band_2021",
  "hsk_list_id",
  "definition_count",
  "definitions",
  "source_ids",
  "audio_female",
  "audio_male",
  "audio_status",
] as const;

function toCsv(records: readonly WordRecord[]): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const r of records) {
    lines.push(
      [
        r.id,
        r.simplified,
        r.traditional,
        r.pinyin.marked,
        r.pinyin.numbered,
        r.pos.join(";"),
        String(r.hsk.band2026),
        r.hsk.bandRange,
        r.hsk.band2021 === null ? "" : String(r.hsk.band2021),
        r.hsk.listId,
        String(r.definitions.length),
        // Glosses can contain commas, semicolons, slashes and pipes, so the only
        // lossless flat encoding is a JSON array inside the CSV cell.
        JSON.stringify(r.definitions.map((d) => d.text)),
        r.sourceIds.join(";"),
        r.audio.female ?? "",
        r.audio.male ?? "",
        r.audio.status,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One record per line: valid JSON, and it diffs line by line in git. */
function toJson(records: readonly WordRecord[]): string {
  if (records.length === 0) return "[]\n";
  return `[\n${records.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`;
}

function main(): void {
  const csvBuffer = readFileSync(HSK30_CSV);
  let cedictBuffer: Buffer;
  try {
    cedictBuffer = readFileSync(CEDICT_JSON);
  } catch {
    throw new Error(
      `CC-CEDICT dump not readable at ${CEDICT_JSON}. Set ZHONGDEX_CEDICT to its location.`,
    );
  }

  const { records, stats } = build(csvBuffer, cedictBuffer);

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}hsk_bands.json`, toJson(records));
  writeFileSync(`${DATA_DIR}hsk_bands.csv`, toCsv(records));
  writeFileSync(`${DATA_DIR}canon-stats.json`, `${JSON.stringify(stats, null, 2)}\n`);

  const bandSummary = BAND_RANGES.map((r) => `${r}=${stats.bandRanges[r] ?? 0}`).join(" ");
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  log(`canon: rows in ${stats.rows.in} -> rows out ${stats.rows.out} (dropped ${stats.rows.dropped})`);
  log(
    `canon: cc-cedict hits ${stats.cedict.rowsMatched} misses ${stats.cedict.rowsUnmatched}` +
      ` (${(stats.cedict.joinHitRateAllRows * 100).toFixed(2)}% of rows,` +
      ` ${stats.cedict.rowsWithoutKey} rows carry no key), ${stats.cedict.definitionsEmitted} definitions`,
  );
  log(`canon: bands ${bandSummary}`);
  log(
    `canon: ${stats.polyphones.simplifiedFormsOnMultipleRows} simplified forms span multiple rows` +
      ` (${stats.polyphones.rowsSharingASimplifiedForm} rows) — kept, never deduped`,
  );
  log(`canon: wrote data/hsk_bands.json, data/hsk_bands.csv, data/canon-stats.json`);
}

main();
