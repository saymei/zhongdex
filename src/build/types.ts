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
   * HSK 3.0 (2021) band, 1–7 with 7 again meaning the merged 7-9 range.
   * Enrichment-only: it comes from `global_dictionary.hsk_new_level` via the
   * vendored snapshot. Null is ambiguous on its own — it means either "the 2021
   * list does not carry this word" or "we could not join this record at all".
   * `enrichedVia` on the record disambiguates the two.
   */
  band2021: number | null;
  /**
   * HSK 2.0 band, 1–6. From `global_dictionary.hsk_old_level`. Same null
   * semantics as `band2021`; most of the 2026 list has no 2.0 label at all.
   */
  band2_0: number | null;
  /** Row id in the source list, e.g. "L1-0001". */
  listId: string;
}

/**
 * Corpus frequency, from SayMei's dictionary. Both members are always present;
 * null means unknown. They are two different measurements and neither is
 * derived from the other, so a word can carry one without the other.
 */
export interface FrequencyInfo {
  /** Corpus frequency rank, 1 = most frequent. From `frequency_rank`. */
  rank: number | null;
  /**
   * Zipf score, from `zipf_score`. Observed range in the source is 0–7.79; the
   * upstream table writes 0 for forms with no corpus attestation, and that 0 is
   * passed through unchanged rather than reinterpreted as null.
   */
  zipf: number | null;
}

/**
 * Whether a clip exists for one voice, and whether Zhongdex publishes a URL
 * for it. `hosted` is false everywhere in this release — see `WordAudio`.
 */
export interface VoiceAudio {
  available: boolean;
  hosted: boolean;
}

/**
 * `available-unhosted` — a clip exists upstream but this release ships no URL.
 * `none`               — no clip exists upstream for this word.
 * `unknown`            — the record did not join the enrichment snapshot, or
 *                        no snapshot was present, so availability is unmeasured.
 */
export type AudioStatus = "available-unhosted" | "none" | "unknown";

/**
 * Availability metadata, never URLs.
 *
 * The clips live on Railway object storage behind the SayMei app, whose egress
 * is metered, so republishing their paths here would bill a third party for
 * every download of this dataset. A URL that costs someone money is worse than
 * an honest absence, exactly as a URL that 404s would be.
 *
 * `female` is evidenced, not assumed: `global_dictionary.audio_url` is a single
 * column written by only two code paths in the SayMei repo —
 * `server/services/audio/word-audio-pipeline.ts` and
 * `server/scripts/batch-generate-vocab-audio.ts` — and both synthesise with
 * ElevenLabs voice id `bhJUNIXWQQ94l8eI2VUf`, which the same repo's
 * `server/services/audio/elevenlabs-service.ts` registers as its `female`
 * voice and the pipeline comments as "Amy". There is no male word-audio column
 * upstream, so `male.available` is false for every record: that is a measured
 * absence, not an unknown.
 */
export interface WordAudio {
  female: VoiceAudio;
  male: VoiceAudio;
  status: AudioStatus;
}

/**
 * How a canon record joined SayMei's dictionary.
 *
 * `reading` — matched on simplified form *and* normalised numbered pinyin.
 * `form`    — the simplified form had exactly one upstream row and its reading
 *             disagreed; taken anyway, because one unambiguous row is evidence.
 * `null`    — no match, or no snapshot. Every enriched field is unknown.
 *
 * A form with several upstream rows and no reading match is deliberately left
 * unjoined: picking one would be a guess.
 */
export type EnrichmentJoin = "reading" | "form" | null;

export interface WordRecord {
  /** Kangxi radical of the first character, from Unihan kRSUnicode. Null when unmapped. */
  radical?: string | null;

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
  /** Corpus frequency. See also the flat mirrors below. */
  frequency: FrequencyInfo;
  /**
   * Flat mirrors of `frequency.rank` / `frequency.zipf`.
   *
   * Not redundant by choice: `src/build/pack-schema.ts` declares `frequencyRank`
   * and `zipf` at the top level of its `CanonWord` input contract, and
   * `src/mcp/data.ts` picks the same flat names. Both read this file and
   * neither is ours to change, so the canon satisfies the documented contract
   * and the nested shape at once. They are written from one value; they cannot
   * disagree.
   */
  frequencyRank: number | null;
  zipf: number | null;
  audio: WordAudio;
  /** Provenance for every enriched field above. Null means "unknown", not "none". */
  enrichedVia: EnrichmentJoin;
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
  enrichment: EnrichmentStats;
}

