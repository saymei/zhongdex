/**
 * Zhongdex sentence corpus — record and stats types.
 *
 * A sentence record is a graded, deduplicated example sentence linked to one or
 * more canon headwords. The grade is the Zhongdex Sentence Grade (ZSG): the
 * highest HSK 3.0 (2026) band of any content token in the sentence after
 * segmentation. See `grade.ts` for the computation and `sentences.ts` for the
 * build.
 *
 * Two rules this file exists to enforce by type:
 *
 *  1. **No audio URLs.** Audio hosting does not exist yet and reading the
 *     production bucket costs metered egress, so a record records only whether
 *     a clip exists and what kind it is. A URL migration ships later.
 *  2. **Nothing is guessed.** Every numeric field here is computed from the
 *     canon word list plus the sentence text. Fields that cannot be computed
 *     honestly (numbered pinyin from an unparseable source string, a syllable
 *     map that does not align) are `null`, never approximated.
 */

import type { Band } from "./types.js";

/** Which corpus a sentence came from. Only `example_json` is read in v0.1. */
export type SentenceCorpus = "example_json";

/**
 * Triad slot, relative to the band of the headword the sentence is linked to.
 * The same sentence can be `easy` for one headword and `stretch` for another.
 */
export type TriadSlot = "easy" | "atLevel" | "stretch";

/**
 * Audio tier, derived from the source record's shape without reading a URL.
 *
 * `two-speed`     the row carries an `audioMasterUrl`, so a natural-speed
 *                 master and a slowed derivative both exist.
 * `slow-only`     a clip exists but there is no natural-speed master. These
 *                 are the legacy 0.7x renders; §4.4 of the spec requires them
 *                 to be labelled rather than counted as parity.
 * `none`          no clip.
 */
export type AudioTier = "two-speed" | "slow-only" | "none";

export interface SentenceAudio {
  available: boolean;
  tier: AudioTier;
  /** Verbatim `audioSource` from the source row; null when it carries none. */
  provenance: string | null;
}

/** One canon headword this sentence was selected for. */
export interface HeadwordLink {
  /** Canon word id, `dex:w:<numbered>:<simplified>:<pos>`. */
  wordId: string;
  simplified: string;
  /** The headword's own HSK 3.0 (2026) band. */
  band: Band;
  slot: TriadSlot;
  /**
   * The source entry's own sense index for this sentence, verbatim. It indexes
   * the *production dictionary entry's* senses, not this repo's canon rows, so
   * it is a provenance breadcrumb and not a resolvable sense id here.
   */
  senseIndex: number | null;
}

/** Character count against the in-corpus distribution for the same ZSG band. */
export interface CharLengthPercentile {
  band: Band;
  /** Mid-rank percentile, 0-100, against every kept sentence of this band. */
  pct: number;
}

export interface SentenceRecord {
  /** `dex:s:<12 hex of sha256(hanzi)>`. Stable across builds, content-derived. */
  id: string;
  hanzi: string;
  /** Tone-marked pinyin, verbatim from the source after whitespace cleanup. */
  pinyin: string;
  /** Numbered pinyin, derived. Null when the source pinyin will not parse. */
  pinyinNumbered: string | null;
  english: string;
  /** ZSG, 1-7. Identical to `bandClosure`; both ship because §4.4 names both. */
  zsg: Band;
  bandClosure: Band;
  /** Total characters, punctuation included. */
  charLen: number;
  charLengthPercentile: CharLengthPercentile;
  /**
   * For each band prefix 1..7, how many distinct content token forms fall
   * outside that prefix. `newWordCount["7"] > 0` means the sentence contains
   * material outside HSK 3.0 entirely — see `beyondHskTokens`.
   */
  newWordCount: Record<string, number>;
  /** Distinct canon word forms attested in the sentence, sorted. */
  words: string[];
  /** Distinct Han tokens that are not in the canon at any band. */
  beyondHskTokens: number;
  audio: SentenceAudio;
  source: { corpus: SentenceCorpus; license: "SayMei" };
  /** Every headword this sentence was selected for, sorted by word id. */
  headwords: HeadwordLink[];
}

/* -------------------------------------------------------------------------- */
/* Drops                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why a candidate sentence was rejected. Every drop is counted in the stats:
 * a corpus that quietly discards a third of its input is not auditable.
 */
export type DropReason =
  | "empty-hanzi"
  | "no-han"
  | "too-short"
  | "too-long"
  | "latin-prose"
  | "mojibake"
  | "missing-english"
  | "missing-pinyin"
  | "headword-absent"
  | "duplicate-for-headword"
  | "no-content-token";

export const DROP_REASONS: readonly DropReason[] = [
  "empty-hanzi",
  "no-han",
  "too-short",
  "too-long",
  "latin-prose",
  "mojibake",
  "missing-english",
  "missing-pinyin",
  "headword-absent",
  "duplicate-for-headword",
  "no-content-token",
];

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The build-time quality gate's record — which rules ran, what each of them
 * flagged, and which pool every headword's sentences ended up being drawn from.
 *
 * The gate lives in `src/build/quality.ts` and is applied during selection, so
 * the shipped corpus is the filtered corpus and there is no second artifact to
 * apply. This record exists so the filtering is auditable from the data alone:
 * a reader can see every rule, its measured evidence, and its cost.
 */
