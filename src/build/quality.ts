/**
 * Zhongdex sentence corpus — computable quality filter.
 *
 * `quality-judge.ts` measures the defect rate with a model. This file is the
 * part that can run without one: a set of **computable predictors** of
 * brokenness, each measured against the judge's labels, and a set of named
 * **filter policies** built out of them, each measured for what it costs.
 *
 * The discipline the whole file exists to enforce is: *no filter ships that has
 * not been scored against labels.* A plausible-sounding rule — "drop band 7,
 * it's the hard stuff" — turns out here to be actively harmful, and the only
 * reason we know that is that it was measured rather than reasoned about.
 *
 * Three things worth knowing before reading the numbers:
 *
 * 1. **Everything is sampling-weighted.** The judged sample deliberately
 *    over-samples the small strata, so raw precision on the 600 labels is not
 *    corpus precision. Every rate here is reweighted by stratum population.
 *
 * 2. **Coverage is a first-class cost.** The corpus covers 99.82% of the canon.
 *    A filter that halves the error rate by dropping a sixth of the headwords
 *    entirely is usually a bad trade against simply disclosing the rate, so
 *    every policy reports the coverage it leaves behind and most of them carry
 *    a `keepLastLink` rule that refuses to strip a headword's final sentence.
 *
 * 3. **Nothing here deletes anything.** The output is a decision — a policy id,
 *    its rule, and a digest of exactly which links it excludes — written into
 *    `data/quality-report.json`. `data/sentences.jsonl` is not touched. Use
 *    `--emit-exclusions <path>` to materialise the id list for a later pass.
 *
 * Usage:
 *   npx tsx src/build/quality.ts [--emit-exclusions out.json] [--policy <id>]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import type { Band } from "./types.js";
import type { SentenceQualityMeasurement } from "./sentence-schema.js";
import {
  JUDGE_PROMPT,
  QUALITY_REPORT_JSON,
  STRATA,
  bandGroupOf,
  buildLinks,
  drawSample,
  geminiClient,
  lenGroupOf,
  readCanon,
  readCorpus,
  resolveApiKey,
  stratifiedEstimate,
  stratumOf,
  wilson,
} from "./quality-judge.js";
import type {
  CanonWord,
  CorpusSentence,
  Interval,
  JudgedLink,
  QualityReportJudgeSection,
} from "./quality-judge.js";

/** Rows in the canon. Coverage is a share of this, as `sentence-stats.json` reports it. */
const CANON_ROWS = 11092;

/* -------------------------------------------------------------------------- */
/* Features                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a predictor is allowed to look at. All of it is already in
 * `sentences.jsonl` and `hsk_bands.json`, so any consumer can recompute every
 * predictor in this file without a model, a database, or this repo.
 */
export interface LinkFeatures {
  linkId: string;
  sentenceId: string;
  wordId: string;
  headword: string;
  headwordCharLen: number;
  headwordBand: Band;
  stratum: string;
  slot: string;
  /** Does the headword survive segmentation as its own token in this sentence? */
  headwordIsDiscreteToken: boolean;
  glosses: string[];
  zipf: number | null;
  hanzi: string;
  charLen: number;
  charLengthPercentilePct: number;
  zsg: Band;
  beyondHskTokens: number;
}

/**
 * CC-CEDICT's vocabulary for "this is not a free word". A headword whose gloss
 * is `abbr. for …` or `used in …` does not stand on its own, so a sentence that
 * uses it as if it did is suspect.
 */
const BOUND_FORM_GLOSS =
  /\babbr\. for\b|\bused in\b|\bvariant of\b|\bold variant\b|\bsee \b|\bbound form\b|\bcontraction of\b|\bshort for\b/i;
const SURNAME_GLOSS = /\bsurname\b/i;

