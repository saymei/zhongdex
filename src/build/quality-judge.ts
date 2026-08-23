/**
 * Zhongdex sentence corpus — LLM quality judge.
 *
 * The corpus is source data from a production dictionary, not generated here,
 * and no computable gate catches its real failure mode: a real word forced into
 * a frame it does not fit. `他不好的，见钱眼开。` is ungrammatical, `室先生住在
 * 北京。` invents a surname, `这次难很大。` uses an adjective as a noun. Every
 * one of them passes `grade.ts`'s gates, because every one of them is made of
 * canon words in a plausible-looking order.
 *
 * So the defect rate has to be *measured*, and the only instrument that can
 * measure it is a model that reads Mandarin. This file is that instrument:
 *
 *   1. It draws a **stratified random sample** of headword links, stratified on
 *      the two axes the failures are known to cluster on — the HSK band of the
 *      headword and the headword's character length.
 *   2. It asks an LLM four questions per link (grammatical / semantically
 *      sensible / headword used naturally / a native would write it), plus a
 *      three-way verdict and a one-line reason.
 *   3. It publishes **per-stratum** rates with n and a confidence interval, and
 *      a properly weighted corpus-wide estimate. Never one aggregate: the whole
 *      point of the exercise is that band 7 is not band 1.
 *
 * Three rules this file exists to keep honest:
 *
 * - **Deterministic sampling.** The seed is an input and is recorded in the
 *   output. Same corpus + same seed = same 600 links, so anybody can re-judge
 *   exactly what we judged and argue with the labels rather than the draw.
 * - **No model, no number.** If no API key is reachable the tool exits non-zero
 *   and writes nothing. A fabricated quality measurement is worse than none.
 * - **Not part of `npm run build`.** The build is offline and reproducible;
 *   this makes network calls and costs money. It is an audit you run by hand,
 *   and its output is a report, not a corpus input.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx src/build/quality-judge.ts [--n 600] [--seed ...]
 *                                [--model ...] [--concurrency 8] [--gold-only]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import type { Band } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Paths and defaults                                                          */
/* -------------------------------------------------------------------------- */

const DATA_DIR = "data/";
const SENTENCES_JSONL = `${DATA_DIR}sentences.jsonl`;
const CANON_JSON = `${DATA_DIR}hsk_bands.json`;
export const QUALITY_REPORT_JSON = `${DATA_DIR}quality-report.json`;

/** Recorded in the report. Changing it changes which links are drawn. */
const DEFAULT_SEED = "zhongdex-quality-v1";
const DEFAULT_SAMPLE_SIZE = 600;
/** Every stratum gets at least this many, so no stratum is unmeasurable. */
const DEFAULT_STRATUM_FLOOR = 40;
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_CONCURRENCY = 8;
const GENERATIVE_LANGUAGE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/* -------------------------------------------------------------------------- */
/* Corpus shapes (the subset this tool reads)                                  */
/* -------------------------------------------------------------------------- */

export interface CorpusHeadword {
  wordId: string;
  simplified: string;
  band: Band;
  slot: string;
}

export interface CorpusSentence {
  id: string;
  hanzi: string;
  pinyin: string;
  english: string;
  zsg: Band;
  charLen: number;
  words: string[];
  beyondHskTokens: number;
  charLengthPercentile: { band: Band; pct: number };
  headwords: CorpusHeadword[];
}

export interface CanonWord {
  id: string;
  simplified: string;
  pinyin: { marked: string };
  pos: string[];
  definitions: { text: string }[];
  zipf: number | null;
}

/** One (sentence, headword) pair. The judged unit: naturalness is per-use. */
export interface Link {
  linkId: string;
  sentenceId: string;
  wordId: string;
  headword: string;
  headwordBand: Band;
  headwordCharLen: number;
  headwordPinyin: string;
  headwordPos: string;
  headwordGlosses: string[];
  hanzi: string;
  pinyin: string;
  english: string;
  zsg: Band;
  charLen: number;
  stratum: string;
}

/* -------------------------------------------------------------------------- */
/* Strata                                                                      */
/* -------------------------------------------------------------------------- */

export type BandGroup = "1-3" | "4-6" | "7";
export type LenGroup = "1" | "2" | "3+";

export const BAND_GROUPS: readonly BandGroup[] = ["1-3", "4-6", "7"];
export const LEN_GROUPS: readonly LenGroup[] = ["1", "2", "3+"];

export function bandGroupOf(band: Band): BandGroup {
  if (band >= 7) return "7";
  if (band >= 4) return "4-6";
  return "1-3";
}

export function lenGroupOf(charLen: number): LenGroup {
  if (charLen <= 1) return "1";
  if (charLen === 2) return "2";
  return "3+";
}

export function stratumOf(band: Band, headwordCharLen: number): string {
  return `b${bandGroupOf(band)}-len${lenGroupOf(headwordCharLen)}`;
}

/** All nine strata, in a fixed order, so the report is stable. */
export const STRATA: readonly string[] = BAND_GROUPS.flatMap((b) =>
  LEN_GROUPS.map((l) => `b${b}-len${l}`),
);