export interface SentenceQualityRecord {
  note: string;
  generator: string;
  /** Every (sentence, headword) pair the selector considered, before any rule. */
  candidateLinks: number;
  rules: {
    id: string;
    tier: "hard" | "soft";
    rule: string;
    evidence: string;
    /** Candidate links this rule flags, across the whole pool. */
    candidateLinksFlagged: number;
    /** Links this rule flags that were still selected — a fallback, never a miss. */
    selectedLinksFlagged: number;
  }[];
  selection: {
    note: string;
    headwordsByPool: {
      /** Served from candidates that clear every rule. */
      clean: number;
      /** No candidate cleared the soft rules; served from the hard-clean ones. */
      softFallback: number;
      /** No candidate cleared the hard rules either; kept the least-flagged one. */
      lastLinkFallback: number;
      /** No candidate sentence at all. Unchanged by the gate. */
      none: number;
    };
    singleCharHeadwordsCappedToOne: number;
  };
}

/**
 * A measured defect rate for the corpus in this file, written by
 * `npx tsx src/build/quality.ts --remeasure`. Present only when the
 * measurement was taken against exactly this corpus: `corpusSha256` is the
 * digest of `data/sentences.jsonl`, and a rebuild that changes the corpus drops
 * the block rather than letting a stale number describe new data.
 */
export interface SentenceQualityMeasurement {
  note: string;
  generator: string;
  corpusSha256: string;
  judge: {
    provider: string;
    model: string;
    temperature: number;
    promptSha256: string;
    /** Null when the summary was re-aggregated from labels that did not record it. */
    totalTokens: number | null;
    failures: number;
  };
  sampling: {
    unit: string;
    design: string;
    seed: string;
    seedInt: number;
    requested: number;
    judged: number;
    frame: { sentences: number; links: number; headwords: number };
    strata: { stratum: string; population: number; weight: number; n: number }[];
  };
  results: {
    definition: string;
    corpusWide: {
      brokenRate: number;
      brokenCi95: { low: number; high: number };
      notCleanRate: number;
      notCleanCi95: { low: number; high: number };
    };
    byHeadwordLength: { lenGroup: string; population: number; n: number; broken: number; brokenRate: number }[];
    byBandGroup: { bandGroup: string; population: number; n: number; broken: number; brokenRate: number }[];
    byFlag: Record<string, { failed: number; n: number; rate: number }>;
  };
  comparison: string;
}

export interface SentenceStats {
  schema: "zhongdex/sentence-stats/v1";
  generator: string;
  source: {
    corpus: SentenceCorpus;
    table: string;
    column: string;
    note: string;
    license: string;
  };
  grading: {
    definition: string;
    segmenter: string;
    beyondHsk: string;
    newWordCount: string;
    selection: string;
    charLengthPercentile: string;
  };
  input: {
    canonRows: number;
    canonDistinctForms: number;
    canonFormsFoundInSource: number;
    rawSentenceRows: number;
    distinctRawTexts: number;
    /** Longest source sentence, in characters. Evidence for the too-long gate. */
    maxRawCharLen: number;
  };
  drops: {
    total: number;
    byReason: Record<DropReason, number>;
  };
  graded: {
    /** Distinct sentences that survived the gates and were graded. */
    distinctSentences: number;
    headwordsWithAtLeastOne: number;
    gradeDistribution: Record<string, number>;
  };
  selected: {
    totalSentences: number;
    totalLinks: number;
    headwordsCovered: number;
    /** Headwords covered as a share of the canon's rows. */
    coveragePctOfCanonRows: number;
    coveragePctOfCanonForms: number;
    gradeDistribution: Record<string, number>;
    slotDistribution: Record<TriadSlot, number>;
    triadFullness: Record<string, number>;
    withAudio: number;
    withAudioPct: number;
    audioTier: Record<AudioTier, number>;
    withPinyinNumbered: number;
    withSenseIndex: number;
    /**
     * Links whose headword survives segmentation as a discrete token rather
     * than being absorbed into a longer word. Not a gate: 知道 inside 知不知道
     * and 招呼 inside 打招呼 are real uses, so dropping them would cost more
     * than it cleans. Published so a consumer can apply their own threshold.
     */
    headwordAttestedAsToken: number;
    headwordAttestedAsTokenPct: number;
    charLenPercentileTable: Record<string, { n: number; p50: number; p90: number }>;
  };
  /** What the build-time quality gate excluded, and why. */
  quality: SentenceQualityRecord;
  /** A judged defect rate for exactly this corpus, when one has been taken. */
  measuredQuality?: SentenceQualityMeasurement;
  /** Bands the canon assigns vs. the grade this build computed, for audit. */
  sourceHskLevelAgreement: {
    note: string;
    compared: number;
    exact: number;
    within1: number;
  };
  idCollisions: number;
}