export function buildFeatures(
  corpus: readonly CorpusSentence[],
  canon: ReadonlyMap<string, CanonWord>,
): LinkFeatures[] {
  const out: LinkFeatures[] = [];
  for (const s of corpus) {
    const words = new Set(s.words);
    for (const h of s.headwords) {
      const word = canon.get(h.wordId);
      out.push({
        linkId: `${s.id}|${h.wordId}`,
        sentenceId: s.id,
        wordId: h.wordId,
        headword: h.simplified,
        headwordCharLen: [...h.simplified].length,
        headwordBand: h.band,
        stratum: stratumOf(h.band, [...h.simplified].length),
        slot: h.slot,
        // Exactly the test `sentences.ts` uses for `headwordAttestedAsToken`:
        // membership of the record's own `words` array. Reproducing its
        // definition rather than inventing a second one keeps the two numbers
        // comparable.
        headwordIsDiscreteToken: words.has(h.simplified),
        glosses: (word?.definitions ?? []).map((d) => d.text),
        zipf: word?.zipf ?? null,
        hanzi: s.hanzi,
        charLen: s.charLen,
        charLengthPercentilePct: s.charLengthPercentile.pct,
        zsg: s.zsg,
        beyondHskTokens: s.beyondHskTokens,
      });
    }
  }
  out.sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Predictors                                                                  */
/* -------------------------------------------------------------------------- */

export interface Predictor {
  id: string;
  /** Why it was a candidate, written before the labels were looked at. */
  hypothesis: string;
  test: (f: LinkFeatures) => boolean;
  /** Contribution to the tie-break score that decides which link to keep. */
  riskWeight: number;
}

/**
 * The candidate list. Every one of these was proposed as a hypothesis about the
 * generator's failure mode; the measurement below decides which of them are
 * true. Two of the loudest priors — band 7, and sentence grade 7 — are kept in
 * the list precisely so the report can show that they do not predict anything.
 */
export const PREDICTORS: readonly Predictor[] = [
  {
    id: "headword-single-char",
    hypothesis:
      "A one-character headword is often a bound morpheme, a polyphone, or a fragment of " +
      "the word that carries the meaning. The generator has to build a whole sentence " +
      "around it and has the least to work with.",
    test: (f) => f.headwordCharLen === 1,
    riskWeight: 1,
  },
  {
    id: "headword-band-7",
    hypothesis:
      "Band 7 is the merged 7-9 range: 5,636 of the canon's 11,092 words, the advanced " +
      "and low-frequency tail. The hand read of 42 sentences put the defects here.",
    test: (f) => f.headwordBand === 7,
    riskWeight: 0,
  },
  {
    id: "headword-not-discrete-token",
    hypothesis:
      "If the headword does not survive segmentation as its own token it is buried inside " +
      "a longer word — 生 inside 医生 — and the sentence teaches the longer word, not this one.",
    test: (f) => !f.headwordIsDiscreteToken,
    riskWeight: 2,
  },
  {
    id: "headword-used-as-name",
    hypothesis:
      "A common noun immediately followed by a title, or preceded by 姓 or 叫, has been " +
      "pressed into service as a surname. This is the 室先生 failure.",
    test: (f) => usedAsName(f.hanzi, f.headword),
    riskWeight: 3,
  },
  {
    id: "headword-bound-form-gloss",
    hypothesis: "CC-CEDICT says the headword is an abbreviation, a variant, or a bound form.",
    test: (f) => f.glosses.some((g) => BOUND_FORM_GLOSS.test(g)),
    riskWeight: 1,
  },
  {
    id: "headword-surname-gloss",
    hypothesis: "CC-CEDICT lists the headword as a surname, so the generator had a licence to misuse it.",
    test: (f) => f.glosses.some((g) => SURNAME_GLOSS.test(g)),
    riskWeight: 1,
  },
  {
    id: "sentence-short-for-band",
    hypothesis:
      "A sentence in the bottom decile of length for its own grade band is likely a frame " +
      "with the headword dropped in rather than a sentence about anything. 这次难很大 is six characters.",
    test: (f) => f.charLengthPercentilePct <= 15,
    riskWeight: 1,
  },
  {
    id: "sentence-very-short",
    hypothesis: "Eight characters or fewer leaves no room for the context that makes a use natural.",
    test: (f) => f.charLen <= 8,
    riskWeight: 0,
  },
  {
    id: "slot-easy",
    hypothesis:
      "An `easy` link is a sentence graded below its headword's own band — the headword is " +
      "the hardest thing in it and everything else is trivial, which is the shape of a forced frame.",
    test: (f) => f.slot === "easy",
    riskWeight: 3,
  },
  {
    id: "slot-stretch",
    hypothesis: "A `stretch` link carries material above the headword's band and has more room to go wrong.",
    test: (f) => f.slot === "stretch",
    riskWeight: 0,
  },
  {
    id: "sentence-beyond-hsk",
    hypothesis: "A token outside HSK 3.0 altogether may be a typo, a name, or a word the source invented.",
    test: (f) => f.beyondHskTokens > 0,
    riskWeight: 0,
  },
  {
    id: "headword-low-frequency",
    hypothesis: "A headword with little or no corpus attestation is one the source had few real examples of.",
    test: (f) => f.zipf === null || f.zipf < 3,
    riskWeight: 0,
  },
  {
    id: "sentence-grade-7",
    hypothesis: "A ZSG-7 sentence contains advanced material anywhere in it, not just in the headword.",
    test: (f) => f.zsg === 7,
    riskWeight: 0,
  },
];

/** Deterministic tie-break score. Only used to choose which link to keep. */
export function riskScore(f: LinkFeatures): number {
  let score = 0;
  for (const p of PREDICTORS) if (p.test(f)) score += p.riskWeight;
  return score;
}

/* -------------------------------------------------------------------------- */
/* Build-time exclusion gate                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The predictors above are a post-hoc scoring of a corpus that already shipped.
 * This section is the same evidence turned into a rule the *build* runs, so the
 * corpus never contains the links in the first place.
 *
 * Two tiers, and the difference between them is what happens when a headword
 * has nothing better:
 *
 *   **hard**  the link is never selected while any unflagged candidate exists.
 *             Every hard rule is measured at or above 45% broken against a
 *             corpus base rate of 12.85% — a link one of these flags is three
 *             to eight times worse than an average one.
 *   **soft**  the link is selected only when no candidate clears both tiers.
 *             These are the rules with real lift but too little precision to
 *             delete on; they cost nothing here because the build has 137,541
 *             graded sentences to choose from and ships 30,000.
 *
 * Neither tier can take a headword's last sentence: `sentences.ts` falls back
 * through soft, then hard, then the whole candidate list, so coverage is
 * arithmetically unchanged. A rule can only ever change *which* sentence a
 * headword gets, or reduce a headword from three sentences to one.
 *
 * Every `evidence` string is a count over the 600 judged labels in
 * `data/quality-report.json`, measured on the corpus that shipped before this
 * gate existed. They are sample counts, not corpus rates: the corpus rate is
 * population-weighted, and `PREDICTORS` above carries the weighted version for
 * the four rules that predate this gate.
 */

/** One candidate (sentence, headword) pair, as the build sees it before selection. */
export interface CandidateLink {
  hanzi: string;
  /** Numbered pinyin for the sentence, one syllable per Han character. Null when unparseable. */
  pinyinNumbered: string | null;
  /** The exact headword form that occurs in this sentence. */
  headword: string;
  /** Numbered pinyin of the headword, from the canon. */
  headwordPinyinNumbered: string;
  /** Canon forms attested in the sentence — `grade()`'s `words`. */
  words: readonly string[];
  /** Tokens of the same sentence under CC-CEDICT's much larger form list. */
  cedictTokens: ReadonlySet<string>;
  slot: string;
  charLengthPercentilePct: number;
  /** How many distinct canon headwords share this sentence with the headword blanked out. */
  frameHeadwordCount: number;
}

/**
 * Titles that turn the word in front of them into a name. A common noun sitting
 * in this slot is the `室先生` failure: the generator needed a surname, had a
 * headword, and used it.
 *
 * The list is longer than the twelve titles the first pass used, because the
 * first pass caught 10 of the sample's defects and this one catches 18 with no
 * false positive: the generator invents 延博士, 也律师, 区经理, 咸律师 and
 * 枚董事长 as readily as it invents 室先生. Terms that are also ordinary nouns
 * after a modifier — 同学, 专家, 记者, 护士 — are deliberately absent: 老同学
 * and 女专家 would flag 老 and 女 for a use that is perfectly correct.
 */
const NAME_TITLES: readonly string[] = [
  "先生", "女士", "小姐", "老师", "太太", "夫人", "同志", "教授", "医生", "老板",
  "阿姨", "叔叔", "博士", "律师", "经理", "董事长", "总经理", "主任", "主席",
  "部长", "校长", "院长", "秘书", "队长", "警官", "法官", "工程师", "大夫",
  "师傅", "教练", "厂长", "局长", "处长", "科长", "市长", "省长", "县长",
  "站长", "团长", "会长", "社长", "馆长", "老总", "总统", "总理", "将军",
  "书记", "司令", "顾问", "大使", "牧师", "神父", "董事",
];

/** The `室先生` / `姓室` / `叫室` test, on one headword form. */
export function usedAsName(hanzi: string, headword: string): boolean {
  if (headword === "") return false;
  return (
    NAME_TITLES.some((t) => hanzi.includes(`${headword}${t}`)) ||
    hanzi.includes(`姓${headword}`) ||
    hanzi.includes(`叫${headword}`)
  );
}

const HAN_CHAR = /\p{Script=Han}/u;

/**
 * Forward maximum matching over an arbitrary form list. `grade.ts` segments
 * against the canon because ZSG must be re-derivable from the published word
 * list alone; this one segments against CC-CEDICT's 120,400 headwords, which
 * is not a grading input but is a far better answer to "is this character a
 * word here, or a piece of one?". 校训 and 焊接 are not HSK words, so the canon
 * segmenter hands back 训 and 焊 as free tokens; CC-CEDICT does not.
 */
export function maximalTokens(
  hanzi: string,
  forms: ReadonlySet<string>,
  maxFormLength: number,
): Set<string> {
  const chars = [...hanzi];
  const out = new Set<string>();
  let i = 0;
  while (i < chars.length) {
    const head = chars[i];
    if (head === undefined) break;
    if (!HAN_CHAR.test(head)) {
      i += 1;
      continue;
    }
    let matched = false;
    const limit = Math.min(maxFormLength, chars.length - i);
    for (let len = limit; len >= 2; len -= 1) {
      const slice = chars.slice(i, i + len);
      if (!slice.every((c) => HAN_CHAR.test(c))) continue;
      const candidate = slice.join("");
      if (forms.has(candidate)) {
        out.add(candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    out.add(head);
    i += 1;
  }
  return out;
}

export interface CedictForms {
  forms: ReadonlySet<string>;
  maxFormLength: number;
}

/**
 * Every multi-character simplified headword CC-CEDICT knows, for `maximalTokens`.
 * Reads the vendored dump the canon build already depends on, so this adds no
 * new source and no network read. Single characters are excluded: a one-character
 * entry cannot bury anything.
 */
export function readCedictForms(path: string): CedictForms {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { data?: Record<string, unknown> };
  const data = parsed.data;
  if (typeof data !== "object" || data === null) {
    throw new Error(`quality: ${path} has no "data" object. Expected the vendored CC-CEDICT dump.`);
  }
  const forms = new Set<string>();
  let maxFormLength = 2;
  for (const key of Object.keys(data)) {
    const chars = [...key];
    if (chars.length < 2 || !chars.every((c) => HAN_CHAR.test(c))) continue;
    forms.add(key);
    if (chars.length > maxFormLength) maxFormLength = chars.length;
  }
  // 8 characters is past every compound and into chengyu-plus-gloss territory;
  // the cap keeps the inner loop bounded on a 120,000-entry form list.
  return { forms, maxFormLength: Math.min(maxFormLength, 8) };
}

/**
 * The sentence with the headword blanked out. Two sentences with the same frame
 * are the same generated template filled with different words — `这是◇。`,
 * `他是一个◇的人。`, `◇先生在学校工作。` — and a template stamped across
 * hundreds of headwords is a frame, not a sentence about anything.
 */
export function maskedFrame(hanzi: string, headword: string): string {
  return headword === "" ? hanzi : hanzi.split(headword).join("\u25c7");
}

/** One numbered-pinyin syllable, split into base and tone. Null when unparseable. */
function syllable(raw: string): { base: string; tone: string } | null {
  const cleaned = raw.toLowerCase().replace(/ü/g, "v").replace(/u:/g, "v");
  const m = /^([a-z]+)([1-5])?$/.exec(cleaned);
  if (m === null) return null;
  const base = m[1];
  if (base === undefined) return null;
  return { base, tone: m[2] ?? "5" };
}

/**
 * True when the sentence reads the headword as a different word.
 *
 * The source ships one pinyin syllable per Han character, so the syllables can
 * be aligned to the characters positionally and the headword's own reading
 * checked against the canon's. 他买了三担苹果 spells 担 `dan4`, the measure
 * word; the headword is `dan1`, the verb. 农民伯伯正在地里干活 spells 地 `di4`,
 * the noun; the headword is the particle `de5`. Both are well-formed Chinese
 * that teaches the wrong word, which is exactly the defect the judge's
 * `headwordNatural` flag keeps failing on.
 *
 * Conservative by construction: any misalignment, any unparseable syllable, and
 * any occurrence that does match returns false. `bu` and `yi` are exempt from
 * the tone test because 不 and 一 change tone by sandhi, and a neutral tone on
 * either side matches anything, because the two sources spell it differently.
 */
export function readingMismatch(
  hanzi: string,
  pinyinNumbered: string | null,
  headword: string,
  headwordPinyinNumbered: string,
): boolean {
  if (pinyinNumbered === null || headword === "") return false;
  const syllables = pinyinNumbered.split(" ").filter((s) => s !== "");
  const chars = [...hanzi];
  const positionOf = new Map<number, number>();
  let han = 0;
  chars.forEach((c, i) => {
    if (HAN_CHAR.test(c)) {
      positionOf.set(i, han);
      han += 1;
    }
  });
  if (han !== syllables.length) return false;

  const headChars = [...headword];
  const want = headwordPinyinNumbered.split(" ").filter((s) => s !== "").map(syllable);
  if (want.length !== headChars.length || want.some((w) => w === null)) return false;

  let sawOccurrence = false;
  for (let i = 0; i + headChars.length <= chars.length; i += 1) {
    if (chars.slice(i, i + headChars.length).join("") !== headword) continue;
    const got: ({ base: string; tone: string } | null)[] = [];
    for (let j = 0; j < headChars.length; j += 1) {
      const at = positionOf.get(i + j);
      got.push(at === undefined ? null : syllable(syllables[at] ?? ""));
    }
    if (got.some((g) => g === null)) continue;
    sawOccurrence = true;
    const agrees = got.every((g, j) => {
      const w = want[j];
      if (g === null || w === null || w === undefined) return true;
      if (g.base !== w.base) return false;
      if (w.base === "bu" || w.base === "yi") return true;
      if (g.tone === "5" || w.tone === "5") return true;
      return g.tone === w.tone;
    });
    if (agrees) return false;
  }
  return sawOccurrence;
}

export interface ExclusionRule {
  id: string;
  tier: "hard" | "soft";
  /** What the rule says, in one line. Ships in `data/sentence-stats.json`. */
  rule: string;
  /** What the 600 judged labels say about it. Sample counts, not corpus rates. */
  evidence: string;
  /**
   * Ranked roughly by the measured share of flagged links that are broken, and
   * used for one thing only: when every candidate a headword has is flagged,
   * the build keeps the lowest total weight. Without it a headword whose whole
   * pool is flagged keeps an arbitrary member of it, and `室先生住在北京。`
   * wins a coin toss against a merely buried headword.
   */
  weight: number;
  test: (c: CandidateLink) => boolean;
}

/**
 * Every rule the build applies, in the order a reader should meet them. A link
 * flagged by any `hard` rule is excluded while an unflagged candidate exists;
 * `soft` rules break the remaining tie the same way, one fallback later.
 */
export const EXCLUSION_RULES: readonly ExclusionRule[] = [
  {
    id: "headword-used-as-name",
    tier: "hard",
    rule: "The headword is immediately followed by a personal title, or preceded by 姓 or 叫 — it has been pressed into service as a surname.",
    evidence: "18 of 18 flagged sample links are broken (100%), against a 12.85% corpus base rate.",
    weight: 8,
    test: (c) => usedAsName(c.hanzi, c.headword),
  },
  {
    id: "slot-easy",
    tier: "hard",
    rule: "The sentence grades below the headword's own band, so the headword is the hardest thing in it and everything around it is filler.",
    evidence: "13 of 16 flagged sample links are broken (81%).",
    weight: 6,
    test: (c) => c.slot === "easy",
  },
  {
    id: "headword-not-discrete-token",
    tier: "hard",
    rule: "The headword does not survive canon segmentation as its own token: it is buried inside a longer HSK word, and the sentence teaches that word instead.",
    evidence: "30 of 48 flagged sample links are broken (63%).",
    weight: 5,
    test: (c) => !c.words.includes(c.headword),
  },
  {
    id: "headword-buried-in-compound",
    tier: "hard",
    rule: "Same test against CC-CEDICT's 120,400 headwords rather than the 11,092 HSK ones: 训 inside 校训, 焊 inside 焊接, 知识 inside 知识分子 — compounds the canon is too small to see.",
    evidence: "39 of 81 flagged sample links are broken (48%); it flags 33 links the canon test misses, 9 of them broken (27%).",
    weight: 4,
    test: (c) => !c.cedictTokens.has(c.headword),
  },
  {
    id: "headword-reading-mismatch",
    tier: "hard",
    rule: "The sentence's own pinyin reads the headword as a different word — 担 as dàn not dān, 地 as dì not de, 正 as zhēng not zhèng.",
    evidence: "11 of 21 flagged sample links are broken (52%); 10 of 16 among single-character headwords (63%).",
    weight: 4,
    test: (c) =>
      [...c.headword].length === 1 &&
      readingMismatch(c.hanzi, c.pinyinNumbered, c.headword, c.headwordPinyinNumbered),
  },
  {
    id: "sentence-short-for-band",
    tier: "soft",
    rule: "The sentence is in the bottom decile of length for its own grade band — a frame with the headword dropped into it rather than a sentence about anything. 这是自助。 是 five characters.",
    evidence: "8 of 27 flagged sample links are broken (30%) among multi-character headwords, against 5.6% for the rest.",
    weight: 2,
    test: (c) => c.charLengthPercentilePct <= 10,
  },
  {
    id: "frame-shared-with-other-headwords",
    tier: "soft",
    rule: "Blank the headword out and the same sentence is filed under another headword too: it is a template the source stamped across the word list, not a sentence written for this word.",
    evidence: "Among single-character headwords that clear every hard rule, 10 of 16 links on a shared frame are broken (63%) against 11 of 67 on a unique one (16%).",
    weight: 2,
    test: (c) => c.frameHeadwordCount >= 2,
  },
];

/** Which rules flag this candidate, in `EXCLUSION_RULES` order. */
export function excludedBy(c: CandidateLink): string[] {
  return EXCLUSION_RULES.filter((r) => r.test(c)).map((r) => r.id);
}

/** Total weight of the rules flagging this candidate. Zero for a clean one. */
export function riskWeightOf(hits: readonly string[]): number {
  let weight = 0;
  for (const rule of EXCLUSION_RULES) if (hits.includes(rule.id)) weight += rule.weight;
  return weight;
}

/* -------------------------------------------------------------------------- */
/* Policies                                                                    */
/* -------------------------------------------------------------------------- */

export interface Policy {
  id: string;
  description: string;
  predictors: string[];
  /**
   * Never strip a headword's last surviving link. Coverage is the corpus's
   * headline claim; a filter that takes it apart to buy two points of accuracy
   * is usually the wrong trade, and this rule makes that choice explicit rather
   * than accidental. The link kept is the lowest-risk one, ties broken by id.
   */
  keepLastLink: boolean;
}

const SURGICAL = ["headword-used-as-name", "slot-easy", "headword-not-discrete-token"];

export const POLICIES: readonly Policy[] = [
  { id: "none", description: "Ship everything. The status quo.", predictors: [], keepLastLink: false },
  {
    id: "surgical",
    description:
      "Drop only the three highest-precision signals: the headword used as a name, an " +
      "`easy` link, and a headword that does not survive segmentation. No coverage " +
      "protection — included to price what the coverage protection is worth.",
    predictors: SURGICAL,
    keepLastLink: false,
  },
  {
    id: "surgical-keep-last",
    description: "`surgical`, but never strip a headword's last sentence.",
    predictors: SURGICAL,
    keepLastLink: true,
  },
  {
    id: "balanced",
    description:
      "`surgical-keep-last` plus every single-character headword link. The recommended " +
      "policy: it removes the two things the labels actually convict — a headword used " +
      "wrongly, and a headword too short to build a sentence around — and nothing else.",
    predictors: [...SURGICAL, "headword-single-char"],
    keepLastLink: true,
  },
  {
    id: "strict",
    description:
      "`balanced` plus sentences in the bottom sixth of length for their own band.",
    predictors: [...SURGICAL, "headword-single-char", "sentence-short-for-band"],
    keepLastLink: true,
  },
  {
    id: "aggressive",
    description: "`strict` plus every sentence of eight characters or fewer.",
    predictors: [...SURGICAL, "headword-single-char", "sentence-short-for-band", "sentence-very-short"],
    keepLastLink: true,
  },
  {
    id: "single-char-hard-drop",
    description:
      "Drop every single-character-headword link with no coverage protection. Included to " +
      "price the coverage protection on the predictor that does the most work.",
    predictors: ["headword-single-char"],
    keepLastLink: false,
  },
  {
    id: "bands-1-6",
    description:
      "Ship bands 1-6 and drop band 7 entirely. The simple option the brief asked to be " +
      "evaluated. Coverage protection is meaningless here: the point is to remove headwords.",
    predictors: ["headword-band-7"],
    keepLastLink: false,
  },
  {
    id: "bands-1-6-surgical",
    description: "`bands-1-6` plus the surgical drops on what remains.",
    predictors: ["headword-band-7", ...SURGICAL],
    keepLastLink: false,
  },
];

export function policyPredicate(policy: Policy): (f: LinkFeatures) => boolean {
  const tests = policy.predictors.map((id) => {
    const p = PREDICTORS.find((q) => q.id === id);
    if (p === undefined) {
      throw new Error(
        `quality: policy "${policy.id}" names unknown predictor "${id}". ` +
          `Known: ${PREDICTORS.map((q) => q.id).join(", ")}.`,
      );
    }
    return p.test;
  });
  return (f) => tests.some((t) => t(f));
}

/**
 * Apply a policy. Returns the set of excluded link ids — never a mutated
 * corpus, because deciding what to drop and actually dropping it are different
 * commitments and only the first one is this file's to make.
 */
export function applyPolicy(policy: Policy, features: readonly LinkFeatures[]): Set<string> {
  const predicate = policyPredicate(policy);
  const excluded = new Set<string>();
  for (const f of features) if (predicate(f)) excluded.add(f.linkId);
  if (!policy.keepLastLink) return excluded;

  const byWord = new Map<string, LinkFeatures[]>();
  for (const f of features) {
    const bucket = byWord.get(f.wordId);
    if (bucket === undefined) byWord.set(f.wordId, [f]);
    else bucket.push(f);
  }
  for (const bucket of byWord.values()) {
    if (!bucket.every((f) => excluded.has(f.linkId))) continue;
    let keep = bucket[0];
    if (keep === undefined) continue;
    let keepScore = riskScore(keep);
    for (const f of bucket) {
      const score = riskScore(f);
      if (score < keepScore || (score === keepScore && f.linkId < keep.linkId)) {
        keep = f;
        keepScore = score;
      }
    }
    excluded.delete(keep.linkId);
  }
  return excluded;
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

interface WeightedLabel {
  label: JudgedLink;
  features: LinkFeatures;
  /** Population links this labelled link stands for. */
  weight: number;
  broken: boolean;
}

export interface PredictorScore {
  id: string;
  hypothesis: string;
  populationFlagged: number;
  populationFlaggedPct: number;
  sampleFlagged: number;
  sampleFlaggedBroken: number;
  /** Weighted, so these are corpus numbers rather than sample numbers. */
  precision: number;
  precisionCi95: Interval;
  recall: number;
  f1: number;
  /** Precision divided by the corpus-wide broken rate. Below 1 means anti-predictive. */
  lift: number;
  residualBrokenRateIfDropped: number;
  headwordCoverageIfDropped: number;
}

export interface PolicyScore {
  id: string;
  description: string;
  predictors: string[];
  keepLastLink: boolean;
  linksDropped: number;
  linksDroppedPct: number;
  sentencesDropped: number;
  precision: number;
  recall: number;
  sampleDropped: number;
  sampleDroppedBroken: number;
  residualBrokenRate: number;
  residualBrokenCi95: Interval;
  residualNotCleanRate: number;
  headwordsCovered: number;
  headwordCoveragePct: number;
  sentencesPerHeadword: Record<string, number>;
  exclusionsSha256: string;
}

function digestOf(linkIds: readonly string[]): string {
  const sorted = linkIds.slice().sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 16);
}

/**
 * Corpus-wide rate over whatever subset of links survives, estimated by
 * post-stratification: within each stratum, the surviving sampled links stand
 * for the surviving population links. This is the only honest way to price a
 * filter, because a filter changes the composition of the corpus and a raw
 * sample mean would be measuring the wrong population afterwards.
 */
function residualRate(
  features: readonly LinkFeatures[],
  excluded: ReadonlySet<string>,
  labels: readonly WeightedLabel[],
  isDefect: (l: WeightedLabel) => boolean,
): { rate: number; ci95: Interval } {
  const survivingPopulation = new Map<string, number>();
  for (const f of features) {
    if (excluded.has(f.linkId)) continue;
    survivingPopulation.set(f.stratum, (survivingPopulation.get(f.stratum) ?? 0) + 1);
  }
  const tallies = STRATA.map((stratum) => {
    const population = survivingPopulation.get(stratum) ?? 0;
    const kept = labels.filter((l) => l.features.stratum === stratum && !excluded.has(l.features.linkId));
    return { population, n: kept.length, successes: kept.filter(isDefect).length };
  }).filter((t) => t.population > 0);
  const estimate = stratifiedEstimate(tallies);
  return { rate: estimate.estimate, ci95: estimate.ci95 };
}

function scorePolicy(
  policy: Policy,
  features: readonly LinkFeatures[],
  labels: readonly WeightedLabel[],
  weightBroken: number,
): PolicyScore {
  const excluded = applyPolicy(policy, features);
  const surviving = features.filter((f) => !excluded.has(f.linkId));

  const droppedSentences = new Set<string>();
  const keptSentences = new Set<string>();
  for (const f of features) {
    if (excluded.has(f.linkId)) droppedSentences.add(f.sentenceId);
    else keptSentences.add(f.sentenceId);
  }
  for (const id of keptSentences) droppedSentences.delete(id);

  const perHeadword = new Map<string, number>();
  for (const f of surviving) perHeadword.set(f.wordId, (perHeadword.get(f.wordId) ?? 0) + 1);
  const sentencesPerHeadword: Record<string, number> = { "0": CANON_ROWS - perHeadword.size };
  for (const count of perHeadword.values()) {
    const key = String(Math.min(count, 3));
    sentencesPerHeadword[key] = (sentencesPerHeadword[key] ?? 0) + 1;
  }

  let flaggedWeight = 0;
  let truePositiveWeight = 0;
  let sampleDropped = 0;
  let sampleDroppedBroken = 0;
  for (const l of labels) {
    if (!excluded.has(l.features.linkId)) continue;
    flaggedWeight += l.weight;
    sampleDropped += 1;
    if (l.broken) {
      truePositiveWeight += l.weight;
      sampleDroppedBroken += 1;
    }
  }

  const broken = residualRate(features, excluded, labels, (l) => l.broken);
  const notClean = residualRate(features, excluded, labels, (l) => l.label.verdict !== "good");

  return {
    id: policy.id,
    description: policy.description,
    predictors: policy.predictors,
    keepLastLink: policy.keepLastLink,
    linksDropped: excluded.size,
    linksDroppedPct: features.length === 0 ? 0 : excluded.size / features.length,
    sentencesDropped: droppedSentences.size,
    precision: flaggedWeight === 0 ? 0 : truePositiveWeight / flaggedWeight,
    recall: weightBroken === 0 ? 0 : truePositiveWeight / weightBroken,
    sampleDropped,
    sampleDroppedBroken,
    residualBrokenRate: broken.rate,
    residualBrokenCi95: broken.ci95,
    residualNotCleanRate: notClean.rate,
    headwordsCovered: perHeadword.size,
    headwordCoveragePct: perHeadword.size / CANON_ROWS,
    sentencesPerHeadword,
    exclusionsSha256: digestOf([...excluded]),
  };
}

/* -------------------------------------------------------------------------- */
/* Held-out validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The predictors were written as hypotheses before the labels existed, so their
 * individual scores are not fitted and use all 600 labels. The *choice* of
 * which ones to union into `recommended` was made by looking at those scores,
 * which is fitting, so the recommended policy is also scored on a half of the
 * labels it was not chosen on. The split alternates within each stratum, so
 * both halves keep the sampling design.
 */
function splitLabels(labels: readonly WeightedLabel[]): { fit: WeightedLabel[]; holdout: WeightedLabel[] } {
  const fit: WeightedLabel[] = [];
  const holdout: WeightedLabel[] = [];
  const seen = new Map<string, number>();
  for (const l of labels.slice().sort((a, b) => (a.features.linkId < b.features.linkId ? -1 : 1))) {
    const index = seen.get(l.features.stratum) ?? 0;
    seen.set(l.features.stratum, index + 1);
    if (index % 2 === 0) fit.push(l);
    else holdout.push(l);
  }
  return { fit, holdout };
}

interface HalfScore {
  n: number;
  broken: number;
  precision: number;
  precisionCi95: Interval;
  recall: number;
  residualBrokenRate: number;
}

function scoreHalf(
  features: readonly LinkFeatures[],
  excluded: ReadonlySet<string>,
  half: readonly WeightedLabel[],
): HalfScore {
  let flagged = 0;
  let truePositive = 0;
  let brokenWeight = 0;
  let flaggedCount = 0;
  let flaggedBrokenCount = 0;
  for (const l of half) {
    if (l.broken) brokenWeight += l.weight;
    if (!excluded.has(l.features.linkId)) continue;
    flagged += l.weight;
    flaggedCount += 1;
    if (l.broken) {
      truePositive += l.weight;
      flaggedBrokenCount += 1;
    }
  }
  const residual = residualRate(features, excluded, half, (l) => l.broken);
  return {
    n: half.length,
    broken: half.filter((l) => l.broken).length,
    precision: flagged === 0 ? 0 : truePositive / flagged,
    precisionCi95: wilson(flaggedBrokenCount, flaggedCount),
    recall: brokenWeight === 0 ? 0 : truePositive / brokenWeight,
    residualBrokenRate: residual.rate,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export interface QualityReport extends QualityReportJudgeSection {
  filter: {
    generator: string;
    note: string;
    corpusWideBrokenRate: number;
    predictors: PredictorScore[];
    policies: PolicyScore[];
    heldOut: {
      method: string;
      policyId: string;
      fit: HalfScore;
      holdout: HalfScore;
    };
    recommendation: {
      policyId: string;
      summary: string;
      rationale: string[];
      rejected: { policyId: string; because: string }[];
      disclosure: string;
    };
    decision: {
      policyId: string;
      keepLastLink: boolean;
      predictors: { id: string; rule: string }[];
      excludedLinks: number;
      exclusionsSha256: string;
      howToApply: string;
    };
  };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/* -------------------------------------------------------------------------- */
/* Re-measurement                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `--remeasure` judges a fresh stratified sample of the corpus as it stands now
 * and writes the result into `data/sentence-stats.json`.
 *
 * It exists because the filter moved the thing being measured. The 600 labels
 * in `data/quality-report.json` describe the corpus that shipped before the
 * gate above existed: 11,308 of those links are no longer in the corpus, and
 * the ones that remain are exactly the links the gate did not touch, so scoring
 * the new corpus on them would be scoring a filter on the sample it was fitted
 * to. A new seed and a new draw is the only honest answer.
 *
 * Everything about the instrument is `quality-judge.ts`'s: the same prompt, the
 * same model, the same temperature, the same stratification, the same
 * estimator. Only the seed and the corpus differ, so the number that comes back
 * is comparable to the 12.85% it is being compared against.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx src/build/quality.ts --remeasure \
 *     [--seed zhongdex-quality-v2] [--n 600] [--model gemini-3.7-flash] \
 *     [--concurrency 8] [--emit-labels out.json]
 */

const REMEASURE_SEED = "zhongdex-quality-v2";
const REMEASURE_MODEL = "gemini-3.7-flash";
const SENTENCE_STATS_JSON = "data/sentence-stats.json";
/** The same default path `readCorpus()` reads; needed here for its digest. */
const SENTENCES_JSONL = "data/sentences.jsonl";

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  onProgress: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await worker(item);
      done += 1;
      onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  return out;
}

async function remeasure(argv: readonly string[]): Promise<void> {
  const seed = arg(argv, "--seed") ?? REMEASURE_SEED;
  const model = arg(argv, "--model") ?? REMEASURE_MODEL;
  const size = Number(arg(argv, "--n") ?? 600);
  const floor = Number(arg(argv, "--floor") ?? 40);
  const concurrency = Number(arg(argv, "--concurrency") ?? 8);
  const emitLabels = arg(argv, "--emit-labels");
  const fromLabels = arg(argv, "--from-labels");
  if (!Number.isFinite(size) || size <= 0) throw new Error("quality: --n must be a positive integer");

  const corpusText = readFileSync(SENTENCES_JSONL, "utf8");
  const corpus = readCorpus();
  const canon = readCanon();
  const links = buildLinks(corpus, canon);
  const headwords = new Set(links.map((l) => l.wordId));
  log(`quality: frame ${corpus.length} sentences, ${links.length} links, ${headwords.size} headwords`);

  const sample = drawSample(links, size, floor, seed);
  log(
    `quality: drawn ${sample.links.length} links across ${sample.allocations.length} strata` +
      ` (seed "${seed}") — judging with ${model} at concurrency ${concurrency}`,
  );

  // `--from-labels` re-derives the summary from labels an earlier run wrote,
  // without spending the calls again. The draw is the same because the seed is
  // the same, so this is an aggregation, not a second measurement — and it lets
  // anyone recompute every number below from the raw labels.
  let failures = 0;
  let tokensUsed: number | null = null;
  let labels: JudgedLink[];
  if (fromLabels !== undefined) {
    const saved = JSON.parse(readFileSync(fromLabels, "utf8")) as {
      labels?: JudgedLink[];
      totalTokens?: number;
    };
    labels = saved.labels ?? [];
    tokensUsed = saved.totalTokens ?? null;
    const drawn = new Set(sample.links.map((l) => l.linkId));
    const stray = labels.filter((l) => !drawn.has(l.linkId)).length;
    if (stray > 0) {
      throw new Error(
        `quality: ${stray} of the ${labels.length} labels in ${fromLabels} are not in the ` +
          `sample seed "${seed}" draws. They were judged on a different draw or a different ` +
          `corpus. Next: npm run quality:remeasure -- --seed <the seed those labels used>`,
      );
    }
    log(`quality: re-aggregating ${labels.length} labels from ${fromLabels}, no model calls`);
  } else {
    const client = geminiClient(model, resolveApiKey(process.env));
    const judged = await runPool(
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
    labels = judged.filter((j): j is JudgedLink => j !== null);
    tokensUsed = client.tokensUsed();
  }
  if (labels.length === 0) throw new Error("quality: the judge returned no labels at all");

  const populations = new Map(sample.allocations.map((a) => [a.stratum, a.population]));
  const byStratum = STRATA.filter((s) => (populations.get(s) ?? 0) > 0).map((s) => {
    const kept = labels.filter((l) => l.stratum === s);
    return {
      stratum: s,
      population: populations.get(s) ?? 0,
      n: kept.length,
      broken: kept.filter((l) => l.verdict === "broken").length,
      notClean: kept.filter((l) => l.verdict !== "good").length,
    };
  });
  const broken = stratifiedEstimate(
    byStratum.map((t) => ({ population: t.population, n: t.n, successes: t.broken })),
  );
  const notClean = stratifiedEstimate(
    byStratum.map((t) => ({ population: t.population, n: t.n, successes: t.notClean })),
  );

  /**
   * A breakdown by one axis. The rate is population-weighted across the strata
   * inside the group, not a raw sample mean: the sample deliberately
   * over-samples the small strata, so a mean over it would answer a question
   * about the sample rather than about the corpus.
   */
  const group = (
    stratumKeyOf: (s: string) => string,
  ): { group: string; population: number; n: number; broken: number; brokenRate: number }[] => {
    const keys = [...new Set(byStratum.map((t) => stratumKeyOf(t.stratum)))].sort();
    return keys.map((key) => {
      const inside = byStratum.filter((t) => stratumKeyOf(t.stratum) === key);
      const estimate = stratifiedEstimate(
        inside.map((t) => ({ population: t.population, n: t.n, successes: t.broken })),
      );
      return {
        group: key,
        population: inside.reduce((sum, t) => sum + t.population, 0),
        n: inside.reduce((sum, t) => sum + t.n, 0),
        broken: inside.reduce((sum, t) => sum + t.broken, 0),
        brokenRate: estimate.estimate,
      };
    });
  };
  const byLength = group((s) => s.slice(s.indexOf("-len") + 4));
  const byBand = group((s) => s.slice(1, s.indexOf("-len")));

  const flagNames = ["grammatical", "semanticallySensible", "headwordNatural", "nativeWouldWrite"] as const;
  const byFlag: Record<string, { failed: number; n: number; rate: number }> = {};
  for (const flag of flagNames) {
    const failed = labels.filter((l) => !l[flag]).length;
    byFlag[flag] = { failed, n: labels.length, rate: labels.length === 0 ? 0 : failed / labels.length };
  }

  let baseline = "";
  try {
    const previous = JSON.parse(readFileSync(QUALITY_REPORT_JSON, "utf8")) as QualityReportJudgeSection;
    baseline =
      `The same instrument on the corpus that shipped before the quality gate measured ` +
      `${pct(previous.results.corpusWide.brokenRate)} broken ` +
      `(95% CI ${pct(previous.results.corpusWide.brokenCi95.low)}-` +
      `${pct(previous.results.corpusWide.brokenCi95.high)}, n=${previous.sampling.judged}, ` +
      `seed "${previous.sampling.seed}"), with ` +
      `${pct(previous.results.corpusWide.notCleanRate - previous.results.corpusWide.brokenRate)} ` +
      `further awkward. This measurement is a fresh draw on a new seed against the filtered ` +
      `corpus, so it is like-for-like on everything but the corpus and the seed.`;
  } catch {
    baseline = "No earlier measurement was readable at data/quality-report.json.";
  }

  const measurement: SentenceQualityMeasurement = {
    note:
      "A judged defect rate for exactly this corpus. Same prompt, model, temperature, " +
      "stratification and estimator as data/quality-report.json; a new seed, because the " +
      "filter this corpus was built with was chosen partly by looking at the old sample. " +
      "Re-run with `npx tsx src/build/quality.ts --remeasure`.",
    generator: "src/build/quality.ts --remeasure",
    corpusSha256: createHash("sha256").update(corpusText, "utf8").digest("hex"),
    judge: {
      provider: "google-generative-language",
      model,
      temperature: 0,
      promptSha256: createHash("sha256").update(JUDGE_PROMPT, "utf8").digest("hex"),
      totalTokens: tokensUsed,
      failures,
    },
    sampling: {
      unit: "headword link (one sentence paired with one canon headword it was selected for)",
      design:
        "Stratified random sample. Strata are HSK band group of the headword (1-3 / 4-6 / 7) " +
        "crossed with headword character length (1 / 2 / 3+). Allocation is a floor per " +
        "stratum plus the remainder proportional to stratum population; corpus-wide rates " +
        "are population-weighted with a finite-population correction.",
      seed,
      seedInt: sample.seedInt,
      requested: size,
      judged: labels.length,
      frame: { sentences: corpus.length, links: links.length, headwords: headwords.size },
      strata: byStratum.map((t) => ({
        stratum: t.stratum,
        population: t.population,
        weight: links.length === 0 ? 0 : t.population / links.length,
        n: t.n,
      })),
    },
    results: {
      definition:
        "broken = the judge says the sentence is ungrammatical, incoherent, or misuses the " +
        "headword. awkward = parseable but stilted. good = natural Mandarin. notClean = " +
        "broken + awkward.",
      corpusWide: {
        brokenRate: broken.estimate,
        brokenCi95: broken.ci95,
        notCleanRate: notClean.estimate,
        notCleanCi95: notClean.ci95,
      },
      byHeadwordLength: byLength.map((g) => ({
        lenGroup: g.group,
        population: g.population,
        n: g.n,
        broken: g.broken,
        brokenRate: g.brokenRate,
      })),
      byBandGroup: byBand.map((g) => ({
        bandGroup: g.group,
        population: g.population,
        n: g.n,
        broken: g.broken,
        brokenRate: g.brokenRate,
      })),
      byFlag,
    },
    comparison: baseline,
  };

  const stats = JSON.parse(readFileSync(SENTENCE_STATS_JSON, "utf8")) as Record<string, unknown>;
  stats["measuredQuality"] = measurement;
  writeFileSync(SENTENCE_STATS_JSON, `${JSON.stringify(stats, null, 2)}\n`);
  log("");
  log(
    `quality: broken ${pct(broken.estimate)} (95% CI ${pct(broken.ci95.low)}-${pct(broken.ci95.high)})` +
      `, notClean ${pct(notClean.estimate)}, n=${labels.length}, seed "${seed}"`,
  );
  for (const g of byLength) {
    log(`  headword length ${g.group.padEnd(3)} ${g.broken}/${g.n} broken (${pct(g.brokenRate)}), population ${g.population}`);
  }
  for (const g of byBand) {
    log(`  band group ${g.group.padEnd(4)} ${g.broken}/${g.n} broken (${pct(g.brokenRate)}), population ${g.population}`);
  }
  log(`quality: wrote measuredQuality into ${SENTENCE_STATS_JSON}`);
  if (emitLabels !== undefined) {
    writeFileSync(
      emitLabels,
      `${JSON.stringify(
        { schema: "zhongdex/quality-labels/v1", seed, model, totalTokens: tokensUsed, labels },
        null,
        2,
      )}\n`,
    );
    log(`quality: wrote ${labels.length} labels to ${emitLabels}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--remeasure")) {
    await remeasure(argv);
    return;
  }
  const chosenId = arg(argv, "--policy") ?? "balanced";
  const emitTo = arg(argv, "--emit-exclusions");

  let judged: QualityReportJudgeSection;
  try {
    judged = JSON.parse(readFileSync(QUALITY_REPORT_JSON, "utf8")) as QualityReportJudgeSection;
  } catch {
    throw new Error(
      `quality: no judged labels at ${QUALITY_REPORT_JSON}. The filter is scored against ` +
        `them and there is nothing to score without them. ` +
        `Next: GEMINI_API_KEY=... npm run judge:quality`,
    );
  }
  if (judged.labels === undefined || judged.labels.length === 0) {
    throw new Error(`quality: ${QUALITY_REPORT_JSON} carries no labels. Next: npm run judge:quality`);
  }

  const corpusPath = arg(argv, "--corpus") ?? SENTENCES_JSONL;
  const corpus = readCorpus(corpusPath);
  const canon = readCanon();
  const features = buildFeatures(corpus, canon);
  const byLinkId = new Map(features.map((f) => [f.linkId, f]));

  const stratumWeight = new Map<string, number>();
  for (const s of judged.sampling.strata) {
    if (s.n > 0) stratumWeight.set(s.stratum, s.population / s.n);
  }
  const labels: WeightedLabel[] = [];
  for (const label of judged.labels) {
    const f = byLinkId.get(`${label.sentenceId}|${label.wordId}`);
    const weight = stratumWeight.get(label.stratum);
    if (f === undefined || weight === undefined) continue;
    labels.push({ label, features: f, weight, broken: label.verdict === "broken" });
  }
  if (labels.length !== judged.labels.length) {
    const missing = judged.labels.length - labels.length;
    throw new Error(
      `quality: ${missing} of ${judged.labels.length} judged links are not in ${corpusPath}.\n` +
        `  This tool scores a corpus against labels drawn from that same corpus, and these\n` +
        `  labels describe a different one — most likely the corpus that shipped before the\n` +
        `  build-time quality gate in this file, which removes links by design.\n` +
        `  Next: npm run quality:remeasure  (draws and judges a fresh sample of the corpus\n` +
        `  as it stands, on a new seed, and writes the result to data/sentence-stats.json)\n` +
        `  or:   npx tsx src/build/quality.ts --corpus <the corpus the labels were drawn on>`,
    );
  }

  let weightTotal = 0;
  let weightBroken = 0;
  for (const l of labels) {
    weightTotal += l.weight;
    if (l.broken) weightBroken += l.weight;
  }
  const baseRate = weightTotal === 0 ? 0 : weightBroken / weightTotal;
  log(`quality: ${labels.length} labels, corpus-wide broken ${pct(baseRate)}, ${features.length} links`);

  /* Per-predictor scores. These are a priori predictors, so all 600 labels. */
  const predictorScores: PredictorScore[] = PREDICTORS.map((p) => {
    const flaggedFeatures = features.filter((f) => p.test(f));
    const excluded = new Set(flaggedFeatures.map((f) => f.linkId));
    let flaggedWeight = 0;
    let truePositiveWeight = 0;
    let sampleFlagged = 0;
    let sampleFlaggedBroken = 0;
    for (const l of labels) {
      if (!p.test(l.features)) continue;
      flaggedWeight += l.weight;
      sampleFlagged += 1;
      if (l.broken) {
        truePositiveWeight += l.weight;
        sampleFlaggedBroken += 1;
      }
    }
    const precision = flaggedWeight === 0 ? 0 : truePositiveWeight / flaggedWeight;
    const recall = weightBroken === 0 ? 0 : truePositiveWeight / weightBroken;
    const keptWords = new Set(features.filter((f) => !excluded.has(f.linkId)).map((f) => f.wordId));
    return {
      id: p.id,
      hypothesis: p.hypothesis,
      populationFlagged: flaggedFeatures.length,
      populationFlaggedPct: flaggedFeatures.length / features.length,
      sampleFlagged,
      sampleFlaggedBroken,
      precision,
      precisionCi95: wilson(sampleFlaggedBroken, sampleFlagged),
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      lift: baseRate === 0 ? 0 : precision / baseRate,
      residualBrokenRateIfDropped: residualRate(features, excluded, labels, (l) => l.broken).rate,
      headwordCoverageIfDropped: keptWords.size / CANON_ROWS,
    };
  });

  log("");
  log(
    `  ${"predictor".padEnd(28)} ${"drop".padStart(6)} ${"prec".padStart(6)} ${"rec".padStart(6)}` +
      ` ${"lift".padStart(5)} ${"resid".padStart(7)} ${"cov".padStart(7)}  n/broken`,
  );
  for (const s of predictorScores) {
    log(
      `  ${s.id.padEnd(28)} ${pct(s.populationFlaggedPct).padStart(6)} ${s.precision.toFixed(3).padStart(6)}` +
        ` ${s.recall.toFixed(3).padStart(6)} ${s.lift.toFixed(2).padStart(5)}` +
        ` ${pct(s.residualBrokenRateIfDropped).padStart(7)} ${pct(s.headwordCoverageIfDropped).padStart(7)}` +
        `  ${s.sampleFlagged}/${s.sampleFlaggedBroken}`,
    );
  }

  /* Policies. */
  const policyScores = POLICIES.map((p) => scorePolicy(p, features, labels, weightBroken));
  log("");
  log(
    `  ${"policy".padEnd(24)} ${"drop".padStart(7)} ${"prec".padStart(6)} ${"rec".padStart(6)}` +
      ` ${"residual broken".padStart(24)} ${"coverage".padStart(9)}`,
  );
  for (const s of policyScores) {
    log(
      `  ${s.id.padEnd(24)} ${pct(s.linksDroppedPct).padStart(7)} ${s.precision.toFixed(3).padStart(6)}` +
        ` ${s.recall.toFixed(3).padStart(6)}` +
        ` ${`${pct(s.residualBrokenRate)} [${pct(s.residualBrokenCi95.low)}-${pct(s.residualBrokenCi95.high)}]`.padStart(24)}` +
        ` ${pct(s.headwordCoveragePct).padStart(9)}`,
    );
  }

  const chosen = POLICIES.find((p) => p.id === chosenId);
  if (chosen === undefined) {
    throw new Error(
      `quality: no policy "${chosenId}". Known: ${POLICIES.map((p) => p.id).join(", ")}. ` +
        `Next: npx tsx src/build/quality.ts --policy balanced`,
    );
  }
  const chosenScore = policyScores.find((p) => p.id === chosenId);
  if (chosenScore === undefined) throw new Error(`quality: policy "${chosenId}" was not scored`);
  const excluded = applyPolicy(chosen, features);

  const { fit, holdout } = splitLabels(labels);
  const heldOut = {
    method:
      "Labels split by alternating within each stratum, so both halves keep the sampling " +
      "design. The individual predictors are a priori and are scored on all labels; the " +
      "union that makes up the recommended policy was chosen by looking at those scores, " +
      "so it is re-scored here on a half it was not chosen on.",
    policyId: chosen.id,
    fit: scoreHalf(features, excluded, fit),
    holdout: scoreHalf(features, excluded, holdout),
  };
  log("");
  log(
    `  held-out ${chosen.id}: precision ${heldOut.holdout.precision.toFixed(3)}` +
      ` (fit ${heldOut.fit.precision.toFixed(3)}), recall ${heldOut.holdout.recall.toFixed(3)}` +
      ` (fit ${heldOut.fit.recall.toFixed(3)})`,
  );

  const bands16 = policyScores.find((p) => p.id === "bands-1-6");
  const strict = policyScores.find((p) => p.id === "strict");

  /**
   * What the next rule up actually buys. `strict` differs from `balanced` by one
   * predictor, so the honest way to price it is the precision of the links only
   * `strict` drops — not the precision of the whole union, which the strong
   * predictors inside it flatter.
   */
  /** The single-character rate inside each band group, straight from the strata. */
  const singleCharByBand = ["1-3", "4-6", "7"]
    .map((g) => {
      const t = judged.results.byStratum.find((x) => x.stratum === `b${g}-len1`);
      return t === undefined ? null : `${pct(t.brokenRate)} at band ${g}`;
    })
    .filter((x): x is string => x !== null)
    .join(", ");

  const strictOnly = (() => {
    const balancedExcluded = applyPolicy(
      POLICIES.find((p) => p.id === "balanced") ?? chosen,
      features,
    );
    const strictExcluded = applyPolicy(POLICIES.find((p) => p.id === "strict") ?? chosen, features);
    const marginal = labels.filter(
      (l) => strictExcluded.has(l.features.linkId) && !balancedExcluded.has(l.features.linkId),
    );
    const broken = marginal.filter((l) => l.broken).length;
    return {
      sampleLinks: marginal.length,
      sampleBroken: broken,
      precision: marginal.length === 0 ? 0 : broken / marginal.length,
      precisionCi95: wilson(broken, marginal.length),
      populationLinks:
        [...strictExcluded].filter((id) => !balancedExcluded.has(id)).length,
    };
  })();
  log(
    `  strict-only margin: ${strictOnly.sampleBroken}/${strictOnly.sampleLinks} sampled links` +
      ` broken (${strictOnly.precision.toFixed(3)}), against a sample base rate of` +
      ` ${(labels.filter((l) => l.broken).length / labels.length).toFixed(3)}`,
  );

  const surgical = policyScores.find((p) => p.id === "surgical-keep-last");
  const hardDrop = policyScores.find((p) => p.id === "single-char-hard-drop");
  const aggressive = policyScores.find((p) => p.id === "aggressive");

  const report: QualityReport = {
    ...judged,
    filter: {
      generator: "src/build/quality.ts",
      note:
        "Computable predictors of brokenness, each scored against the judged labels above, " +
        "and the filter policies built from them. Every rate is weighted by stratum " +
        "population; the raw sample over-samples the small strata on purpose. Nothing here " +
        "modifies data/sentences.jsonl.",
      corpusWideBrokenRate: baseRate,
      predictors: predictorScores,
      policies: policyScores,
      heldOut,
      recommendation: {
        policyId: chosen.id,
        summary:
          `Apply "${chosen.id}": drop the ${chosenScore.linksDropped} links ` +
          `(${pct(chosenScore.linksDroppedPct)}) it selects, never strip a headword's last ` +
          `sentence, and ship the disclosure below anyway. Broken falls from ${pct(baseRate)} ` +
          `to ${pct(chosenScore.residualBrokenRate)} and headword coverage does not move: ` +
          `${pct(chosenScore.headwordCoveragePct)}, the same ${chosenScore.headwordsCovered} ` +
          `of ${CANON_ROWS} canon rows the corpus covers today.`,
        rationale: [
          `The rate is worse than the 42-sentence read suggested. Measured: ${pct(baseRate)} ` +
            `broken (95% CI ${pct(judged.results.corpusWide.brokenCi95.low)}-` +
            `${pct(judged.results.corpusWide.brokenCi95.high)}) against an eyeball estimate of ` +
            `8-10%, plus a further ` +
            `${pct(judged.results.corpusWide.notCleanRate - baseRate)} awkward-but-parseable. ` +
            `And ${pct(baseRate)} is a floor, not a point: on the six hand-found defects the ` +
            `judge grades ${Math.round((1 - judged.goldSet.brokenRecall) * 6)} of them ` +
            `"awkward" rather than "broken", so it under-calls severity in the direction that ` +
            `flatters the corpus.`,
          `The failure axis is headword LENGTH, not band. Single-character headwords are ` +
            `${pct(predictorScores.find((p) => p.id === "headword-single-char")?.precision ?? 0)} ` +
            `broken against a ${pct(baseRate)} base rate — ${singleCharByBand}, so the effect ` +
            `holds at every level. Band 7 itself is ` +
            `${pct(predictorScores.find((p) => p.id === "headword-band-7")?.precision ?? 0)} ` +
            `broken, which is BELOW the base rate: it is anti-predictive. The prior that band 7 ` +
            `is the problem does not survive contact with the labels, and it survived this long ` +
            `because band 7 is half the corpus, so half the defects are in it by arithmetic.`,
          `Keeping each headword's last sentence is what makes the filter affordable. The same ` +
            `single-character drop costs ${pct(1 - (hardDrop?.headwordCoveragePct ?? 0))} of ` +
            `headword coverage without that rule and nothing with it, for a residual the ` +
            `sample cannot tell apart — ${pct(hardDrop?.residualBrokenRate ?? 0)} against ` +
            `${pct(chosenScore.residualBrokenRate)}, on intervals that overlap almost entirely. ` +
            `A weak sentence for a word is still better ` +
            `evidence the word exists than no sentence at all, and coverage is the corpus's ` +
            `headline claim.`,
          `Stopping here is a judgement about the marginal rule, not about the direction. ` +
            `"strict" adds sentence-short-for-band and reaches ` +
            `${pct(strict?.residualBrokenRate ?? 0)}, but the links it adds over "${chosen.id}" ` +
            `are only ${strictOnly.sampleBroken}/${strictOnly.sampleLinks} broken ` +
            `(${strictOnly.precision.toFixed(2)}, 95% CI ` +
            `${pct(strictOnly.precisionCi95.low)}-${pct(strictOnly.precisionCi95.high)}) against ` +
            `a sample base rate near 0.17 — indistinguishable from dropping at random. It costs ` +
            `another ${strictOnly.populationLinks} links, and ${(strict?.sentencesPerHeadword["3"] ?? 0)} ` +
            `headwords keep a full three-sentence triad under it against ` +
            `${chosenScore.sentencesPerHeadword["3"] ?? 0} under "${chosen.id}". Not worth it on ` +
            `this evidence; re-run with more labels if you want to revisit it.`,
          `This is an improvement, not a fix. The residual interval ` +
            `[${pct(chosenScore.residualBrokenCi95.low)}, ${pct(chosenScore.residualBrokenCi95.high)}] ` +
            `is nowhere near zero: roughly one sentence in twelve is still defective after the ` +
            `filter, and the judge under-calls severity. Whatever ships, the disclosure ships ` +
            `with it — a measured and published defect rate is a far better position than a ` +
            `filtered corpus that implies there is nothing left to declare.`,
        ],
        rejected: [
          {
            policyId: "bands-1-6",
            because:
              `The worst option on the board, on every axis at once. Drops ` +
              `${pct(bands16?.linksDroppedPct ?? 0)} of links, takes headword coverage from ` +
              `99.82% to ${pct(bands16?.headwordCoveragePct ?? 0)} — 5,642 canon words lose ` +
              `every sentence they have — and the residual broken rate GOES UP, to ` +
              `${pct(bands16?.residualBrokenRate ?? 0)}. Band 7 is where the two-character ` +
              `headwords live; cutting it concentrates the single-character ones that are the ` +
              `actual defect.`,
          },
          {
            policyId: "single-char-hard-drop",
            because:
              `Lands at ${pct(hardDrop?.residualBrokenRate ?? 0)} residual, which this sample ` +
              `cannot distinguish from "${chosen.id}" at ${pct(chosenScore.residualBrokenRate)}, ` +
              `while destroying ` +
              `${pct(1 - (hardDrop?.headwordCoveragePct ?? 0))} of headword coverage. Pure cost.`,
          },
          {
            policyId: "aggressive",
            because:
              `Drops ${pct(aggressive?.linksDroppedPct ?? 0)} of the corpus to land at ` +
              `${pct(aggressive?.residualBrokenRate ?? 0)}, which is WORSE than "strict" at ` +
              `${pct(strict?.residualBrokenRate ?? 0)}. Past a point the length rules stop ` +
              `selecting for defects and start selecting for short sentences.`,
          },
          {
            policyId: "surgical-keep-last",
            because:
              `The fallback if dropping ${pct(chosenScore.linksDroppedPct)} of links is judged ` +
              `too expensive: ${pct(surgical?.linksDroppedPct ?? 0)} dropped at precision ` +
              `${(surgical?.precision ?? 0).toFixed(2)} — the highest of any policy — for a ` +
              `residual of ${pct(surgical?.residualBrokenRate ?? 0)}. Two fifths of the benefit ` +
              `for a quarter of the cut, and it leaves ` +
              `${surgical?.sentencesPerHeadword["3"] ?? 0} headwords with a full triad.`,
          },
        ],
        disclosure:
          `Example sentences are third-party source data: graded here, not authored here. An ` +
          `LLM judge over a seeded stratified random sample of ${judged.sampling.judged} ` +
          `headword links puts the rate of clearly-defective sentences at ${pct(baseRate)} ` +
          `(95% CI ${pct(judged.results.corpusWide.brokenCi95.low)}-` +
          `${pct(judged.results.corpusWide.brokenCi95.high)}), with a further ` +
          `${pct(judged.results.corpusWide.notCleanRate - baseRate)} awkward but parseable. ` +
          `Defects concentrate on single-character headwords ` +
          `(${pct(predictorScores.find((p) => p.id === "headword-single-char")?.precision ?? 0)} ` +
          `broken), not on advanced vocabulary — band 7 is ` +
          `${pct(predictorScores.find((p) => p.id === "headword-band-7")?.precision ?? 0)}, below ` +
          `the corpus average. The judge prompt, the sampling seed, every per-stratum rate and ` +
          `every individual label are in data/quality-report.json.`,
      },
      decision: {
        policyId: chosen.id,
        keepLastLink: chosen.keepLastLink,
        predictors: chosen.predictors.map((id) => ({
          id,
          rule: PREDICTORS.find((p) => p.id === id)?.hypothesis ?? "",
        })),
        excludedLinks: excluded.size,
        exclusionsSha256: digestOf([...excluded]),
        howToApply:
          `A decision, not an edit: data/sentences.jsonl is unchanged. Re-derive the id list ` +
          `with \`npx tsx src/build/quality.ts --policy ${chosen.id} --emit-exclusions <path>\` ` +
          `and check it against exclusionsSha256 (sha256 of the sorted ids joined by newline, ` +
          `first 16 hex). A link id is "<sentence id>|<word id>". Dropping every link of a ` +
          `sentence drops the sentence.`,
      },
    },
  };

  writeFileSync(QUALITY_REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  log("");
  log(`quality: recommended "${chosen.id}" — ${report.filter.recommendation.summary}`);
  log(`quality: wrote ${QUALITY_REPORT_JSON}`);

  if (emitTo !== undefined) {
    const payload = {
      schema: "zhongdex/quality-exclusions/v1",
      generator: "src/build/quality.ts",
      policyId: chosen.id,
      exclusionsSha256: digestOf([...excluded]),
      count: excluded.size,
      linkIds: [...excluded].sort(),
    };
    writeFileSync(emitTo, `${JSON.stringify(payload, null, 2)}\n`);
    log(`quality: wrote ${excluded.size} exclusions to ${emitTo}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].includes("quality") &&
  !process.argv[1].includes("quality-judge");
if (invokedDirectly) {
  await main();
}
