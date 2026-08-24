#!/usr/bin/env node
/**
 * Zhongdex — reconcile the canon records that never joined production.
 *
 * 50 of the 11,092 canon records carry `enrichedVia: null`. That is not the
 * same as "this word has no 2021 band": it means the join never happened, so
 * `band2021`, `band2_0`, frequency and audio are *unknown* on those records
 * rather than absent — which is why the 2021→2026 delta pack has to exclude
 * them and report a range instead of a number.
 *
 * The cause is nearly always an annotation baked into the `simplified` cell of
 * the HSK 3.0 list: `哥哥|哥`, `有（一）些`, `家（科学家）`, `称1`. Those strings
 * are not words, so `global_dictionary.characters` has no row for them and the
 * exact-form lookup in `canon.ts` misses. The previous pass deliberately
 * refused to add stripping heuristics, on the grounds that `有（一）些` is a
 * genuine guess between 有些 and 有一些.
 *
 * It is not a guess, and this script is the demonstration. The source list
 * carries two columns the canon build already reads for other purposes:
 *
 *   CEDICT    the join key the *source* assigns the row — `有些|有些[you3 xie1]`
 *             for `有（一）些`, `哥哥|哥哥[ge1 ge5]` for `哥哥|哥`. It names one
 *             simplified form and one reading. The canon record's own pinyin,
 *             definitions and id are already built from it, so joining
 *             enrichment on it adds no claim the record does not already make.
 *   Variants  the source's own decomposition of the annotation, as
 *             `{Simplified, Pinyin, POS}` objects — `有些[yǒuxiē]` and
 *             `有一些[yǒuyīxiē]`. An independent check on the candidate list.
 *
 * So the method is: derive candidate surface forms from the annotation pattern,
 * check them against what the source itself declares, and then test each
 * candidate against production (read-only) and the vendored CC-CEDICT. Resolve
 * only where exactly one candidate row survives; where two do, record both and
 * resolve nothing. A coin-flip that silently becomes a fact is worse than an
 * honest gap, and the whole reason those 50 records exist is that the previous
 * pass would not flip the coin.
 *
 * ── Match tiers, in order ──────────────────────────────────────────────────
 *
 *   1 reading-exact         normalised numbered pinyin is equal. The tier
 *                           `canon.ts` already uses.
 *   2 reading-neutral-tone  the two readings differ only in neutral tone
 *                           (`ma3 tou2` / `ma3 tou5`). Same tolerance the
 *                           CC-CEDICT join in `cedict.ts` already applies, and
 *                           it fires on the same words for the same reason.
 *   3 marked-pinyin         tone-marked pinyin is equal. Consulted only when
 *                           tiers 1-2 find nothing, because `pinyin_numbered`
 *                           is the normalised column and `pinyin` is free text
 *                           upstream (it holds strings like `gē ge ｜ gē` and
 *                           `yuán （fú wù yuá` — production ingested some of
 *                           these same annotations).
 *
 * A tier fires only if it matches exactly one upstream row. Two rows at the
 * same tier is an ambiguity, not a winner. Tiers are tried against the
 * record's *primary* form — the one the CEDICT key names — and a match on a
 * secondary variant alone is reported as ambiguous, never resolved.
 *
 * ── What this script does NOT do ───────────────────────────────────────────
 *
 * It does not write the canon, the canon data, or the enrichment snapshot.
 * `data/unmatched-report.json` is a report: it names, per record, the exact
 * change the owner of `canon.ts` should apply, and carries the evidence for it.
 *
 * Usage:  npm run reconcile:unmatched
 * Needs:  a SayMei checkout for the read-only production query
 *         (ZHONGDEX_SAYMEI_ROOT / SAYMEI_ROOT, default /Users/…/SayMei-Web).
 * Exit:   0 = report written · 1 = could not run
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { markedToNumbered, parseCedict, parseCedictKeys } from "./cedict.js";
import { normalizeReading } from "./db.js";
import type { CedictEntry, CedictKey, WordRecord } from "./types.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const DATA_DIR = fileURLToPath(new URL("data/", REPO_ROOT));
const SCRIPTS_DIR = fileURLToPath(new URL("scripts/", REPO_ROOT));
const CANON_JSON = `${DATA_DIR}hsk_bands.json`;
const REPORT_JSON = `${DATA_DIR}unmatched-report.json`;
const HSK30_CSV = `${SCRIPTS_DIR}hsk30.csv`;
const CEDICT_JSON = `${SCRIPTS_DIR}cedict.json`;

/** Where the SayMei checkout lives. Same convention as `src/build/db.ts`. */
const SAYMEI_ROOT =
  process.env["ZHONGDEX_SAYMEI_ROOT"] ??
  process.env["SAYMEI_ROOT"] ??
  "/Users/lelandchar/Desktop/SayMei-Web";

