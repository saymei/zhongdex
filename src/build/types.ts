/**
 * Zhongdex canon build — shared types.
 *
 * The canon is the HSK 3.0 (2026) word list joined to CC-CEDICT. One record per
 * source row, which is to say one record per (simplified, reading, primary POS):
 * the source list deliberately carries 白/Adj at band 1 and 白/Adv at band 3 as
 * two separate entries, and collapsing them would destroy real information.
 */

/**
 * HSK 3.0 band. The published standard separates bands 7, 8 and 9 but the word
 * list does not: every advanced word is labelled "7-9". We map all of them to
 * band 7 and keep the source's own label in `bandRange` so nobody can mistake
 * our 7 for a claim that the word is specifically band 7 rather than 8 or 9.
 */
export type Band = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The `Level` value exactly as the source list writes it. */
export type BandRange = "1" | "2" | "3" | "4" | "5" | "6" | "7-9";

export interface PinyinForms {
  /** Tone-marked pinyin, verbatim from the HSK list. */
  marked: string;
  /** Numbered pinyin, CC-CEDICT convention ("ai4 hao4", "lu:3 you2"). */
  numbered: string;
}

/** Where a numbered-pinyin string came from. Recorded in the build stats. */
export type PinyinNumberedOrigin = "cedict-key" | "derived-from-marked" | "toneless-fallback";

export interface Definition {
  text: string;
  source: "cc-cedict";
  /** The CC-CEDICT headword key this gloss came from, e.g. "愛|爱[ai4]". */
  sourceKey: string;
  license: "CC-BY-SA-4.0";
}

export interface HskBanding {
  /** 1–7, where 7 means the merged 7-9 range. See `bandRange`. */
  band2026: Band;
  /** The source's own level label; "7-9" is not split by the source. */
  bandRange: BandRange;
  /**
   * HSK 3.0 (2021) band. Null throughout this build: the 2021 banding lives in
   * prod Postgres, which is not an input here. Null means unknown, not "none".
   */
  band2021: number | null;
  /** Row id in the source list, e.g. "L1-0001". */
  listId: string;
}

/**
 * Audio hosting does not exist yet. We emit nulls and a status rather than
 * URLs, because a URL that 404s is worse than an honest absence.
 */
export interface WordAudio {
  female: string | null;
  male: string | null;
  status: "pending";
}

export interface WordRecord {
  /** `dex:w:<numbered pinyin>:<simplified>:<primary POS>`. Stable, unique, readable. */
  id: string;
  simplified: string;
  traditional: string;
  pinyin: PinyinForms;
  /** POS tags, source order. The first is the primary POS and is part of the id. */
  pos: string[];
  hsk: HskBanding;
  definitions: Definition[];
  /** Prefixed provenance ids, e.g. ["hsk30:L1-0001", "cc-cedict:愛|爱[ai4]"]. */
  sourceIds: string[];
  audio: WordAudio;
}

/* -------------------------------------------------------------------------- */
/* CC-CEDICT                                                                   */
/* -------------------------------------------------------------------------- */

export interface CedictEntry {
  /** Traditional. */
  t: string;
  /** Simplified. */
  s: string;
  /** Tone-marked pinyin. */
  p: string;
  /** Numbered pinyin. */
  pn: string;
  /** Glosses. */
  d: string[];
}

export interface CedictFile {
  version: string;
  date: string;
  entries: number;
  data: Record<string, CedictEntry[]>;
}

/** A parsed `traditional|simplified[numbered pinyin]` join key. */
export interface CedictKey {
  raw: string;
  traditional: string;
  simplified: string;
  numbered: string;
}

/**
 * How a key was matched, worst tolerance last. Anything past `exact` is a
 * disagreement between the HSK list and CC-CEDICT and is counted in the stats.
 */
export type CedictMatchTier =
  | "exact"
  | "case-insensitive"
  | "neutral-tone"
  | "pinyin-only"
  | "pinyin-only-neutral-tone"
  | "traditional-only";

export interface CedictMatch {
  key: CedictKey;
  tier: CedictMatchTier;
  entries: CedictEntry[];
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

export interface InputStamp {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CanonStats {
  schema: "zhongdex/canon-stats/v1";
  generator: string;
  license: {
    wordList: string;
    definitions: string;
    attribution: string[];
  };
  inputs: {
    hsk30Csv: InputStamp & { rows: number };
    ccCedict: InputStamp & { version: string; date: string; entries: number; headwords: number };
  };
  rows: { in: number; out: number; dropped: number };
  /** Rows per band. Band 7 is the merged 7-9 range. */
  bands: Record<string, number>;
  bandRanges: Record<string, number>;
  cedict: {
    rowsWithKey: number;
    rowsWithoutKey: number;
    rowsMatched: number;
    rowsUnmatched: number;
    rowsWithZeroDefinitions: number;
    joinHitRateKeyedRows: number;
    joinHitRateAllRows: number;
    keysSeen: number;
    keysMatched: number;
    keysUnmatched: number;
    matchTiers: Record<CedictMatchTier, number>;
    definitionsEmitted: number;
  };
  polyphones: {
    distinctSimplifiedForms: number;
    simplifiedFormsOnMultipleRows: number;
    rowsSharingASimplifiedForm: number;
    maxRowsForOneSimplifiedForm: number;
  };
  pinyinNumberedOrigin: Record<PinyinNumberedOrigin, number>;
  band2021: { known: number; unknown: number; note: string };
  audio: { pending: number; resolved: number; note: string };
}
