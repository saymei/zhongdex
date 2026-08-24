/**
 * Zhongdex sentence corpus — `npm run build:sentences`.
 *
 * Reads the canon written by `build:canon`, pulls example sentences for every
 * canon headword out of SayMei's production dictionary, grades each one with
 * the Zhongdex Sentence Grade (see `grade.ts`), keeps up to three per headword
 * spanning easy / at-level / stretch, and writes two deterministic artifacts:
 *
 *   data/sentences.jsonl      one sentence record per line, sorted by id
 *   data/sentence-stats.json  counts, grade distribution, every drop reason
 *
 * ── Source, and why this one ───────────────────────────────────────────────
 *
 * Three candidates exist upstream. This build reads
 * `global_dictionary.example_sentences_json` and nothing else:
 *
 *   example_sentences_json   138,195 sentences under 10,900 of the 10,959
 *     (CHOSEN)               distinct canon forms. Written per headword, so
 *                            99.4% actually contain the word they are filed
 *                            under. Simplified script, tone-marked pinyin and
 *                            English on every row, a sense index on ~57%, and
 *                            an audio clip on 60%.
 *
 *   example_sentences        80,630 rows. 61,790 are Tatoeba: mostly
 *   + entry_sentences        traditional script (「我們選她為主席。」), numbered
 *                            pinyin only, 1,049 rows carrying Latin prose. Its
 *                            407,652 `entry_sentences` links are substring
 *                            matches — every sentence containing 一 is "linked"
 *                            to 一 — so the alignment is not sense-level in any
 *                            useful way. The 18,840 Gemini rows are cleaner but
 *                            have no pinyin at all, and a 2,000-row sample
 *                            found 99% of them already present in the jsonb.
 *
 *   sentence_audio_url       91 of 201,830 rows. A dead column. §4.6 of the
 *                            spec says so explicitly; not read here.
 *
 * ── Audio ──────────────────────────────────────────────────────────────────
 *
 * Availability only, never a URL. Reading the production bucket is metered
 * egress and no clip is hosted under a Zhongdex domain yet; a URL migration
 * ships later. The two audio booleans are reduced inside the SQL so no URL
 * crosses this boundary at all.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 *
 * Every sort is total and locale-free, every id is content-derived, and there
 * is no timestamp anywhere in the output. Two runs against the same upstream
 * rows are byte-identical. The upstream itself is live production, so the stats
 * stamp a digest of the extraction: if that digest moves, the input moved.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { markedToNumbered } from "./cedict.js";
import {
  BANDS,
  CharLengthTable,
  buildCanonIndex,
  grade,
  lookupForms,
  normalizeText,
  rejectionReason,
  sentenceId,
  type CanonIndex,
  type CanonRow,
} from "./grade.js";
import {
  DROP_REASONS,
  type AudioTier,
  type DropReason,
  type HeadwordLink,
  type SentenceRecord,
  type SentenceStats,
  type TriadSlot,
} from "./sentence-schema.js";
import type { Band } from "./types.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const DATA_DIR = fileURLToPath(new URL("data/", REPO_ROOT));
const GENERATOR = "src/build/sentences.ts";

/**
 * Where the SayMei checkout lives, read from `ZHONGDEX_SAYMEI_ROOT` — the same
 * knob `db.ts` uses, and with the same rule: no default, resolved lazily.
 * `build:sentences` is a maintainer refresh of `data/sentences.jsonl`; the
 * committed corpus is what everyone else reads, so `npm run build` needs no
 * configuration and never calls this.
 */
function saymeiRoot(): string {
  const root = process.env["ZHONGDEX_SAYMEI_ROOT"];
  if (root === undefined || root.trim() === "") {
    throw new Error(
      "ZHONGDEX_SAYMEI_ROOT is not set.\n" +
        "  build:sentences re-reads SayMei's production dictionary, so it needs the\n" +
        "  path to a SayMei checkout:\n" +
        "    ZHONGDEX_SAYMEI_ROOT=/path/to/SayMei-Web npm run build:sentences\n" +
        "  Building does not need it: data/sentences.jsonl is committed, and\n" +
        "  `npm run build` never opens a connection.",
    );
  }
  return root.trim();
}