/* -------------------------------------------------------------------------- */
/* Report shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How the annotation in the `simplified` cell is built. Every one of the 50 is
 * classified into exactly one of these, from the string alone.
 */
type Pattern =
  | "alt-form"
  | "optional-element"
  | "example-in-parens"
  | "homograph-index"
  | "plain";

type Tier = "reading-exact" | "reading-neutral-tone" | "marked-pinyin";

type Verdict = "resolved" | "ambiguous" | "genuinely-absent";

/** One `global_dictionary` row, reduced to the columns this reconciliation reads. */
interface UpstreamRow {
  form: string;
  /** Tone-marked pinyin, verbatim. Free text upstream; treated as weak evidence. */
  pinyin: string;
  /** Numbered pinyin, verbatim. The normalised column, and the primary key. */
  pinyinNumbered: string | null;
  band2021: number | null;
  band2_0: number | null;
  frequencyRank: number | null;
  zipf: number | null;
  /** `audio_url IS NOT NULL AND <> ''`. The URL itself never crosses this boundary. */
  audioAvailable: boolean;
}

interface Candidate {
  form: string;
  /** True for the form the CEDICT key names (or the first variant when there is no key). */
  primary: boolean;
  /** Which independent sources proposed this form. */
  proposedBy: string[];
  /** Tone-marked pinyin the source declares for this form, when it declares one. */
  declaredPinyin: string | null;
  /** Numbered reading used for tiers 1-2, and where it came from. */
  readingNumbered: string | null;
  /** `readingNumbered` through `normalizeReading`. */
  readingKey: string | null;
  readingKeySource: "cedict-key" | "declared-pinyin" | "record" | null;
  /** CC-CEDICT headwords for this form: `pinyin — gloss` lines, evidence only. */
  cedict: string[];
  upstreamRows: UpstreamRow[];
}

interface Match {
  tier: Tier;
  candidate: string;
  row: UpstreamRow;
}

interface Finding {
  id: string;
  listId: string;
  simplified: string;
  traditional: string;
  pinyin: { marked: string; numbered: string };
  pos: string[];
  band2026: number;
  pattern: Pattern;
  patternNote: string;
  /** The source list's own `CEDICT` cell, parsed. Null when the cell is empty. */
  sourceDeclaredKey: { form: string; reading: string; raw: string } | null;
  /** The source list's own `Variants` cell. Empty when the cell is empty. */
  sourceDeclaredVariants: { form: string; pinyin: string }[];
  candidatesAgreeWithSource: boolean;
  candidates: Candidate[];
  verdict: Verdict;
  reason: string;
  resolution: Resolution | null;
  /** Populated on `ambiguous`: every candidate row that could have been chosen. */
  alternatives: { candidate: string; tier: Tier | null; row: UpstreamRow }[];
}

interface Resolution {
  /** The surface form the enrichment row belongs to. */
  form: string;
  tier: Tier;
  /** What `canon.ts` should write onto the record. */
  apply: {
    enrichedVia: "variant-reading";
    band2021: number | null;
    band2_0: number | null;
    frequencyRank: number | null;
    zipf: number | null;
    audioAvailable: boolean;
  };
  /** The row the values come from, so the change can be audited without a database. */
  evidence: UpstreamRow;
  /**
   * Everything true about this join that is weaker than it looks. Empty is the
   * common case; a non-empty list is not a reason to reject the join, it is the
   * reason the join is labelled `variant-reading` and not `reading`.
   */
  caveats: string[];
}

/* -------------------------------------------------------------------------- */
/* Small readers                                                               */
/* -------------------------------------------------------------------------- */

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fail(message: string): never {
  process.stderr.write(`\nreconcile:unmatched could not run\n\n  ${message}\n\n`);
  process.exit(1);
}

/**
 * RFC 4180 reader. Duplicated from `canon.ts` rather than imported: that module
 * does not export it, and it is not this script's to edit.
 */
function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushRow = (): void => {
    row.push(field);
    field = "";
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
      field += ch ?? "";
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
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
    field += ch ?? "";
    i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Pinyin comparison                                                           */
/* -------------------------------------------------------------------------- */

/**
 * True when two numbered readings differ only in neutral tone. Same rule as the
 * `neutral-tone` CC-CEDICT tier in `cedict.ts`, restated here because that one
 * is private to its module.
 */
function neutralToneEqual(a: string, b: string): boolean {
  const left = a.toLowerCase().trim().split(/\s+/);
  const right = b.toLowerCase().trim().split(/\s+/);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined || y === undefined) return false;
    if (x === y) continue;
    if (x.slice(0, -1) === y.slice(0, -1) && (x.endsWith("5") || y.endsWith("5"))) continue;
    return false;
  }
  return true;
}

