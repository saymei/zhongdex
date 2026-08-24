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
  type SentenceQualityMeasurement,
  type SentenceQualityRecord,
  type SentenceRecord,
  type SentenceStats,
  type TriadSlot,
} from "./sentence-schema.js";
import {
  EXCLUSION_RULES,
  excludedBy,
  maskedFrame,
  maximalTokens,
  readCedictForms,
  riskWeightOf,
  type CandidateLink,
  type CedictForms,
} from "./quality.js";
import type { Band } from "./types.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const DATA_DIR = fileURLToPath(new URL("data/", REPO_ROOT));
const GENERATOR = "src/build/sentences.ts";
/** The vendored CC-CEDICT dump `build:canon` already reads. Never edited here. */
const CEDICT_JSON = process.env["ZHONGDEX_CEDICT"] ?? fileURLToPath(new URL("scripts/cedict.json", REPO_ROOT));

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
  /** The canon's own numbered pinyin, for the reading check in `quality.ts`. */
  pinyinNumbered: string;
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
    const pinyin = r["pinyin"];
    const pinyinNumbered =
      typeof pinyin === "object" && pinyin !== null
        ? asString((pinyin as Record<string, unknown>)["numbered"])
        : "";
    out.push({ id, simplified, band: band as Band, forms: lookupForms(simplified), pinyinNumbered });
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
  /**
   * The same sentence segmented against CC-CEDICT rather than the canon. Held
   * per sentence, not per link, because it does not depend on the headword.
   */
  cedictTokens: Set<string>;
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
function chooseKeys(byKey: ReadonlyMap<number, Candidate[]>): number[] {
  const all = [...byKey.keys()].sort((a, b) => a - b);
  const audible = all.filter((k) => (byKey.get(k) ?? []).some((c) => c.offer.graded.hasAudio));
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
 * quality signal rather than an accident of row order: least quality risk
 * first, then a clip the learner can hear, then the most typical length
 * for the grade — nearest the corpus median, so a slot does not fill with
 * four-character fragments — then the text itself, which makes the choice
 * independent of iteration order.
 *
 * The risk weight leads because the pools below are already filtered on the
 * rules; it decides only inside a fallback pool, where every candidate is
 * flagged and the job is to keep the least-bad one.
 */
function pick(candidates: readonly Candidate[], table: CharLengthTable): Candidate | null {
  if (candidates.length === 0) return null;
  const typicality = (c: Candidate): number =>
    Math.abs(c.offer.graded.charLen - table.median(c.offer.graded.zsg));
  const sorted = [...candidates].sort((a, b) => {
    if (a.risk !== b.risk) return a.risk - b.risk;
    if (a.hits.length !== b.hits.length) return a.hits.length - b.hits.length;
    if (a.offer.graded.hasAudio !== b.offer.graded.hasAudio) return a.offer.graded.hasAudio ? -1 : 1;
    const at = typicality(a);
    const bt = typicality(b);
    if (at !== bt) return at - bt;
    const x = a.offer.graded.hanzi;
    const y = b.offer.graded.hanzi;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The quality gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ── Why the filter runs here and not afterwards ────────────────────────────
 *
 * A judged sample of 600 headword links put the shipped corpus at 12.85% broken
 * (95% CI 10.08-15.63%), and the failure is not the sentences: `grammatical`
 * fails on 6.5% of them. It is the *link* — a well-formed sentence in which the
 * headword is buried inside a compound, invented as a surname, or read as a
 * different word. See `src/build/quality.ts` for every rule and its evidence,
 * and `data/quality-report.json` for the measurement they were derived from.
 *
 * Filtering a shipped corpus can only delete. Filtering during selection can
 * *choose*, and the difference is the whole point: the build grades 137,541
 * distinct sentences and ships around 30,000 of them, so for most headwords a
 * flagged sentence has a clean sibling sitting in the pool unused. Three tiers,
 * tried in order, and coverage cannot move because the last one accepts
 * anything:
 *
 *   1. candidates that break no rule at all;
 *   2. if none, candidates that break no hard rule;
 *   3. if none, every candidate — and then only the single least-flagged one,
 *      because a headword's last sentence is worth more than the rule.
 *
 * Single-character headwords are capped at one sentence in tiers 1 and 2. They
 * are 42.78% broken in the measurement against a 12.85% base rate, at every
 * band, and they are the reason the recommended policy in the quality report
 * drops them down to a single link. This build keeps that decision and improves
 * on it: the one link kept is the best of the pool rather than whichever
 * survived.
 */
const HARD_RULE_IDS = new Set(EXCLUSION_RULES.filter((r) => r.tier === "hard").map((r) => r.id));

/** One (sentence, headword) pair, scored against the gate. */
interface Candidate {
  offer: Offer;
  slot: TriadSlot;
  key: number;
  /** Rule ids this candidate breaks, in `EXCLUSION_RULES` order. */
  hits: string[];
  hardHits: number;
  softHits: number;
  /** Weighted severity of `hits`. Only breaks ties inside a fallback pool. */
  risk: number;
}

/** The first form of this headword that actually occurs in the sentence. */
function matchedForm(word: CanonEntry, hanzi: string): string | null {
  return word.forms.find((form) => hanzi.includes(form)) ?? null;
}

/**
 * Which canon headwords share each masked sentence frame. Counted over every
 * candidate link in the pool, not over the shipped subset, so a template is
 * recognised by how the source used it rather than by what this build kept.
 */
function frameIndex(
  canon: readonly CanonEntry[],
  byForm: ReadonlyMap<string, Offer[]>,
): Map<string, Set<string>> {
  const frames = new Map<string, Set<string>>();
  for (const word of canon) {
    const seen = new Set<string>();
    for (const form of word.forms) {
      for (const offer of byForm.get(form) ?? []) {
        if (seen.has(offer.graded.id)) continue;
        seen.add(offer.graded.id);
        const matched = matchedForm(word, offer.graded.hanzi);
        if (matched === null) continue;
        const frame = maskedFrame(offer.graded.hanzi, matched);
        const holders = frames.get(frame);
        if (holders === undefined) frames.set(frame, new Set([word.id]));
        else holders.add(word.id);
      }
    }
  }
  return frames;
}

function candidateFor(
  word: CanonEntry,
  offer: Offer,
  table: CharLengthTable,
  frames: ReadonlyMap<string, Set<string>>,
): Candidate | null {
  const matched = matchedForm(word, offer.graded.hanzi);
  if (matched === null) return null;
  const slot = slotFor(offer.graded.zsg, word.band);
  const link: CandidateLink = {
    hanzi: offer.graded.hanzi,
    pinyinNumbered: offer.graded.pinyinNumbered,
    headword: matched,
    headwordPinyinNumbered: word.pinyinNumbered,
    words: offer.graded.words,
    cedictTokens: offer.graded.cedictTokens,
    slot,
    charLengthPercentilePct: table.percentile(offer.graded.zsg, offer.graded.charLen),
    frameHeadwordCount: frames.get(maskedFrame(offer.graded.hanzi, matched))?.size ?? 1,
  };
  const hits = excludedBy(link);
  let hardHits = 0;
  for (const id of hits) if (HARD_RULE_IDS.has(id)) hardHits += 1;
  return {
    offer,
    slot,
    key: difficultyKey(offer),
    hits,
    hardHits,
    softHits: hits.length - hardHits,
    risk: riskWeightOf(hits),
  };
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

interface BuildResult {
  records: SentenceRecord[];
  stats: SentenceStats;
}

function build(
  canon: readonly CanonEntry[],
  raw: readonly RawSentence[],
  cedict: CedictForms,
): BuildResult {
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
        cedictTokens: maximalTokens(row.hanzi, cedict.forms, cedict.maxFormLength),
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
  const frames = frameIndex(canon, byForm);
  const links = new Map<string, HeadwordLink[]>();
  const slotDistribution: Record<TriadSlot, number> = { easy: 0, atLevel: 0, stretch: 0 };
  const triadFullness: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  const selectedIds = new Set<string>();

  const flaggedCandidates: Record<string, number> = {};
  const flaggedSelected: Record<string, number> = {};
  for (const rule of EXCLUSION_RULES) {
    flaggedCandidates[rule.id] = 0;
    flaggedSelected[rule.id] = 0;
  }
  const pools = { clean: 0, softFallback: 0, lastLinkFallback: 0, none: 0 };
  let candidateLinks = 0;
  let singleCharCapped = 0;

  for (const word of [...canon].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const form of word.forms) {
      for (const offer of byForm.get(form) ?? []) {
        if (seen.has(offer.graded.id)) continue;
        seen.add(offer.graded.id);
        const candidate = candidateFor(word, offer, table, frames);
        if (candidate === null) continue;
        candidates.push(candidate);
        candidateLinks += 1;
        for (const id of candidate.hits) flaggedCandidates[id] = (flaggedCandidates[id] ?? 0) + 1;
      }
    }

    // Three pools, in order. The last one accepts every candidate, so a
    // headword with any sentence at all keeps one and coverage cannot move.
    const hardClean = candidates.filter((c) => c.hardHits === 0);
    const clean = hardClean.filter((c) => c.softHits === 0);
    const singleChar = [...word.simplified].length === 1;
    let pool: Candidate[];
    let limit: number;
    if (clean.length > 0) {
      pool = clean;
      limit = singleChar ? 1 : 3;
      pools.clean += 1;
    } else if (hardClean.length > 0) {
      pool = hardClean;
      limit = singleChar ? 1 : 3;
      pools.softFallback += 1;
    } else if (candidates.length > 0) {
      pool = candidates;
      limit = 1;
      pools.lastLinkFallback += 1;
    } else {
      pool = [];
      limit = 0;
      pools.none += 1;
    }
    if (singleChar && limit === 1 && pool.length > 1) singleCharCapped += 1;

    const chosen: Candidate[] = [];
    if (limit === 1) {
      const best = pick(pool, table);
      if (best !== null) chosen.push(best);
    } else {
      const byKey = new Map<number, Candidate[]>();
      for (const candidate of pool) {
        const bucket = byKey.get(candidate.key);
        if (bucket === undefined) byKey.set(candidate.key, [candidate]);
        else bucket.push(candidate);
      }
      for (const key of chooseKeys(byKey)) {
        const best = pick(byKey.get(key) ?? [], table);
        if (best !== null) chosen.push(best);
      }
    }

    for (const candidate of chosen) {
      slotDistribution[candidate.slot] += 1;
      selectedIds.add(candidate.offer.graded.id);
      for (const id of candidate.hits) flaggedSelected[id] = (flaggedSelected[id] ?? 0) + 1;
      const link: HeadwordLink = {
        wordId: word.id,
        simplified: word.simplified,
        band: word.band,
        slot: candidate.slot,
        senseIndex: candidate.offer.senseIndex,
      };
      const list = links.get(candidate.offer.graded.id);
      if (list === undefined) links.set(candidate.offer.graded.id, [link]);
      else list.push(link);
    }
    triadFullness[String(chosen.length)] = (triadFullness[String(chosen.length)] ?? 0) + 1;
  }

  const quality: SentenceQualityRecord = {
    note:
      "Applied during selection, not afterwards: every rule below decides which of a " +
      "headword's candidate sentences ship, and data/sentences.jsonl is already the " +
      "filtered corpus. The rules and their evidence live in src/build/quality.ts; the " +
      "judged measurement they were derived from is data/quality-report.json.",
    generator: "src/build/quality.ts",
    candidateLinks,
    rules: EXCLUSION_RULES.map((rule) => ({
      id: rule.id,
      tier: rule.tier,
      rule: rule.rule,
      evidence: rule.evidence,
      candidateLinksFlagged: flaggedCandidates[rule.id] ?? 0,
      selectedLinksFlagged: flaggedSelected[rule.id] ?? 0,
    })),
    selection: {
      note:
        "Pools are tried in order — clean, then hard-clean, then everything — and the " +
        "last pool ships exactly one sentence, so no rule can take a headword's last " +
        "link. A selected link carrying a flag is a headword whose whole pool carried it.",
      headwordsByPool: pools,
      singleCharHeadwordsCappedToOne: singleCharCapped,
    },
  };

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
        "Candidates are filtered by the quality gate (see `quality` below), then up to 3 " +
        "per headword are spread over the difficulty key (zsg, newWordCount[\"1\"]): " +
        "lowest, highest, middle. Both parts ship in every record. A headword with one " +
        "distinct key ships one sentence; a single-character headword ships one sentence " +
        "by rule; a headword whose every candidate is flagged ships its least-flagged one.",
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
    quality,
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

/**
 * A measurement of the corpus this build is about to replace, kept only if the
 * corpus it describes is byte-identical to the one being written. A judged
 * defect rate belongs to one exact corpus; carrying it across a rebuild that
 * changed the data would be a number describing sentences that are no longer
 * there. Written by `npx tsx src/build/quality.ts --remeasure`.
 */
function carriedMeasurement(jsonl: string): SentenceQualityMeasurement | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${DATA_DIR}sentence-stats.json`, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const measured = (parsed as Record<string, unknown>)["measuredQuality"];
  if (typeof measured !== "object" || measured === null) return undefined;
  const digest = (measured as Record<string, unknown>)["corpusSha256"];
  const actual = createHash("sha256").update(jsonl, "utf8").digest("hex");
  return digest === actual ? (measured as SentenceQualityMeasurement) : undefined;
}

async function main(): Promise<void> {
  const canon = readCanon();
  const cedict = readCedictForms(CEDICT_JSON);
  const forms = [...new Set(canon.flatMap((w) => w.forms))].sort();
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  log(`sentences: ${canon.length} canon rows -> ${forms.length} lookup forms`);
  log(`sentences: ${cedict.forms.size} CC-CEDICT compound forms for the buriedness check`);

  const raw = await fetchSentences(forms);
  const digest = createHash("sha256")
    .update(raw.map((r) => `${r.form} ${r.hanzi}`).join("\n"), "utf8")
    .digest("hex");
  log(`sentences: read ${raw.length} source rows (extraction sha256 ${digest.slice(0, 16)})`);

  const { records, stats } = build(canon, raw, cedict);
  const jsonl = toJsonl(records);
  // A measurement describes one exact corpus, so it survives a rebuild only if
  // the rebuild produced that corpus. Otherwise it is dropped, not carried.
  const measured = carriedMeasurement(jsonl);
  if (measured !== undefined) stats.measuredQuality = measured;
  if (stats.idCollisions > 0) {
    throw new Error(
      `${stats.idCollisions} sentence id collisions at 12 hex digits. Widen sentenceId().`,
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}sentences.jsonl`, jsonl);
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