/* -------------------------------------------------------------------------- */
/* Production read                                                             */
/* -------------------------------------------------------------------------- */

/** The sliver of `pg` used here. Structural, so `pg` stays out of package.json. */
interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
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
  const envPath = join(saymeiRoot(), ".env");
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${envPath}.\n` +
        `  build:sentences reads SayMei's production dictionary; set ZHONGDEX_SAYMEI_ROOT\n` +
        `  to a SayMei checkout that has a .env with DATABASE_URL.`,
    );
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("DATABASE_URL=")) continue;
    const value = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return value;
  }
  throw new Error(`${envPath} has no non-empty DATABASE_URL.`);
}

async function connect(): Promise<PgClient> {
  const entry = join(saymeiRoot(), "node_modules", "pg", "lib", "index.js");
  // Non-literal specifier on purpose: `pg` is not a dependency of this repo and
  // must not become one, so that `npm ci` in CI cannot reach a database.
  const loaded = (await import(entry)) as { default?: PgModule } & Partial<PgModule>;
  const pg = loaded.default ?? (loaded as PgModule);
  if (typeof pg.Client !== "function") throw new Error(`${entry} did not export a Client.`);
  const client = new pg.Client({
    connectionString: readDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300_000,
  });
  await client.connect();
  return client;
}

/**
 * One SELECT. No writes, no DDL, no transaction. Both audio fields collapse to
 * booleans inside the query so a URL cannot leak into this process.
 */
const SENTENCE_QUERY = `
  SELECT g.characters                                  AS form,
         g.id                                          AS entry_id,
         o.ord                                         AS ord,
         e ->> 'chinese'                               AS zh,
         e ->> 'pinyin'                                AS py,
         e ->> 'english'                               AS en,
         e ->> 'meaningIndex'                          AS sense,
         e ->> 'audioSource'                           AS audio_source,
         e ->> 'hskLevel'                              AS source_level,
         (COALESCE(e ->> 'audioUrl', '') <> '')        AS has_audio,
         (COALESCE(e ->> 'audioMasterUrl', '') <> '')  AS has_master
  FROM global_dictionary g
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(g.example_sentences_json, '[]'::jsonb))
       WITH ORDINALITY AS o(e, ord)
  WHERE g.characters = ANY($1::text[])
  ORDER BY g.characters, g.id, o.ord
`;