/**
 * Comparison key for tone-marked pinyin: case and separators removed, Unicode
 * normalised. Upstream writes `gē ge`, the source list writes `gēge`, and the
 * only difference that matters is the tone marks.
 */
function normalizeMarked(value: string | null): string {
  if (value === null) return "";
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s·''‧,.-]/g, "");
}

/* -------------------------------------------------------------------------- */
/* Annotation patterns                                                         */
/* -------------------------------------------------------------------------- */

const PAREN = /^(.*)（(.+)）(.*)$/;
const HOMOGRAPH = /^(.+?)([0-9])$/;

/**
 * Classify one annotated `simplified` cell and propose the surface forms it
 * could denote. Nothing here decides anything: every proposal is checked
 * against the source's own columns and against production before it is used.
 *
 *   `A|B`     an entry and its short form, written in parallel with the pinyin
 *             cell (`哥哥|哥` / `gēge|gē`). Candidates: A and B.
 *   `X（Y）Z`  Y is optional material inside the word (`有（一）些`, `好（不）容易`).
 *             Candidates: XZ and XYZ.
 *   `X（Y）`   Y is an *example* of X in use, not part of it — recognised by Y
 *             containing X (`家（科学家）`, `头（里头）`). Candidates: X, and Y
 *             itself, which the source's Variants column also lists. Y is a
 *             control: it is a real word with its own upstream row and its own
 *             reading, and the fact that its reading is not the record's is
 *             what shows the parenthesis is an example and not the headword.
 *   `X<digit>` a homograph index the source uses to split senses (`称1`, `面2`).
 *             Candidate: X. The digit is not part of any word.
 *   plain      no annotation at all. Candidate: the form itself.
 */
function classify(simplified: string): { pattern: Pattern; note: string; forms: string[] } {
  if (simplified.includes("|")) {
    const parts = simplified.split("|").filter((p) => p !== "");
    return {
      pattern: "alt-form",
      note: `"${simplified}" is an entry and its short form, written in parallel with the pinyin cell.`,
      forms: parts,
    };
  }
  const paren = PAREN.exec(simplified);
  if (paren !== null) {
    const [, head = "", inner = "", tail = ""] = paren;
    if (tail === "" && head !== "" && inner.includes(head)) {
      return {
        pattern: "example-in-parens",
        note: `"${simplified}" is the bound form ${head} with ${inner} shown as an example of it; ${inner} contains ${head}, which is what marks the parenthesis as an example rather than optional material.`,
        forms: [head, inner],
      };
    }
    return {
      pattern: "optional-element",
      note: `"${simplified}" writes ${inner} as optional material inside the word.`,
      forms: [`${head}${tail}`, `${head}${inner}${tail}`],
    };
  }
  const homograph = HOMOGRAPH.exec(simplified);
  if (homograph !== null) {
    const [, stem = "", digit = ""] = homograph;
    return {
      pattern: "homograph-index",
      note: `"${simplified}" is ${stem} with the source's sense index ${digit} appended; the digit is not part of the word.`,
      forms: [stem],
    };
  }
  return {
    pattern: "plain",
    note: `"${simplified}" carries no annotation: it is the word as the list writes it.`,
    forms: [simplified],
  };
}

/** The tone-marked pinyin the source declares for each part of an `A|B` cell. */
function markedParts(marked: string, count: number): (string | null)[] {
  const parts = marked.split("|").map((p) => p.trim());
  if (parts.length !== count) return Array.from({ length: count }, () => null);
  return parts.map((p) => (p === "" ? null : p));
}

/* -------------------------------------------------------------------------- */
/* Production (read-only)                                                      */
/* -------------------------------------------------------------------------- */

interface PgQueryResult {
  rows: unknown[];
}
interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: {
    connectionString: string;
    ssl: { rejectUnauthorized: boolean };
    statement_timeout: number;
  }) => PgClient;
}

function readDatabaseUrl(): string {
  const envPath = join(SAYMEI_ROOT, ".env");
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    fail(
      `Cannot read ${envPath}.\n` +
        `  reconcile:unmatched needs a SayMei checkout to re-run the production probe;\n` +
        `  set ZHONGDEX_SAYMEI_ROOT to it. The committed data/unmatched-report.json\n` +
        `  already carries every row this script read, so nothing else in the build\n` +
        `  needs a database.`,
    );
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("DATABASE_URL=")) continue;
    const value = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return value;
  }
  return fail(`${envPath} has no non-empty DATABASE_URL.`);
}