/* -------------------------------------------------------------------------- */
/* Deterministic RNG                                                           */
/* -------------------------------------------------------------------------- */

/** 32-bit seed from an arbitrary string, via sha256. Stable across hosts. */
function seedFrom(text: string): number {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return digest.readUInt32BE(0);
}

/** mulberry32. Small, fast, and identical on every platform. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy. The input must already be in a canonical order. */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

export interface Interval {
  low: number;
  high: number;
}

const Z_95 = 1.959963984540054;

/**
 * Wilson score interval. Chosen over the normal approximation because half the
 * strata here will have small n and rates near zero, where the normal interval
 * runs below 0 and lies about the coverage.
 */
export function wilson(successes: number, n: number, z: number = Z_95): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Rule of three: with zero defects in n draws, the 95% upper bound on the rate
 * is about 3/n. Reported alongside Wilson wherever a stratum comes back clean,
 * because "0%" on its own is a claim the sample cannot support.
 */
export function ruleOfThree(n: number): number {
  return n === 0 ? 1 : 3 / n;
}

export interface StratumTally {
  stratum: string;
  bandGroup: BandGroup;
  lenGroup: LenGroup;
  population: number;
  weight: number;
  n: number;
  broken: number;
  awkward: number;
  good: number;
  brokenRate: number;
  brokenCi95: Interval;
  /** Non-null only when `broken` is 0. 95% upper bound from the rule of three. */
  brokenUpperBoundRuleOfThree: number | null;
  notCleanRate: number;
  notCleanCi95: Interval;
}

/**
 * Stratified estimate of a corpus-wide rate: sum of stratum rates weighted by
 * population share, with the finite-population correction applied per stratum.
 * A simple mean of the sample would over-weight the small strata, which we
 * deliberately over-sampled, and report a number nobody should believe.
 */