interface RawSentence {
  form: string;
  hanzi: string;
  pinyin: string;
  english: string;
  senseIndex: number | null;
  audioSource: string | null;
  sourceLevel: number | null;
  hasAudio: boolean;
  hasMaster: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

async function fetchSentences(forms: readonly string[]): Promise<RawSentence[]> {
  const client = await connect();
  try {
    const result = await client.query(SENTENCE_QUERY, [forms]);
    const out: RawSentence[] = [];
    for (const row of result.rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      out.push({
        form: asString(r["form"]),
        hanzi: normalizeText(asString(r["zh"])),
        pinyin: normalizeText(asString(r["py"])),
        english: normalizeText(asString(r["en"])),
        senseIndex: asIntOrNull(r["sense"]),
        audioSource: typeof r["audio_source"] === "string" ? r["audio_source"] : null,
        sourceLevel: asIntOrNull(r["source_level"]),
        hasAudio: r["has_audio"] === true,
        hasMaster: r["has_master"] === true,
      });
    }
    return out;
  } finally {
    await client.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Canon                                                                       */
/* -------------------------------------------------------------------------- */

interface CanonEntry extends CanonRow {
  /** Every bare form this row licenses; the DB is queried on these. */
  forms: string[];
}

function readCanon(): CanonEntry[] {
  const path = `${DATA_DIR}hsk_bands.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read ${path}. Run \`npm run build:canon\` first.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} is not an array of word records.`);
  const out: CanonEntry[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = asString(r["id"]);
    const simplified = asString(r["simplified"]);
    const hsk = r["hsk"];
    const band =
      typeof hsk === "object" && hsk !== null
        ? asIntOrNull((hsk as Record<string, unknown>)["band2026"])
        : null;
    if (id === "" || simplified === "" || band === null || band < 1 || band > 7) continue;
    out.push({ id, simplified, band: band as Band, forms: lookupForms(simplified) });
  }
  if (out.length === 0) throw new Error(`${path} yielded no usable canon rows.`);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Grading and selection                                                       */
/* -------------------------------------------------------------------------- */

/** A graded sentence, before triad selection. One per distinct sentence text. */
interface Graded {
  id: string;
  hanzi: string;
  pinyin: string;
  pinyinNumbered: string | null;
  english: string;
  zsg: Band;
  charLen: number;
  words: string[];
  beyondHskTokens: number;
  newWordCount: Record<string, number>;
  hasAudio: boolean;
  tier: AudioTier;
  provenance: string | null;
  sourceLevel: number | null;
}

/** A graded sentence offered to one headword. */
interface Offer {
  graded: Graded;
  senseIndex: number | null;
}

function slotFor(zsg: Band, band: Band): TriadSlot {
  if (zsg < band) return "easy";
  if (zsg === band) return "atLevel";
  return "stretch";
}

/**
 * ── Why the triad is a spread and not three fixed slots ────────────────────
 *
 * Every sentence in this corpus contains the headword it is filed under, and
 * ZSG is band closure, so a sentence's grade is bounded below by its headword's
 * own band. Two consequences the spec's §4.2 table does not anticipate:
 *
 *   • The `easy` slot (ZSG < band) is structurally almost empty — 424 of 33,212
 *     links, and those are single-character or polyphone headwords whose form
 *     is known at a lower band or is absorbed into a longer word by the
 *     segmenter. Nothing is wrong; it is arithmetic.
 *   • 5,636 of the 11,092 canon rows are band 7, and 7 is the top of the scale,
 *     so every sentence for half the word list grades 7 exactly. On ZSG alone
 *     those headwords can never have a spread at all.
 *
 * Filling three fixed slots therefore ships one sentence for half the canon,
 * which is not "different difficulties" in any sense a learner would recognise.
 * So difficulty is ordered on a two-part key that is computed, not guessed, and
 * whose parts both ship inside every record:
 *
 *     difficulty = (zsg, newWordCount["1"])
 *
 * ZSG dominates; the count of distinct content tokens above band 1 breaks ties
 * inside a grade, which is what separates 「我很喜欢这个季度的财报。」 from a
 * dense twenty-character sentence at the same grade. Up to three sentences are
 * taken per headword: the lowest key, the highest, and the middle one. A
 * headword whose sentences all share one key ships one sentence — three
 * sentences of identical difficulty are padding, not a triad.
 *
 * Each pick still carries its true §4.2 slot label (`easy` / `atLevel` /
 * `stretch`, relative to the headword's band), so the published labels remain
 * the spec's and remain auditable against the word list.
 */
function difficultyKey(offer: Offer): number {
  return offer.graded.zsg * 100 + Math.min(99, offer.graded.newWordCount["1"] ?? 0);
}

/**
 * Lowest, highest and middle of the difficulty keys a headword actually has —
 * measured first over the keys that have a recorded clip, then topped up from
 * the rest. Only 60% of source rows carry audio, and spreading over the full
 * key set drops the shipped audio rate to roughly that; spreading over the
 * audible range first keeps it near 80% while still reporting each sentence's
 * true grade, so nothing is misstated, only preferred.
 */
function chooseKeys(byKey: ReadonlyMap<number, Offer[]>): number[] {
  const all = [...byKey.keys()].sort((a, b) => a - b);
  const audible = all.filter((k) => (byKey.get(k) ?? []).some((o) => o.graded.hasAudio));
  const chosen: number[] = [];
  const take = (key: number | undefined): void => {
    if (key !== undefined && !chosen.includes(key)) chosen.push(key);
  };
  for (const keys of [audible, all]) {
    if (keys.length === 0) continue;
    take(keys[0]);
    take(keys[keys.length - 1]);
    take(keys[Math.floor(keys.length / 2)]);
    if (chosen.length >= 3) break;
  }
  return chosen.slice(0, 3).sort((a, b) => a - b);
}

/**
 * Best sentence at one difficulty key for one headword. Every tiebreak is a
 * quality signal rather than an accident of row order: a clip the learner can
 * hear, then the most typical length for the grade — nearest the corpus median,
 * so a slot does not fill with four-character fragments — then the text itself,
 * which makes the choice independent of iteration order.
 */
function pick(offers: readonly Offer[], table: CharLengthTable): Offer | null {
  if (offers.length === 0) return null;
  const typicality = (offer: Offer): number =>
    Math.abs(offer.graded.charLen - table.median(offer.graded.zsg));
  const sorted = [...offers].sort((a, b) => {
    if (a.graded.hasAudio !== b.graded.hasAudio) return a.graded.hasAudio ? -1 : 1;
    const at = typicality(a);
    const bt = typicality(b);
    if (at !== bt) return at - bt;
    return a.graded.hanzi < b.graded.hanzi ? -1 : a.graded.hanzi > b.graded.hanzi ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

interface BuildResult {
  records: SentenceRecord[];
  stats: SentenceStats;
}

function build(canon: readonly CanonEntry[], raw: readonly RawSentence[]): BuildResult {
  const index: CanonIndex = buildCanonIndex(canon);

  const drops: Record<DropReason, number> = Object.fromEntries(
    DROP_REASONS.map((reason) => [reason, 0]),
  ) as Record<DropReason, number>;

  /** form -> distinct graded sentences offered to that form. */
  const byForm = new Map<string, Offer[]>();
  /** id -> the one graded record for that sentence text. */
  const gradedById = new Map<string, Graded>();
  /** Guards the 12-hex id truncation. */
  const textById = new Map<string, string>();
  let idCollisions = 0;
  const distinctTexts = new Set<string>();
  const seenPerForm = new Set<string>();
  let maxRawCharLen = 0;

  for (const row of raw) {
    distinctTexts.add(row.hanzi);
    maxRawCharLen = Math.max(maxRawCharLen, [...row.hanzi].length);
    const reason = rejectionReason(row, row.form);
    if (reason !== null) {
      drops[reason] += 1;
      continue;
    }
    const dupKey = `${row.form} ${row.hanzi}`;
    if (seenPerForm.has(dupKey)) {
      drops["duplicate-for-headword"] += 1;
      continue;
    }
    seenPerForm.add(dupKey);

    const id = sentenceId(row.hanzi);
    let graded = gradedById.get(id);
    if (graded === undefined) {
      const previous = textById.get(id);
      if (previous !== undefined && previous !== row.hanzi) idCollisions += 1;
      textById.set(id, row.hanzi);
      const g = grade(row.hanzi, index);
      if (g === null) {
        drops["no-content-token"] += 1;
        continue;
      }
      graded = {
        id,
        hanzi: row.hanzi,
        pinyin: row.pinyin,
        pinyinNumbered: markedToNumbered(row.pinyin),
        english: row.english,
        zsg: g.zsg,
        charLen: g.charLen,
        words: g.words,
        beyondHskTokens: g.beyondHskTokens,
        newWordCount: g.newWordCount,
        hasAudio: row.hasAudio,
        tier: row.hasAudio ? (row.hasMaster ? "two-speed" : "slow-only") : "none",
        provenance: row.audioSource,
        sourceLevel: row.sourceLevel,
      };
      gradedById.set(id, graded);
    } else if (row.hasAudio && !graded.hasAudio) {
      // The same text can appear under several headwords with different audio
      // rows attached. Availability is a property of the text, so take the best.
      graded.hasAudio = true;
      graded.tier = row.hasMaster ? "two-speed" : "slow-only";
      graded.provenance = row.audioSource;
    }
    const offers = byForm.get(row.form);
    if (offers === undefined) byForm.set(row.form, [{ graded, senseIndex: row.senseIndex }]);
    else offers.push({ graded, senseIndex: row.senseIndex });
  }

  // ── length distribution ──────────────────────────────────────────────────
  // Measured over every graded sentence, not the shipped subset: the shipped
  // subset is chosen partly on length, so a percentile against it would be
  // measuring this build's own selection rule rather than the corpus.
  const table = new CharLengthTable(
    [...gradedById.values()].map((g) => ({ band: g.zsg, charLen: g.charLen })),
  );

  // ── selection ────────────────────────────────────────────────────────────
  const links = new Map<string, HeadwordLink[]>();
  const slotDistribution: Record<TriadSlot, number> = { easy: 0, atLevel: 0, stretch: 0 };
  const triadFullness: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  const selectedIds = new Set<string>();

  for (const word of [...canon].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const byKey = new Map<number, Offer[]>();
    const seen = new Set<string>();
    for (const form of word.forms) {
      for (const offer of byForm.get(form) ?? []) {
        if (seen.has(offer.graded.id)) continue;
        seen.add(offer.graded.id);
        const key = difficultyKey(offer);
        const bucket = byKey.get(key);
        if (bucket === undefined) byKey.set(key, [offer]);
        else bucket.push(offer);
      }
    }

    let filled = 0;
    for (const key of chooseKeys(byKey)) {
      const chosen = pick(byKey.get(key) ?? [], table);
      if (chosen === null) continue;
      const slot = slotFor(chosen.graded.zsg, word.band);
      filled += 1;
      slotDistribution[slot] += 1;
      selectedIds.add(chosen.graded.id);
      const link: HeadwordLink = {
        wordId: word.id,
        simplified: word.simplified,
        band: word.band,
        slot,
        senseIndex: chosen.senseIndex,
      };
      const list = links.get(chosen.graded.id);
      if (list === undefined) links.set(chosen.graded.id, [link]);
      else list.push(link);
    }
    triadFullness[String(filled)] = (triadFullness[String(filled)] ?? 0) + 1;
  }

  const selected = [...selectedIds]
    .map((id) => gradedById.get(id))
    .filter((g): g is Graded => g !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const records: SentenceRecord[] = selected.map((g) => ({
    id: g.id,
    hanzi: g.hanzi,
    pinyin: g.pinyin,
    pinyinNumbered: g.pinyinNumbered,
    english: g.english,
    zsg: g.zsg,
    bandClosure: g.zsg,
    charLen: g.charLen,
    charLengthPercentile: { band: g.zsg, pct: table.percentile(g.zsg, g.charLen) },
    newWordCount: g.newWordCount,
    words: g.words,
    beyondHskTokens: g.beyondHskTokens,
    audio: { available: g.hasAudio, tier: g.tier, provenance: g.provenance },
    source: { corpus: "example_json", license: "SayMei" },
    headwords: (links.get(g.id) ?? []).sort((a, b) =>
      a.wordId < b.wordId ? -1 : a.wordId > b.wordId ? 1 : 0,
    ),
  }));

  // ── stats ────────────────────────────────────────────────────────────────
  const zero = (): Record<string, number> =>
    Object.fromEntries(BANDS.map((b) => [String(b), 0])) as Record<string, number>;

  const bump = (into: Record<string, number>, band: Band): void => {
    into[String(band)] = (into[String(band)] ?? 0) + 1;
  };
  const gradedDistribution = zero();
  for (const g of gradedById.values()) bump(gradedDistribution, g.zsg);
  const selectedDistribution = zero();
  for (const g of selected) bump(selectedDistribution, g.zsg);

  const gradedForms = new Set<string>();
  for (const [form, offers] of byForm) if (offers.length > 0) gradedForms.add(form);
  const rowsWithAnOffer = canon.filter((w) => w.forms.some((f) => gradedForms.has(f))).length;
  const headwordsCovered = new Set<string>();
  const simplifiedCovered = new Set<string>();
  for (const list of links.values()) {
    for (const link of list) {
      headwordsCovered.add(link.wordId);
      simplifiedCovered.add(link.simplified);
    }
  }
  const canonSimplified = new Set(canon.map((w) => w.simplified));

  const audioTier: Record<AudioTier, number> = { "two-speed": 0, "slow-only": 0, none: 0 };
  let withAudio = 0;
  let withPinyinNumbered = 0;
  for (const g of selected) {
    audioTier[g.tier] += 1;
    if (g.hasAudio) withAudio += 1;
    if (g.pinyinNumbered !== null) withPinyinNumbered += 1;
  }
  let withSenseIndex = 0;
  let totalLinks = 0;
  let attested = 0;
  const wordsById = new Map(selected.map((g) => [g.id, new Set(g.words)]));
  for (const [id, list] of links) {
    for (const link of list) {
      totalLinks += 1;
      if (link.senseIndex !== null) withSenseIndex += 1;
      if (wordsById.get(id)?.has(link.simplified) === true) attested += 1;
    }
  }

  let compared = 0;
  let exact = 0;
  let within1 = 0;
  for (const g of selected) {
    if (g.sourceLevel === null || g.sourceLevel < 1 || g.sourceLevel > 7) continue;
    compared += 1;
    if (g.sourceLevel === g.zsg) exact += 1;
    if (Math.abs(g.sourceLevel - g.zsg) <= 1) within1 += 1;
  }

  const canonForms = new Set<string>();
  for (const word of canon) for (const form of word.forms) canonForms.add(form);

  const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 10000) / 100);

  const stats: SentenceStats = {
    schema: "zhongdex/sentence-stats/v1",
    generator: GENERATOR,
    source: {
      corpus: "example_json",
      table: "global_dictionary",
      column: "example_sentences_json",
      note:
        "Chosen over example_sentences + entry_sentences: that pairing is 95% Tatoeba, " +
        "largely traditional script, numbered pinyin only, and its links are substring " +
        "matches rather than sense alignment. See the header of " +
        GENERATOR +
        " for the full comparison.",
      license: "SayMei production data; sentences are SayMei-owned, not CC-CEDICT.",
    },
    grading: {
      definition:
        "ZSG = the highest HSK 3.0 (2026) band of any content token after segmentation, " +
        "clamped to 1-7. Computed from the canon word list plus the sentence text; no model, " +
        "no copied grade.",
      segmenter:
        "Forward maximum matching over the canon's own simplified forms. Unmatched single " +
        "characters take the lowest band of any canon word containing them.",
      beyondHsk:
        "A character no canon word contains is outside HSK 3.0; it forces the grade to 7 and " +
        "is counted in beyondHskTokens.",
      newWordCount:
        "Per band prefix 1..7, the count of DISTINCT content token forms outside that prefix. " +
        "A value of 1 is an i+1 sentence. Tokens outside HSK 3.0 count against every prefix, " +
        "including 7.",
      selection:
        "Up to 3 per headword, spread over the difficulty key (zsg, " +
        "newWordCount[\"1\"]): lowest, highest, middle. Both parts ship in every " +
        "record. A headword with one distinct key ships one sentence.",
      charLengthPercentile:
        "Mid-rank percentile of the sentence's character count against every GRADED sentence " +
        "of the same ZSG band — the full pool, not the shipped subset, which is chosen partly " +
        "on length. Measured on this corpus rather than imported from the dialogue corpus.",
    },
    input: {
      canonRows: canon.length,
      canonDistinctForms: canonForms.size,
      canonFormsFoundInSource: gradedForms.size,
      rawSentenceRows: raw.length,
      distinctRawTexts: distinctTexts.size,
      maxRawCharLen: maxRawCharLen,
    },
    drops: {
      total: DROP_REASONS.reduce((sum, reason) => sum + drops[reason], 0),
      byReason: drops,
    },
    graded: {
      distinctSentences: gradedById.size,
      headwordsWithAtLeastOne: rowsWithAnOffer,
      gradeDistribution: gradedDistribution,
    },
    selected: {
      totalSentences: records.length,
      totalLinks,
      headwordsCovered: headwordsCovered.size,
      coveragePctOfCanonRows: pct(headwordsCovered.size, canon.length),
      coveragePctOfCanonForms: pct(simplifiedCovered.size, canonSimplified.size),
      gradeDistribution: selectedDistribution,
      slotDistribution,
      triadFullness,
      withAudio,
      withAudioPct: pct(withAudio, records.length),
      audioTier,
      withPinyinNumbered,
      withSenseIndex,
      headwordAttestedAsToken: attested,
      headwordAttestedAsTokenPct: pct(attested, totalLinks),
      charLenPercentileTable: table.summary(),
    },
    sourceHskLevelAgreement: {
      note:
        "The source rows carry their own hskLevel. It is never trusted, only compared: this " +
        "is a check on the computed grade, not an input to it.",
      compared,
      exact,
      within1,
    },
    idCollisions,
  };

  return { records, stats };
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

function toJsonl(records: readonly SentenceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}

async function main(): Promise<void> {
  const canon = readCanon();
  const forms = [...new Set(canon.flatMap((w) => w.forms))].sort();
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  log(`sentences: ${canon.length} canon rows -> ${forms.length} lookup forms`);

  const raw = await fetchSentences(forms);
  const digest = createHash("sha256")
    .update(raw.map((r) => `${r.form} ${r.hanzi}`).join("\n"), "utf8")
    .digest("hex");
  log(`sentences: read ${raw.length} source rows (extraction sha256 ${digest.slice(0, 16)})`);

  const { records, stats } = build(canon, raw);
  if (stats.idCollisions > 0) {
    throw new Error(
      `${stats.idCollisions} sentence id collisions at 12 hex digits. Widen sentenceId().`,
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}sentences.jsonl`, toJsonl(records));
  writeFileSync(`${DATA_DIR}sentence-stats.json`, `${JSON.stringify(stats, null, 2)}\n`);

  const grades = BANDS.map((b) => `${b}=${stats.selected.gradeDistribution[String(b)] ?? 0}`).join(" ");
  log(
    `sentences: graded ${stats.graded.distinctSentences} distinct, dropped ${stats.drops.total}` +
      ` (${DROP_REASONS.filter((r) => stats.drops.byReason[r] > 0)
        .map((r) => `${r}=${stats.drops.byReason[r]}`)
        .join(" ")})`,
  );
  log(
    `sentences: shipped ${stats.selected.totalSentences} sentences,` +
      ` ${stats.selected.totalLinks} headword links,` +
      ` ${stats.selected.headwordsCovered}/${canon.length} headwords` +
      ` (${stats.selected.coveragePctOfCanonRows}%)`,
  );
  log(`sentences: grades ${grades}`);
  log(
    `sentences: audio available on ${stats.selected.withAudio}` +
      ` (${stats.selected.withAudioPct}%), tiers` +
      ` two-speed=${stats.selected.audioTier["two-speed"]}` +
      ` slow-only=${stats.selected.audioTier["slow-only"]}`,
  );
  log(`sentences: wrote data/sentences.jsonl, data/sentence-stats.json`);
}

await main();