/* -------------------------------------------------------------------------- */
/* Enrichment snapshot                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One upstream `global_dictionary` row, reduced to the columns this project
 * uses. Keys are short because the snapshot is committed and there are ~11.7k
 * of these; every byte is a byte in everyone's clone.
 */
export interface SnapshotRow {
  /** Normalised numbered pinyin, the join key. See `normalizeReading`. */
  py: string;
  /** `hsk_new_level` — HSK 3.0 (2021) band. */
  b2021: number | null;
  /** `hsk_old_level` — HSK 2.0 band. */
  b20: number | null;
  /** `frequency_rank`. */
  rank: number | null;
  /** `zipf_score`. */
  zipf: number | null;
  /** `audio_url IS NOT NULL AND audio_url <> ''`. The URL itself is never captured. */
  audio: boolean;
}

/**
 * `data/enrichment.json` — a vendored, committed capture of the columns this
 * build needs from SayMei's production dictionary.
 *
 * It exists so `npm run build:canon` is offline and reproducible on any clone.
 * Refresh it with `npm run enrich:fetch`, which is the only thing in this repo
 * that opens a database connection, and which needs a SayMei checkout to run.
 */
export interface EnrichmentSnapshot {
  schema: "zhongdex/enrichment/v1";
  generator: string;
  /** When the capture ran. Provenance for a mutable upstream, not a build input. */
  capturedAt: string;
  source: {
    system: string;
    table: string;
    /** Total rows in the table at capture time. Context for the coverage figures. */
    tableRows: number;
    /**
     * Columns read, with their table-wide non-null counts at capture time.
     * A column that was entirely null is not captured and not listed here.
     */
    columns: Record<string, number>;
    /** Columns inspected and deliberately dropped, with why. */
    droppedColumns: Record<string, string>;
    notes: string[];
  };
  /** Distinct simplified forms requested (the canon's). */
  formsRequested: number;
  /** Distinct simplified forms that matched at least one upstream row. */
  formsMatched: number;
  /** Total upstream rows captured. */
  rows: number;
  /** Simplified form -> its upstream rows. Keys and rows are sorted for determinism. */
  words: Record<string, SnapshotRow[]>;
}

/** Join outcome tallies. The four buckets partition the canon exactly. */
export interface EnrichmentJoinCounts {
  /** Matched on simplified form and reading. */
  reading: number;
  /** Matched on a simplified form with exactly one upstream row; reading disagreed. */
  form: number;
  /** Several upstream rows, none with a matching reading. Left unjoined on purpose. */
  unjoinedAmbiguous: number;
  /** The simplified form is not in the upstream dictionary at all. */
  unjoinedNoRow: number;
}

/** Counts, not fractions: a fraction hides how big the denominator was. */
export interface EnrichmentCoverage {
  band2021: number;
  band2_0: number;
  frequencyRank: number;
  zipf: number;
  audioAvailable: number;
  audioNone: number;
  audioUnknown: number;
}

export interface EnrichmentStats {
  /**
   * The snapshot actually consumed, or null when `data/enrichment.json` was
   * absent. Null is the offline-fallback case: the build still succeeds and
   * every enriched field is emitted as unknown.
   */
  snapshot:
    | (InputStamp & { schema: string; capturedAt: string; tableRows: number; rows: number })
    | null;
  joined: EnrichmentJoinCounts;
  coverage: EnrichmentCoverage;
  /** Records per 2021 band, among those that got one. Band 7 is the merged 7-9 range. */
  band2021Bands: Record<string, number>;
  /**
   * Size of the 2026-vs-2021 difference this canon can support. `noBand2021`
   * includes records we could not join, which are unknown rather than new —
   * see the note.
   */
  delta2026: { bandMoved: number; noBand2021: number; total: number };
  notes: string[];
}