/**
 * One SELECT over `global_dictionary` for every candidate form at once.
 *
 * `pg` is imported from the SayMei checkout at run time and is not a dependency
 * of this repo, for the reason `src/build/db.ts` gives: CI must not be able to
 * reach a private database. The tone-marked `pinyin` column is read here and
 * not by `db.ts`, which reduces rows to the six enrichment fields; tier 3 needs
 * it. `audio_url` is reduced to a boolean inside the query so no clip path can
 * reach the report.
 */
async function fetchRows(forms: readonly string[]): Promise<Map<string, UpstreamRow[]>> {
  const entry = join(SAYMEI_ROOT, "node_modules", "pg", "lib", "index.js");
  const loaded = (await import(entry)) as { default?: PgModule } & Partial<PgModule>;
  const pg = loaded.default ?? (loaded as PgModule);
  if (typeof pg.Client !== "function") fail(`${entry} did not export a Client constructor.`);
  const client = new pg.Client({
    connectionString: readDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `select characters,
              pinyin,
              pinyin_numbered,
              hsk_new_level,
              hsk_old_level,
              frequency_rank,
              zipf_score,
              (audio_url is not null and audio_url <> '') as has_audio
         from global_dictionary
        where characters = any($1::text[])`,
      [[...forms]],
    );
    const byForm = new Map<string, UpstreamRow[]>();
    for (const raw of result.rows) {
      if (!isRecord(raw)) continue;
      const form = asStringOrNull(raw["characters"]);
      if (form === null) continue;
      const bucket = byForm.get(form) ?? [];
      bucket.push({
        form,
        pinyin: asStringOrNull(raw["pinyin"]) ?? "",
        pinyinNumbered: asStringOrNull(raw["pinyin_numbered"]),
        band2021: asNumberOrNull(raw["hsk_new_level"]),
        band2_0: asNumberOrNull(raw["hsk_old_level"]),
        frequencyRank: asNumberOrNull(raw["frequency_rank"]),
        zipf: asNumberOrNull(raw["zipf_score"]),
        audioAvailable: raw["has_audio"] === true,
      });
      byForm.set(form, bucket);
    }
    // Postgres promises no row order. Sort so two runs over unchanged data
    // produce the same report, byte for byte.
    for (const rows of byForm.values()) {
      rows.sort(
        (a, b) =>
          compareStrings(a.pinyinNumbered ?? "", b.pinyinNumbered ?? "") ||
          compareStrings(a.pinyin, b.pinyin) ||
          (a.frequencyRank ?? -1) - (b.frequencyRank ?? -1),
      );
    }
    return byForm;
  } finally {
    await client.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

function matchesAt(tier: Tier, candidate: Candidate, row: UpstreamRow): boolean {
  if (tier === "reading-exact") {
    return (
      candidate.readingKey !== null &&
      row.pinyinNumbered !== null &&
      normalizeReading(row.pinyinNumbered) === candidate.readingKey
    );
  }
  if (tier === "reading-neutral-tone") {
    // Compares the spaced readings, not the normalised keys: the rule is
    // syllable-by-syllable and needs the syllable boundaries.
    return (
      candidate.readingNumbered !== null &&
      row.pinyinNumbered !== null &&
      neutralToneEqual(row.pinyinNumbered, candidate.readingNumbered)
    );
  }
  const declared = candidate.declaredPinyin;
  return declared !== null && normalizeMarked(row.pinyin) === normalizeMarked(declared);
}

const TIERS: readonly Tier[] = ["reading-exact", "reading-neutral-tone", "marked-pinyin"];

/** Every (candidate, row) pair that matches at `tier`. */
function matchesFor(candidates: readonly Candidate[], tier: Tier): Match[] {
  const out: Match[] = [];
  for (const candidate of candidates) {
    for (const row of candidate.upstreamRows) {
      if (matchesAt(tier, candidate, row)) out.push({ tier, candidate: candidate.form, row });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const canonBuffer = readFileSync(CANON_JSON);
  const csvBuffer = readFileSync(HSK30_CSV);
  const cedictBuffer = readFileSync(CEDICT_JSON);

  const canon = JSON.parse(canonBuffer.toString("utf8")) as WordRecord[];
  if (!Array.isArray(canon)) fail(`${CANON_JSON} is not a JSON array.`);
  const cedict = parseCedict(cedictBuffer.toString("utf8"));

  const csv = parseCsv(csvBuffer.toString("utf8"));
  const header = csv[0] ?? [];
  const columnOf = (name: string): number => header.indexOf(name);
  const idColumn = columnOf("ID");
  const variantsColumn = columnOf("Variants");
  const cedictColumn = columnOf("CEDICT");
  if (idColumn < 0 || variantsColumn < 0 || cedictColumn < 0) {
    fail(`${HSK30_CSV} is missing one of the ID / Variants / CEDICT columns.`);
  }
  const csvById = new Map<string, string[]>();
  for (const row of csv.slice(1)) {
    const id = row[idColumn];
    if (id !== undefined && id !== "") csvById.set(id, row);
  }

  const unmatched = canon.filter((record) => record.enrichedVia === null);
  if (unmatched.length === 0) fail(`${CANON_JSON} has no records with enrichedVia: null.`);

  // Which (form, reading) pairs the rest of the canon has already claimed. Used
  // for the shared-row caveat: a bound morpheme and the free word it is spelt
  // like are one row upstream, and the record should say so.
  const claimed = new Map<string, string[]>();
  for (const record of canon) {
    if (record.enrichedVia === null) continue;
    const key = `${record.simplified} ${normalizeReading(record.pinyin.numbered)}`;
    const bucket = claimed.get(key) ?? [];
    bucket.push(record.id);
    claimed.set(key, bucket);
  }

  /* Pass 1 — candidates. */
  interface Pending {
    record: WordRecord;
    pattern: Pattern;
    note: string;
    key: CedictKey | null;
    variants: { form: string; pinyin: string }[];
    candidates: Candidate[];
  }
  const pending: Pending[] = [];
  const formsToQuery = new Set<string>();

  for (const record of unmatched) {
    const { pattern, note, forms } = classify(record.simplified);
    const csvRow = csvById.get(record.hsk.listId) ?? [];

    const rawKey = csvRow[cedictColumn] ?? "";
    const key = parseCedictKeys(rawKey)[0] ?? null;

    const variants: { form: string; pinyin: string }[] = [];
    const rawVariants = csvRow[variantsColumn] ?? "";
    if (rawVariants.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(rawVariants);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (!isRecord(entry)) continue;
            const form = asStringOrNull(entry["Simplified"]);
            if (form === null) continue;
            variants.push({ form, pinyin: asStringOrNull(entry["Pinyin"]) ?? "" });
          }
        }
      } catch {
        // A malformed cell is evidence of nothing; the pattern candidates stand alone.
      }
    }

    const parallel = markedParts(record.pinyin.marked, forms.length);
    const primaryForm = key?.simplified ?? forms[0] ?? record.simplified;

    const byForm = new Map<string, Candidate>();
    const propose = (form: string, by: string, declared: string | null): void => {
      if (form === "") return;
      const existing = byForm.get(form);
      if (existing !== undefined) {
        if (!existing.proposedBy.includes(by)) existing.proposedBy.push(by);
        if (existing.declaredPinyin === null && declared !== null) existing.declaredPinyin = declared;
        return;
      }
      byForm.set(form, {
        form,
        primary: form === primaryForm,
        proposedBy: [by],
        declaredPinyin: declared,
        readingKey: null,
        readingKeySource: null,
        readingNumbered: null,
        cedict: [],
        upstreamRows: [],
      });
    };

    forms.forEach((form, index) => {
      propose(form, "annotation-pattern", parallel[index] ?? null);
    });
    for (const variant of variants) propose(variant.form, "hsk-list-variants-column", variant.pinyin);
    if (key !== null) propose(key.simplified, "hsk-list-cedict-column", null);

    for (const candidate of byForm.values()) {
      // Reading key, best evidence first: the source's own CEDICT key names one
      // reading for one form; failing that the variant's declared pinyin; failing
      // that the record's own numbered pinyin.
      let numbered: string | null = null;
      let source: Candidate["readingKeySource"] = null;
      if (key !== null && candidate.form === key.simplified) {
        numbered = key.numbered;
        source = "cedict-key";
      } else if (candidate.declaredPinyin !== null) {
        numbered = markedToNumbered(candidate.declaredPinyin);
        source = numbered === null ? null : "declared-pinyin";
      }
      if (numbered === null && candidate.form === record.simplified) {
        numbered = record.pinyin.numbered;
        source = "record";
      }
      candidate.readingNumbered = numbered;
      candidate.readingKey = numbered === null ? null : normalizeReading(numbered);
      candidate.readingKeySource = source;
      if (candidate.declaredPinyin === null && candidate.form === record.simplified) {
        candidate.declaredPinyin = record.pinyin.marked;
      }
      const entries: readonly CedictEntry[] = cedict.data[candidate.form] ?? [];
      candidate.cedict = entries.map((entry) => `${entry.pn} — ${entry.d[0] ?? ""}`);
      formsToQuery.add(candidate.form);
    }

    pending.push({
      record,
      pattern,
      note,
      key,
      variants,
      candidates: [...byForm.values()].sort(
        (a, b) => Number(b.primary) - Number(a.primary) || compareStrings(a.form, b.form),
      ),
    });
  }

  /* Pass 2 — production. */
  const queried = [...formsToQuery].sort(compareStrings);
  const rowsByForm = await fetchRows(queried);
  for (const item of pending) {
    for (const candidate of item.candidates) {
      candidate.upstreamRows = rowsByForm.get(candidate.form) ?? [];
    }
  }

  /* Pass 3 — verdicts. */
  const findings: Finding[] = [];
  for (const { record, pattern, note, key, variants, candidates } of pending) {
    const primaries = candidates.filter((c) => c.primary);
    const secondaries = candidates.filter((c) => !c.primary);
    const anyRows = candidates.some((c) => c.upstreamRows.length > 0);

    let verdict: Verdict = "ambiguous";
    let reason = "";
    let resolution: Resolution | null = null;
    const alternatives: Finding["alternatives"] = [];

    if (!anyRows) {
      verdict = "genuinely-absent";
      reason =
        `No candidate form has any row in global_dictionary: ${candidates
          .map((c) => c.form)
          .join(", ")}. The enrichment source simply does not carry this entry, so band2021, ` +
        "band2_0, frequency and audio cannot be observed for it from this source at all. " +
        "Leave enrichedVia null: the record is unknown, not demonstrably absent from the 2021 list.";
    } else {
      let firing: Match[] | null = null;
      for (const tier of TIERS) {
        const primaryMatches = matchesFor(primaries, tier);
        if (primaryMatches.length > 0) {
          firing = primaryMatches;
          break;
        }
        const secondaryMatches = matchesFor(secondaries, tier);
        if (secondaryMatches.length > 0) {
          firing = secondaryMatches;
          break;
        }
      }

      if (firing === null) {
        reason =
          `Rows exist upstream (${candidates
            .filter((c) => c.upstreamRows.length > 0)
            .map((c) => `${c.form}×${c.upstreamRows.length}`)
            .join(", ")}) but none of them matches this record's reading at any tier. ` +
          "Taking one anyway would be a guess about which reading the row describes.";
        for (const candidate of candidates) {
          for (const row of candidate.upstreamRows) {
            alternatives.push({ candidate: candidate.form, tier: null, row });
          }
        }
      } else if (firing.length > 1) {
        reason =
          `${firing.length} upstream rows match at the ${firing[0]?.tier ?? ""} tier ` +
          `(${firing.map((m) => m.candidate).join(", ")}). Two candidates that both match is ` +
          "exactly the case where picking one is a coin flip, so nothing is resolved. Both are recorded below.";
        for (const match of firing) {
          alternatives.push({ candidate: match.candidate, tier: match.tier, row: match.row });
        }
      } else {
        const match = firing[0];
        if (match === undefined) throw new Error("unreachable: firing tier with no match");
        const onPrimary = primaries.some((c) => c.form === match.candidate);
        if (!onPrimary) {
          reason =
            `The record's primary form ${primaries[0]?.form ?? record.simplified} has ` +
            `${primaries.reduce((n, c) => n + c.upstreamRows.length, 0)} upstream row(s), none matching ` +
            `its declared reading; only the secondary variant ${match.candidate} matches. Resolving to a ` +
            "secondary variant when the primary form is itself attested upstream would be a choice between " +
            "two attested words, so nothing is resolved. Both are recorded below.";
          for (const candidate of candidates) {
            for (const row of candidate.upstreamRows) {
              alternatives.push({
                candidate: candidate.form,
                tier: candidate.form === match.candidate ? match.tier : null,
                row,
              });
            }
          }
        } else {
          const caveats: string[] = [];
          const rowReading = normalizeReading(match.row.pinyinNumbered ?? "");
          const sharers = claimed.get(`${match.candidate} ${rowReading}`) ?? [];
          if (sharers.length > 0) {
            caveats.push(
              `Upstream has one row per (form, reading), so this row is the free word ${match.candidate}; ` +
                `${sharers.length} canon record(s) already join to it (${sharers.join(", ")}). band2021 and ` +
                "frequency are therefore form-level facts about " +
                `${match.candidate}, not sense-level facts about this entry. The canon already assigns one ` +
                "upstream row to several records elsewhere (259 canon rows share a simplified form), so this " +
                "is the existing behaviour, not a new one — but enrichedVia must say `variant-reading` so a " +
                "consumer can filter it.",
            );
          }
          // A duplicate row is another row for the same form that does not
          // describe a different reading: either it carries no numbered reading
          // at all, or it carries the same one. A row with a *different*
          // reading is a different word and is not evidence about this one.
          const contested = candidates
            .flatMap((c) => c.upstreamRows.map((row) => ({ form: c.form, row })))
            .filter(
              (other) =>
                other.form === match.candidate &&
                other.row !== match.row &&
                (other.row.pinyinNumbered === null ||
                  normalizeReading(other.row.pinyinNumbered) === rowReading) &&
                other.row.frequencyRank !== null &&
                other.row.frequencyRank !== match.row.frequencyRank,
            );
          for (const other of contested) {
            caveats.push(
              `A duplicate upstream row for ${other.form} (pinyin "${other.row.pinyin}") gives ` +
                `frequency_rank ${String(other.row.frequencyRank)} against this row's ` +
                `${String(match.row.frequencyRank)}. The bands come only from this row; the rank is contested.`,
            );
          }
          if (match.tier !== "reading-exact") {
            caveats.push(
              match.tier === "reading-neutral-tone"
                ? "Matched on the neutral-tone tolerance the CC-CEDICT join already applies to this same word."
                : "Matched on tone-marked pinyin because no upstream row for this form carries a numbered reading that matches; " +
                  "the marked column is free text upstream.",
            );
          }
          verdict = "resolved";
          reason =
            `Exactly one upstream row matches at the ${match.tier} tier, on the form ` +
            `${match.candidate}, which is the form the source list's own ` +
            `${key === null ? "Variants column" : "CEDICT column"} names for this entry.`;
          resolution = {
            form: match.candidate,
            tier: match.tier,
            apply: {
              enrichedVia: "variant-reading",
              band2021: match.row.band2021,
              band2_0: match.row.band2_0,
              frequencyRank: match.row.frequencyRank,
              zipf: match.row.zipf,
              audioAvailable: match.row.audioAvailable,
            },
            evidence: match.row,
            caveats,
          };
        }
      }
    }

    const patternForms = new Set(classify(record.simplified).forms);
    const declaredForms = new Set([
      ...variants.map((v) => v.form),
      ...(key === null ? [] : [key.simplified]),
    ]);
    const agree =
      declaredForms.size === 0 ||
      [...declaredForms].every((form) => patternForms.has(form));

    findings.push({
      id: record.id,
      listId: record.hsk.listId,
      simplified: record.simplified,
      traditional: record.traditional,
      pinyin: { marked: record.pinyin.marked, numbered: record.pinyin.numbered },
      pos: record.pos,
      band2026: record.hsk.band2026,
      pattern,
      patternNote: note,
      sourceDeclaredKey:
        key === null ? null : { form: key.simplified, reading: key.numbered, raw: key.raw },
      sourceDeclaredVariants: variants,
      candidatesAgreeWithSource: agree,
      candidates,
      verdict,
      reason,
      resolution,
      alternatives,
    });
  }

  /* Pass 4 — records that resolve to the same upstream row as each other.
     `称1` and `称2` are one sense split the source made and upstream did not;
     both land on the single 称[cheng1] row, and each has to say so. */
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const resolution = finding.resolution;
    if (resolution === null) continue;
    const key = `${resolution.form} ${normalizeReading(resolution.evidence.pinyinNumbered ?? "")}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(finding);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    for (const finding of bucket) {
      const others = bucket.filter((f) => f !== finding).map((f) => `${f.simplified} (${f.id})`);
      finding.resolution?.caveats.push(
        `${String(bucket.length)} of these 50 records resolve to this same upstream row: ` +
          `${others.join(", ")}. Upstream carries one row per (form, reading) and does not split the ` +
          "sense the source list splits, so they take the same band and the same rank.",
      );
    }
  }

  /* Report. */
  const count = (v: Verdict): number => findings.filter((f) => f.verdict === v).length;
  const byPattern: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const finding of findings) {
    byPattern[finding.pattern] = (byPattern[finding.pattern] ?? 0) + 1;
    if (finding.resolution !== null) {
      byTier[finding.resolution.tier] = (byTier[finding.resolution.tier] ?? 0) + 1;
    }
  }
  const resolved = findings.filter((f) => f.resolution !== null);
  const withBand2021 = resolved.filter((f) => f.resolution?.apply.band2021 !== null).length;
  const knownAbsent2021 = resolved.length - withBand2021;
  const sharedRow = resolved.filter((f) =>
    (f.resolution?.caveats ?? []).some((c) => c.startsWith("Upstream has one row per")),
  ).length;

  const report = {
    schema: "zhongdex/unmatched-report/v1",
    generator: "src/build/reconcile-unmatched.ts",
    question:
      "50 canon records carry enrichedVia: null, so band2021 is unknown rather than absent and the " +
      "2021→2026 delta pack has to exclude them. Which of them can be resolved without guessing?",
    method: {
      candidates:
        "Derived from the annotation pattern in the simplified cell, then cross-checked against the " +
        "source list's own Variants and CEDICT columns. No candidate is invented by this script that " +
        "the source does not also propose.",
      tiers: [
        "reading-exact — normalised numbered pinyin equal (the tier canon.ts already uses)",
        "reading-neutral-tone — readings differ only in neutral tone (the tolerance cedict.ts already applies)",
        "marked-pinyin — tone-marked pinyin equal; consulted only when the numbered tiers find nothing",
      ],
      resolveWhen:
        "Exactly one upstream row matches, at the first tier that matches anything, on the record's " +
        "primary form. Two matching rows, or a match only on a secondary variant while the primary form " +
        "is itself attested upstream, resolves nothing and records both.",
      neverDone:
        "No form is guessed, no band is inferred from a sibling word, and nothing is written to the " +
        "canon or the enrichment snapshot by this script.",
    },
    inputs: {
      canon: { path: "data/hsk_bands.json", sha256: sha256(canonBuffer), records: canon.length },
      hsk30Csv: { path: "scripts/hsk30.csv", sha256: sha256(csvBuffer) },
      ccCedict: { path: "scripts/cedict.json", sha256: sha256(cedictBuffer) },
      production: {
        system: "SayMei production Postgres",
        table: "global_dictionary",
        access: "read-only SELECT; audio_url reduced to a boolean in the query, no URL captured",
        columns: [
          "characters",
          "pinyin",
          "pinyin_numbered",
          "hsk_new_level",
          "hsk_old_level",
          "frequency_rank",
          "zipf_score",
          "audio_url (as a boolean)",
        ],
        formsQueried: queried.length,
        formsWithRows: [...rowsByForm.keys()].length,
      },
    },
    summary: {
      records: findings.length,
      resolved: count("resolved"),
      ambiguous: count("ambiguous"),
      genuinelyAbsent: count("genuinely-absent"),
      resolvedByTier: byTier,
      byPattern,
      candidatesAgreeWithSource: findings.filter((f) => f.candidatesAgreeWithSource).length,
      band2021Gained: withBand2021,
      band2021KnownAbsentAfterFix: knownAbsent2021,
      resolutionsSharingAnUpstreamRowWithAnotherCanonRecord: sharedRow,
    },
    proposedChange: {
      owner: "src/build/canon.ts and src/build/enrich.ts",
      summary:
        "Add one join tier, and capture the forms it needs. Neither file is edited by this script.",
      steps: [
        "1. enrich.ts: request the variant forms as well as the canon's literal simplified forms. " +
          "The variant of a record is the simplified form of its CEDICT key (already parsed by " +
          "cedict.ts), falling back to the Variants column. That adds " +
          `${String(queried.length)} forms to the snapshot request.`,
        "2. canon.ts: after the exact-form lookup misses, retry joinRecord against the variant form " +
          "using the CEDICT key's reading, with the reading-exact, neutral-tone and marked tiers in " +
          "that order, resolving only on a single match.",
        '3. types.ts: extend EnrichmentJoin with "variant-reading" so the weaker basis is visible in ' +
          "the data and a consumer can filter it. Do not label these joins `reading`.",
        "4. canon-stats.json: report the new tier in enrichment.joined, and drop the caveat that the " +
          "delta is a range once the unresolved remainder is down to the records listed here.",
      ],
      apply: resolved.map((finding) => ({
        id: finding.id,
        listId: finding.listId,
        simplified: finding.simplified,
        joinTo: finding.resolution?.form ?? "",
        tier: finding.resolution?.tier ?? "",
        set: finding.resolution?.apply ?? null,
      })),
      leaveUnknown: findings
        .filter((f) => f.verdict !== "resolved")
        .map((f) => ({ id: f.id, simplified: f.simplified, verdict: f.verdict, reason: f.reason })),
    },
    records: findings,
  };

  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  log(
    `reconcile: ${findings.length} unmatched records — ${count("resolved")} resolved, ` +
      `${count("ambiguous")} ambiguous, ${count("genuinely-absent")} genuinely absent upstream`,
  );
  log(
    `reconcile: tiers ${Object.entries(byTier)
      .map(([tier, n]) => `${tier}=${String(n)}`)
      .join(" ")}`,
  );
  log(
    `reconcile: ${String(withBand2021)} records gain a band2021, ${String(knownAbsent2021)} become ` +
      `known-absent from the 2021 list (today both read as unknown)`,
  );
  log(
    `reconcile: ${String(sharedRow)} resolutions share their upstream row with a canon record that ` +
      "already joined — recorded as a caveat on each",
  );
  for (const finding of findings) {
    if (finding.verdict === "resolved") continue;
    log(`reconcile:   ${finding.verdict.padEnd(17)} ${finding.simplified}  ${finding.reason}`);
  }
  log(`reconcile: wrote data/unmatched-report.json`);
}

main().catch((error: unknown) => {
  fail((error as Error).message);
});