export function stratifiedEstimate(
  tallies: ReadonlyArray<{ population: number; n: number; successes: number }>,
): { estimate: number; standardError: number; ci95: Interval } {
  let total = 0;
  for (const t of tallies) total += t.population;
  if (total === 0) return { estimate: 0, standardError: 0, ci95: { low: 0, high: 0 } };

  let estimate = 0;
  let variance = 0;
  for (const t of tallies) {
    if (t.n === 0) continue;
    const w = t.population / total;
    const p = t.successes / t.n;
    estimate += w * p;
    // Wilson-adjusted p for the variance term keeps a zero-defect stratum from
    // contributing exactly zero uncertainty.
    const padj = (t.successes + 2) / (t.n + 4);
    const fpc = t.population > 1 ? Math.max(0, 1 - (t.n - 1) / (t.population - 1)) : 0;
    variance += w * w * ((padj * (1 - padj)) / t.n) * fpc;
  }
  const standardError = Math.sqrt(variance);
  return {
    estimate,
    standardError,
    ci95: {
      low: Math.max(0, estimate - Z_95 * standardError),
      high: Math.min(1, estimate + Z_95 * standardError),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                    */
/* -------------------------------------------------------------------------- */

export function readCorpus(path: string = SENTENCES_JSONL): CorpusSentence[] {
  const text = readFileSync(path, "utf8");
  const out: CorpusSentence[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as CorpusSentence);
  }
  return out;
}

export function readCanon(path: string = CANON_JSON): Map<string, CanonWord> {
  const rows = JSON.parse(readFileSync(path, "utf8")) as CanonWord[];
  const byId = new Map<string, CanonWord>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

export function buildLinks(
  corpus: readonly CorpusSentence[],
  canon: ReadonlyMap<string, CanonWord>,
): Link[] {
  const links: Link[] = [];
  for (const s of corpus) {
    for (const h of s.headwords) {
      const word = canon.get(h.wordId);
      links.push({
        linkId: `${s.id}|${h.wordId}`,
        sentenceId: s.id,
        wordId: h.wordId,
        headword: h.simplified,
        headwordBand: h.band,
        headwordCharLen: [...h.simplified].length,
        headwordPinyin: word?.pinyin.marked ?? "",
        headwordPos: word?.pos[0] ?? "",
        headwordGlosses: (word?.definitions ?? []).slice(0, 4).map((d) => d.text),
        hanzi: s.hanzi,
        pinyin: s.pinyin,
        english: s.english,
        zsg: s.zsg,
        charLen: s.charLen,
        stratum: stratumOf(h.band, [...h.simplified].length),
      });
    }
  }
  // Canonical order before any shuffle, so the draw depends on the seed alone.
  links.sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  return links;
}

export interface Allocation {
  stratum: string;
  population: number;
  n: number;
}

/**
 * Floor-plus-proportional allocation, settled by largest remainder.
 *
 * Neither pure design works here. Proportional allocation puts six links in
 * `b1-3-len3+` and measures nothing about it; equal allocation over-samples the
 * rare strata so hard that the weighted corpus estimate loses precision. A
 * floor of 40 makes every stratum individually reportable, and the remainder
 * goes proportional so the big strata — band 7 above all — carry the corpus
 * estimate.
 */
export function allocate(
  populations: ReadonlyMap<string, number>,
  total: number,
  floor: number,
): Allocation[] {
  const strata = STRATA.filter((s) => (populations.get(s) ?? 0) > 0);
  const alloc = new Map<string, number>();
  let assigned = 0;
  for (const s of strata) {
    const n = Math.min(floor, populations.get(s) ?? 0);
    alloc.set(s, n);
    assigned += n;
  }
  const remainder = Math.max(0, total - assigned);
  let popTotal = 0;
  for (const s of strata) popTotal += populations.get(s) ?? 0;

  const shares = strata.map((s) => {
    const pop = populations.get(s) ?? 0;
    const exact = popTotal === 0 ? 0 : (remainder * pop) / popTotal;
    return { stratum: s, exact, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let handed = 0;
  for (const s of shares) handed += s.whole;
  const bySlack = shares
    .slice()
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.stratum < b.stratum ? -1 : 1));
  let i = 0;
  while (handed < remainder && bySlack.length > 0) {
    const pick = bySlack[i % bySlack.length];
    if (pick !== undefined) {
      pick.whole += 1;
      handed += 1;
    }
    i += 1;
  }
  for (const s of shares) {
    const cap = populations.get(s.stratum) ?? 0;
    const want = (alloc.get(s.stratum) ?? 0) + s.whole;
    alloc.set(s.stratum, Math.min(cap, want));
  }
  return STRATA.filter((s) => (populations.get(s) ?? 0) > 0).map((s) => ({
    stratum: s,
    population: populations.get(s) ?? 0,
    n: alloc.get(s) ?? 0,
  }));
}

export interface Sample {
  seed: string;
  seedInt: number;
  allocations: Allocation[];
  links: Link[];
}

export function drawSample(
  links: readonly Link[],
  total: number,
  floor: number,
  seed: string,
): Sample {
  const byStratum = new Map<string, Link[]>();
  for (const link of links) {
    const bucket = byStratum.get(link.stratum);
    if (bucket === undefined) byStratum.set(link.stratum, [link]);
    else bucket.push(link);
  }
  const populations = new Map<string, number>();
  for (const [stratum, bucket] of byStratum) populations.set(stratum, bucket.length);

  const allocations = allocate(populations, total, floor);
  const seedInt = seedFrom(seed);
  const drawn: Link[] = [];
  for (const a of allocations) {
    const bucket = byStratum.get(a.stratum) ?? [];
    // One RNG stream per stratum, seeded from seed+stratum, so changing the
    // size of one stratum cannot re-roll the others.
    const rng = mulberry32(seedFrom(`${seed}:${a.stratum}`));
    for (const link of shuffled(bucket, rng).slice(0, a.n)) drawn.push(link);
  }
  drawn.sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  return { seed, seedInt, allocations, links: drawn };
}

/* -------------------------------------------------------------------------- */
/* The judge                                                                   */
/* -------------------------------------------------------------------------- */

export type Verdict = "good" | "awkward" | "broken";

export interface Judgement {
  grammatical: boolean;
  semanticallySensible: boolean;
  headwordNatural: boolean;
  nativeWouldWrite: boolean;
  verdict: Verdict;
  reason: string;
}

export interface JudgedLink extends Link, Judgement {}

/**
 * The instruction. Its sha256 goes into the report: a quality number measured
 * against a different prompt is a different number, and swapping the prompt
 * without saying so would silently invalidate every comparison.
 *
 * Two deliberate choices. First, the few-shot examples are written here rather
 * than lifted from the corpus, so no sentence is both an exemplar and a
 * measurement. Second, the prompt spends as many words telling the judge what
 * is *not* a defect as what is: a judge primed only with broken examples finds
 * breakage everywhere, and terse, contextless textbook sentences are the normal
 * shape of this corpus, not a fault in it.
 */
export const JUDGE_PROMPT = `You are a Mandarin Chinese linguist auditing example sentences for a published HSK vocabulary corpus. Learners will read these sentences on flashcards to learn the target word.

You judge the CHINESE sentence. The English is given only so you know the intended meaning.

Answer four questions:

1. grammatical — is the Chinese well formed? Word order, particles, aspect markers, measure words, obligatory arguments present, parts of speech used in slots that accept them.
2. semanticallySensible — does it mean something coherent and plausible, and does it mean roughly what it is meant to mean? Not a word salad, not a category error, not a sentence whose parts contradict each other.
3. headwordNatural — is the TARGET WORD used the way a competent speaker actually uses it? Right part of speech, a collocation that really exists, not forced into a frame it does not fit, not invented as a surname or a personal name, not present only as a fragment of a longer word that carries the real meaning.
4. nativeWouldWrite — would an educated native speaker write this exact sentence, in a textbook, a message, or an article?

Then one verdict. The dividing line is the red-pen test: **would a native teacher mark this WRONG, or merely rewrite it for style?**

- "broken" — marked wrong. There is an actual error: ungrammatical; a collocation that does not exist; the target word in a part of speech or a frame that does not accept it; a common noun pressed into service as a surname or a name; or a sentence that does not mean what it is supposed to mean. A learner who studied this would learn something false.
- "awkward" — rewritten for style. Nothing is wrong, but it is stilted, translationese, or an unidiomatic way to say a thing that is nonetheless sayable.
- "good" — natural Mandarin. A native would write it. Minor taste is not a defect.

Calibration:

Sentence: 我每天早上七点起床。 Target: 起床 — {"grammatical":true,"semanticallySensible":true,"headwordNatural":true,"nativeWouldWrite":true,"verdict":"good","reason":"Ordinary, idiomatic sentence."}
Sentence: 他的心情是高兴的。 Target: 高兴 — {"grammatical":true,"semanticallySensible":true,"headwordNatural":true,"nativeWouldWrite":false,"verdict":"awkward","reason":"Not wrong, but translationese; a native says 他很高兴."}
Sentence: 他很吃饭。 Target: 吃饭 — {"grammatical":false,"semanticallySensible":false,"headwordNatural":false,"nativeWouldWrite":false,"verdict":"broken","reason":"很 cannot modify the verb phrase 吃饭."}
Sentence: 我昨天看了一本电影。 Target: 电影 — {"grammatical":false,"semanticallySensible":true,"headwordNatural":false,"nativeWouldWrite":false,"verdict":"broken","reason":"电影 takes 部 or 场, never 本."}
Sentence: 他的高兴很大。 Target: 高兴 — {"grammatical":false,"semanticallySensible":false,"headwordNatural":false,"nativeWouldWrite":false,"verdict":"broken","reason":"高兴 is an adjective and cannot head a noun phrase measured by 很大."}
Sentence: 花先生住在上海。 Target: 花 — {"grammatical":true,"semanticallySensible":false,"headwordNatural":false,"nativeWouldWrite":false,"verdict":"broken","reason":"The target is a common noun invented as a surname."}

Do not invent faults. These are all NORMAL and are not defects:
- short, terse, context-free textbook sentences
- formal or literary register
- a sentence with no subject where Chinese licenses the omission
- an English translation that is loose, as long as the Chinese is sound
- a target word that is rare or advanced, as long as it is used correctly

Reply with JSON only. Keep "reason" under 25 words, and write it in English.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    grammatical: { type: "boolean" },
    semanticallySensible: { type: "boolean" },
    headwordNatural: { type: "boolean" },
    nativeWouldWrite: { type: "boolean" },
    verdict: { type: "string", enum: ["good", "awkward", "broken"] },
    reason: { type: "string" },
  },
  required: [
    "grammatical",
    "semanticallySensible",
    "headwordNatural",
    "nativeWouldWrite",
    "verdict",
    "reason",
  ],
} as const;

function userMessage(link: Link): string {
  const gloss = link.headwordGlosses.length > 0 ? link.headwordGlosses.join("; ") : "(no gloss)";
  const pos = link.headwordPos === "" ? "" : ` [${link.headwordPos}]`;
  return [
    `Sentence: ${link.hanzi}`,
    `Pinyin: ${link.pinyin}`,
    `English: ${link.english}`,
    `Target word: ${link.headword} (${link.headwordPinyin})${pos} — ${gloss}`,
    `Target word HSK band: ${link.headwordBand === 7 ? "7-9" : String(link.headwordBand)}`,
  ].join("\n");
}

interface ApiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  error?: { code?: number; message?: string; status?: string };
  usageMetadata?: { totalTokenCount?: number };
}

export interface JudgeClient {
  model: string;
  judge(link: Link): Promise<Judgement>;
  tokensUsed(): number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google Generative Language API. Picked because it is the only key on this
 * machine that belongs to a model able to read Mandarin — see `resolveApiKey`,
 * which names every variable it looked at when it fails.
 */
export function geminiClient(model: string, apiKey: string): JudgeClient {
  let tokens = 0;
  const url = `${GENERATIVE_LANGUAGE_ENDPOINT}/${model}:generateContent?key=${apiKey}`;
  return {
    model,
    tokensUsed: () => tokens,
    async judge(link: Link): Promise<Judgement> {
      const body = {
        systemInstruction: { parts: [{ text: JUDGE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage(link) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      };
      let lastError = "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
        let payload: ApiResponse;
        let status = 0;
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          status = response.status;
          payload = (await response.json()) as ApiResponse;
        } catch (cause) {
          lastError = `network: ${String(cause)}`;
          continue;
        }
        if (payload.error !== undefined) {
          lastError = `HTTP ${status}: ${payload.error.message ?? payload.error.status ?? "error"}`;
          if (RETRYABLE.has(status)) continue;
          throw new Error(`judge: ${lastError}`);
        }
        tokens += payload.usageMetadata?.totalTokenCount ?? 0;
        const text = (payload.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("");
        if (text.trim() === "") {
          lastError = `empty completion (finishReason ${payload.candidates?.[0]?.finishReason ?? "?"})`;
          continue;
        }
        try {
          return parseJudgement(text);
        } catch (cause) {
          lastError = `unparseable completion: ${String(cause)}`;
        }
      }
      throw new Error(`judge: gave up on ${link.linkId} after 5 attempts — ${lastError}`);
    },
  };
}

export function parseJudgement(text: string): Judgement {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("not an object");
  const rec = raw as Record<string, unknown>;
  const bool = (key: string): boolean => {
    const value = rec[key];
    if (typeof value !== "boolean") throw new Error(`${key} is not a boolean`);
    return value;
  };
  const verdict = rec["verdict"];
  if (verdict !== "good" && verdict !== "awkward" && verdict !== "broken") {
    throw new Error(`verdict is ${JSON.stringify(verdict)}`);
  }
  const reason = rec["reason"];
  return {
    grammatical: bool("grammatical"),
    semanticallySensible: bool("semanticallySensible"),
    headwordNatural: bool("headwordNatural"),
    nativeWouldWrite: bool("nativeWouldWrite"),
    verdict,
    reason: typeof reason === "string" ? reason.trim() : "",
  };
}

/** Bounded-concurrency map that preserves input order. */
async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await worker(item, index);
        done += 1;
        onProgress?.(done, items.length);
      }
    })(),
  );
  await Promise.all(runners);
  return results.map((r, i) => {
    if (r === undefined) throw new Error(`pool: slot ${i} never filled`);
    return r;
  });
}

/* -------------------------------------------------------------------------- */
/* Gold set — does the judge agree with a human on cases we already know?      */
/* -------------------------------------------------------------------------- */

/**
 * Twelve links whose correct label is not in dispute: the six defects that were
 * found by reading the corpus by hand, and six sentences from the same corpus
 * that are plainly fine, one per band group and length group so the clean half
 * is not all easy band-1 material.
 *
 * This is a check on the instrument, not on the corpus. If the judge cannot
 * separate these twelve, its verdict on the other six hundred means nothing,
 * and the report says so rather than burying it.
 */
export interface GoldItem {
  sentenceId: string;
  wordId: string;
  expected: Verdict;
  note: string;
}

export const GOLD_SET: readonly GoldItem[] = [
  {
    sentenceId: "dex:s:b3ce51a71aa5",
    wordId: "dex:w:jian4qian2yan3kai1:见钱眼开:x",
    expected: "broken",
    note: "他不好的 is ungrammatical",
  },
  {
    sentenceId: "dex:s:e7bb70a84490",
    wordId: "dex:w:tui1li3:推理:v",
    expected: "broken",
    note: "不明白 needs a person subject",
  },
  {
    sentenceId: "dex:s:97afc1f96e2a",
    wordId: "dex:w:shi4:室:n",
    expected: "broken",
    note: "室 is not a surname",
  },
  {
    sentenceId: "dex:s:02266e6ee47f",
    wordId: "dex:w:nan2:难:adj",
    expected: "broken",
    note: "难 is not a noun here",
  },
  {
    sentenceId: "dex:s:612cfe9628e8",
    wordId: "dex:w:yao4pin3:药品:n",
    expected: "broken",
    note: "开药品 is not a collocation",
  },
  {
    sentenceId: "dex:s:bbf5b1786a9a",
    wordId: "dex:w:xin1yan3r5:心眼儿:n",
    expected: "broken",
    note: "没心眼儿 does not take 对我",
  },
  {
    sentenceId: "dex:s:3a84b4d0ca22",
    wordId: "dex:w:hua1:花:n",
    expected: "good",
    note: "我很喜欢花。band 1-3, single char",
  },
  {
    sentenceId: "dex:s:e6c68002a088",
    wordId: "dex:w:du2zhe3:读者:n",
    expected: "good",
    note: "很多读者喜欢这本书。band 1-3, two chars",
  },
  {
    sentenceId: "dex:s:34c95b3009c2",
    wordId: "dex:w:tong2nian2:童年:n",
    expected: "good",
    note: "他常想念童年的朋友。band 4-6",
  },
  {
    sentenceId: "dex:s:1f3d712b7923",
    wordId: "dex:w:dian4zi5:垫子:n",
    expected: "good",
    note: "她把垫子放在了椅子上。band 7, 把 construction",
  },
  {
    sentenceId: "dex:s:475394cfbf2a",
    wordId: "dex:w:chui2tou2sang4qi4:垂头丧气:x",
    expected: "good",
    note: "他垂头丧气地坐在椅子上。band 7, four-char idiom",
  },
  {
    sentenceId: "dex:s:ccaaa5dba14e",
    wordId: "dex:w:shi4shi2:事实:n",
    expected: "good",
    note: "尽管证据确凿…… long, formal, correct",
  },
];

export interface GoldResult {
  sentenceId: string;
  wordId: string;
  hanzi: string;
  headword: string;
  expected: Verdict;
  got: Verdict;
  agree: boolean;
  note: string;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

export interface QualityReportJudgeSection {
  schema: "zhongdex/quality-report/v1";
  generator: string;
  note: string;
  judge: {
    provider: "google-generative-language";
    model: string;
    temperature: 0;
    promptSha256: string;
    judgedAt: string;
    totalTokens: number;
    failures: number;
  };
  goldSet: {
    definition: string;
    n: number;
    agreed: number;
    brokenRecall: number;
    cleanSpecificity: number;
    items: GoldResult[];
  };
  /** Null when the run did not ask for a second opinion. */
  interJudgeAgreement: {
    definition: string;
    secondModel: string;
    n: number;
    exactAgreement: number;
    brokenAgreement: number;
    cohensKappa: number;
    confusion: Record<string, number>;
  } | null;
  sampling: {
    unit: string;
    seed: string;
    seedInt: number;
    design: string;
    frame: { sentences: number; links: number; headwords: number };
    requested: number;
    judged: number;
    strata: { stratum: string; population: number; weight: number; n: number }[];
  };
  results: {
    definition: string;
    corpusWide: {
      brokenRate: number;
      brokenCi95: Interval;
      brokenStandardError: number;
      notCleanRate: number;
      notCleanCi95: Interval;
      notCleanStandardError: number;
    };
    byStratum: StratumTally[];
    byBandGroup: StratumTally[];
    byHeadwordLength: StratumTally[];
    byFlag: Record<string, { failed: number; n: number; rate: number }>;
  };
  labels: JudgedLink[];
}

/**
 * Cohen's kappa on the three-way verdict, between the primary judge and a
 * second model reading the same links blind. Raw agreement flatters any rating
 * task whose labels are this skewed toward "good"; kappa is what survives
 * subtracting the agreement two independent judges would reach by chance.
 */
export function cohensKappa(
  a: readonly Verdict[],
  b: readonly Verdict[],
): { kappa: number; exact: number; confusion: Record<string, number> } {
  const classes: readonly Verdict[] = ["good", "awkward", "broken"];
  const confusion: Record<string, number> = {};
  for (const x of classes) for (const y of classes) confusion[`${x}->${y}`] = 0;
  const n = Math.min(a.length, b.length);
  let observed = 0;
  const marginalA = new Map<Verdict, number>();
  const marginalB = new Map<Verdict, number>();
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) continue;
    confusion[`${x}->${y}`] = (confusion[`${x}->${y}`] ?? 0) + 1;
    marginalA.set(x, (marginalA.get(x) ?? 0) + 1);
    marginalB.set(y, (marginalB.get(y) ?? 0) + 1);
    if (x === y) observed += 1;
  }
  if (n === 0) return { kappa: 0, exact: 0, confusion };
  const po = observed / n;
  let pe = 0;
  for (const c of classes) pe += ((marginalA.get(c) ?? 0) / n) * ((marginalB.get(c) ?? 0) / n);
  return { kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), exact: po, confusion };
}

function tally(
  stratum: string,
  bandGroup: BandGroup,
  lenGroup: LenGroup,
  population: number,
  populationTotal: number,
  judged: readonly JudgedLink[],
): StratumTally {
  const n = judged.length;
  let broken = 0;
  let awkward = 0;
  let good = 0;
  for (const j of judged) {
    if (j.verdict === "broken") broken += 1;
    else if (j.verdict === "awkward") awkward += 1;
    else good += 1;
  }
  const notClean = broken + awkward;
  return {
    stratum,
    bandGroup,
    lenGroup,
    population,
    weight: populationTotal === 0 ? 0 : population / populationTotal,
    n,
    broken,
    awkward,
    good,
    brokenRate: n === 0 ? 0 : broken / n,
    brokenCi95: wilson(broken, n),
    brokenUpperBoundRuleOfThree: broken === 0 ? ruleOfThree(n) : null,
    notCleanRate: n === 0 ? 0 : notClean / n,
    notCleanCi95: wilson(notClean, n),
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Names every variable it checked, so a failure tells you what to set. */
export function resolveApiKey(env: NodeJS.ProcessEnv): string {
  const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "" && !value.includes("DUMMY")) return value.trim();
  }
  throw new Error(
    `quality-judge: no model reachable. Set one of ${names.join(", ")} to a Google ` +
      `Generative Language API key and re-run. Refusing to emit a quality number ` +
      `without a model: a fabricated measurement is worse than no measurement.`,
  );
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const model = arg(argv, "--model") ?? DEFAULT_MODEL;
  const seed = arg(argv, "--seed") ?? DEFAULT_SEED;
  const size = Number(arg(argv, "--n") ?? DEFAULT_SAMPLE_SIZE);
  const floor = Number(arg(argv, "--floor") ?? DEFAULT_STRATUM_FLOOR);
  const concurrency = Number(arg(argv, "--concurrency") ?? DEFAULT_CONCURRENCY);
  const goldOnly = argv.includes("--gold-only");
  const agreementN = Number(arg(argv, "--agreement") ?? 0);
  const agreementModel = arg(argv, "--agreement-model") ?? "gemini-3.1-pro-preview";
  if (!Number.isFinite(size) || size <= 0) throw new Error(`--n must be a positive integer`);

  const apiKey = resolveApiKey(process.env);
  const client = geminiClient(model, apiKey);

  const corpus = readCorpus();
  const canon = readCanon();
  const links = buildLinks(corpus, canon);
  const byId = new Map(links.map((l) => [`${l.sentenceId}|${l.wordId}`, l]));
  log(`quality-judge: frame ${corpus.length} sentences, ${links.length} headword links`);

  /* Gold set first: if the instrument is broken, stop before spending 600 calls. */
  const goldLinks = GOLD_SET.map((g) => {
    const link = byId.get(`${g.sentenceId}|${g.wordId}`);
    if (link === undefined) throw new Error(`quality-judge: gold link ${g.sentenceId}|${g.wordId} is not in the corpus`);
    return { gold: g, link };
  });
  const goldJudged = await pool(goldLinks, concurrency, async ({ gold, link }) => {
    const j = await client.judge(link);
    return { gold, link, j };
  });
  const goldItems: GoldResult[] = goldJudged.map(({ gold, link, j }) => ({
    sentenceId: gold.sentenceId,
    wordId: gold.wordId,
    hanzi: link.hanzi,
    headword: link.headword,
    expected: gold.expected,
    got: j.verdict,
    agree: gold.expected === j.verdict,
    note: gold.note,
    reason: j.reason,
  }));
  const goldBroken = goldItems.filter((g) => g.expected === "broken");
  const goldClean = goldItems.filter((g) => g.expected === "good");
  const brokenRecall =
    goldBroken.length === 0 ? 0 : goldBroken.filter((g) => g.got === "broken").length / goldBroken.length;
  const cleanSpecificity =
    goldClean.length === 0 ? 0 : goldClean.filter((g) => g.got !== "broken").length / goldClean.length;
  log(
    `quality-judge: gold ${goldItems.filter((g) => g.agree).length}/${goldItems.length} exact` +
      ` · broken recall ${(brokenRecall * 100).toFixed(0)}%` +
      ` · clean specificity ${(cleanSpecificity * 100).toFixed(0)}%`,
  );
  for (const g of goldItems) {
    if (!g.agree) log(`  gold miss: ${g.hanzi} [${g.headword}] expected ${g.expected}, got ${g.got} — ${g.reason}`);
  }
  if (goldOnly) return;

  /* The measurement. */
  const sample = drawSample(links, size, floor, seed);
  const populationTotal = links.length;
  log(
    `quality-judge: drawn ${sample.links.length} links across ${sample.allocations.length} strata` +
      ` (seed "${seed}") — judging with ${model} at concurrency ${concurrency}`,
  );

  let failures = 0;
  const judged = await pool(
    sample.links,
    concurrency,
    async (link): Promise<JudgedLink | null> => {
      try {
        return { ...link, ...(await client.judge(link)) };
      } catch (cause) {
        failures += 1;
        log(`  judge failed on ${link.linkId}: ${String(cause)}`);
        return null;
      }
    },
    (done, total) => {
      if (done % 50 === 0 || done === total) log(`  judged ${done}/${total}`);
    },
  );
  const labels = judged.filter((j): j is JudgedLink => j !== null);

  const populations = new Map(sample.allocations.map((a) => [a.stratum, a.population]));
  const byStratum = STRATA.filter((s) => (populations.get(s) ?? 0) > 0).map((s) => {
    const bandGroup = (s.slice(1).split("-len")[0] ?? "1-3") as BandGroup;
    const lenGroup = (s.split("-len")[1] ?? "1") as LenGroup;
    return tally(
      s,
      bandGroup,
      lenGroup,
      populations.get(s) ?? 0,
      populationTotal,
      labels.filter((l) => l.stratum === s),
    );
  });

  const groupBy = (
    key: (l: Link) => string,
    keys: readonly string[],
    bandOf: (k: string) => BandGroup,
    lenOf: (k: string) => LenGroup,
  ): StratumTally[] =>
    keys
      .map((k) =>
        tally(
          k,
          bandOf(k),
          lenOf(k),
          links.filter((l) => key(l) === k).length,
          populationTotal,
          labels.filter((l) => key(l) === k),
        ),
      )
      .filter((t) => t.population > 0);

  const byBandGroup = groupBy(
    (l) => bandGroupOf(l.headwordBand),
    BAND_GROUPS,
    (k) => k as BandGroup,
    () => "1",
  );
  const byHeadwordLength = groupBy(
    (l) => lenGroupOf(l.headwordCharLen),
    LEN_GROUPS,
    () => "1-3",
    (k) => k as LenGroup,
  );

  const brokenEstimate = stratifiedEstimate(
    byStratum.map((t) => ({ population: t.population, n: t.n, successes: t.broken })),
  );
  const notCleanEstimate = stratifiedEstimate(
    byStratum.map((t) => ({ population: t.population, n: t.n, successes: t.broken + t.awkward })),
  );

  let agreement: QualityReportJudgeSection["interJudgeAgreement"] = null;
  if (agreementN > 0 && labels.length > 0) {
    const subset = labels.slice(0, Math.min(agreementN, labels.length));
    const second = geminiClient(agreementModel, apiKey);
    log(`quality-judge: second opinion on ${subset.length} links with ${agreementModel}`);
    const secondVerdicts = await pool(subset, concurrency, async (link) => {
      try {
        return (await second.judge(link)).verdict;
      } catch {
        return null;
      }
    });
    const pairs = subset
      .map((l, i) => ({ a: l.verdict, b: secondVerdicts[i] }))
      .filter((p): p is { a: Verdict; b: Verdict } => p.b !== null && p.b !== undefined);
    const k = cohensKappa(
      pairs.map((p) => p.a),
      pairs.map((p) => p.b),
    );
    const brokenAgree = pairs.filter((p) => (p.a === "broken") === (p.b === "broken")).length;
    agreement = {
      definition:
        "A second model re-judged a prefix of the same drawn sample, blind to the first " +
        "model's verdict, with the identical prompt. Kappa is on the three-way verdict; " +
        "brokenAgreement is on the binary broken / not-broken call the filter actually uses.",
      secondModel: agreementModel,
      n: pairs.length,
      exactAgreement: k.exact,
      brokenAgreement: pairs.length === 0 ? 0 : brokenAgree / pairs.length,
      cohensKappa: k.kappa,
      confusion: k.confusion,
    };
    log(
      `quality-judge: inter-judge exact ${(k.exact * 100).toFixed(0)}%` +
        ` · broken/not-broken ${((brokenAgree / Math.max(1, pairs.length)) * 100).toFixed(0)}%` +
        ` · kappa ${k.kappa.toFixed(2)}`,
    );
  }

  const flags: Record<string, { failed: number; n: number; rate: number }> = {};
  const flagNames = [
    "grammatical",
    "semanticallySensible",
    "headwordNatural",
    "nativeWouldWrite",
  ] as const;
  for (const flag of flagNames) {
    const failed = labels.filter((l) => !l[flag]).length;
    flags[flag] = { failed, n: labels.length, rate: labels.length === 0 ? 0 : failed / labels.length };
  }

  const report: QualityReportJudgeSection = {
    schema: "zhongdex/quality-report/v1",
    generator: "src/build/quality-judge.ts",
    note:
      "Measured quality of data/sentences.jsonl. Produced by an LLM judge over a seeded " +
      "stratified random sample of headword links, not by a computable gate. Re-run with " +
      "`npm run judge:quality`; src/build/quality.ts then appends the filter analysis.",
    judge: {
      provider: "google-generative-language",
      model,
      temperature: 0,
      promptSha256: createHash("sha256").update(JUDGE_PROMPT, "utf8").digest("hex"),
      judgedAt: new Date().toISOString(),
      totalTokens: client.tokensUsed(),
      failures,
    },
    goldSet: {
      definition:
        "Six defects found by reading the corpus by hand plus six sentences from the same " +
        "corpus that are plainly correct. A check on the judge, not on the corpus.",
      n: goldItems.length,
      agreed: goldItems.filter((g) => g.agree).length,
      brokenRecall,
      cleanSpecificity,
      items: goldItems,
    },
    interJudgeAgreement: agreement,
    sampling: {
      unit: "headword link (one sentence paired with one canon headword it was selected for)",
      seed,
      seedInt: sample.seedInt,
      design:
        `Stratified random sample. Strata are HSK band group of the headword (1-3 / 4-6 / 7) ` +
        `crossed with headword character length (1 / 2 / 3+) — the two axes the known defects ` +
        `cluster on. Allocation is a floor of ${floor} per stratum plus the remainder ` +
        `proportional to stratum population, so every stratum is individually reportable and ` +
        `the corpus-wide estimate is still carried by the large strata. Corpus-wide rates are ` +
        `population-weighted with a finite-population correction; a simple mean over the ` +
        `sample would over-weight the deliberately over-sampled small strata.`,
      frame: {
        sentences: corpus.length,
        links: links.length,
        headwords: new Set(links.map((l) => l.wordId)).size,
      },
      requested: size,
      judged: labels.length,
      strata: byStratum.map((t) => ({
        stratum: t.stratum,
        population: t.population,
        weight: t.weight,
        n: t.n,
      })),
    },
    results: {
      definition:
        "broken = the judge says the sentence is ungrammatical, incoherent, or misuses the " +
        "headword. awkward = parseable but stilted or unidiomatic. good = natural Mandarin. " +
        "`notClean` is broken + awkward.",
      corpusWide: {
        brokenRate: brokenEstimate.estimate,
        brokenCi95: brokenEstimate.ci95,
        brokenStandardError: brokenEstimate.standardError,
        notCleanRate: notCleanEstimate.estimate,
        notCleanCi95: notCleanEstimate.ci95,
        notCleanStandardError: notCleanEstimate.standardError,
      },
      byStratum,
      byBandGroup,
      byHeadwordLength,
      byFlag: flags,
    },
    labels,
  };

  writeFileSync(QUALITY_REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  log(
    `quality-judge: corpus-wide broken ${pct(brokenEstimate.estimate)}` +
      ` (95% CI ${pct(brokenEstimate.ci95.low)}-${pct(brokenEstimate.ci95.high)})` +
      ` · not-clean ${pct(notCleanEstimate.estimate)}`,
  );
  for (const t of byStratum) {
    log(
      `  ${t.stratum.padEnd(12)} n=${String(t.n).padStart(3)} pop=${String(t.population).padStart(6)}` +
        ` broken ${pct(t.brokenRate).padStart(6)} [${pct(t.brokenCi95.low)}-${pct(t.brokenCi95.high)}]` +
        ` awkward ${pct(t.awkward / Math.max(1, t.n))}`,
    );
  }
  log(`quality-judge: ${client.tokensUsed()} tokens, ${failures} failures`);
  log(`quality-judge: wrote ${QUALITY_REPORT_JSON}. Next: npm run quality:filter`);
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].includes("quality-judge");
if (invokedDirectly) {
  await main();
}
