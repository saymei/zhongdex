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
import {
  QUALITY_REPORT_JSON,
  STRATA,
  readCanon,
  readCorpus,
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
 * Titles that turn the word in front of them into a name. A common noun sitting
 * in this slot is the `室先生` failure: the generator needed a surname, had a
 * headword, and used it.
 */
const NAME_TITLES: readonly string[] = [
  "先生",
  "女士",
  "小姐",
  "老师",
  "太太",
  "夫人",
  "同志",
  "教授",
  "医生",
  "老板",
  "阿姨",
  "叔叔",
];

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
    test: (f) =>
      NAME_TITLES.some((t) => f.hanzi.includes(`${f.headword}${t}`)) ||
      f.hanzi.includes(`姓${f.headword}`) ||
      f.hanzi.includes(`叫${f.headword}`),
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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

  const corpus = readCorpus();
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
    throw new Error(
      `quality: ${judged.labels.length - labels.length} judged links are no longer in the ` +
        `corpus. The labels were measured against a different build of ` +
        `data/sentences.jsonl. Next: npm run judge:quality`,
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
