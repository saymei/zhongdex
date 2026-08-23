/**
 * Tranche-1 pack definitions — the deterministic, zero-LLM packs.
 *
 * Every definition is a pure query over columns that exist in the canon.
 * A definition declares the canon capabilities it needs; if the loaded canon
 * does not provide them the pack is DEFERRED and recorded in pack-stats.json.
 * Nothing here fabricates data to fill a pack.
 *
 * Prose (`title`, `oneLiner`, `description`, `rationale`) is hand-written build
 * metadata. Per the REVISION1 §12 ruling, no model picks a word; in tranche 1
 * no model writes anything either.
 */

import type { CanonCapability, CanonWord, PackKind, PackSource } from "./pack-schema.js";
import { BAND_SCHEME } from "./pack-schema.js";

/** Inclusive band window a pack must be closed within, or null for no claim. */
export interface ClosureWindow {
  readonly min: number;
  readonly max: number;
}

export interface PackDef {
  readonly slug: string;
  readonly kind: PackKind;
  readonly title: string;
  readonly oneLiner: string;
  readonly description: string;
  readonly rationale: string;
  readonly tags: readonly string[];
  readonly source: PackSource;
  /** Canon columns this query reads. Missing ones defer the pack. */
  readonly requires: readonly CanonCapability[];
  /** Columns named in provenance. */
  readonly columns: readonly string[];
  /** The membership rule in prose, published on the pack page. */
  readonly rule: string;
  /** The membership rule as a query string, published verbatim. */
  readonly query: string;
  /** Band window the pack must be closed within. null = the pack claims no level. */
  readonly closure: ClosureWindow | null;
  /** Level claim written into the pack. */
  readonly bandClaim: number | null;
  readonly bandRange: string | null;
  readonly cumulative: boolean;
  readonly select: (word: CanonWord) => boolean;
  /**
   * Words the query matches but the pack must not present as members.
   * The count is disclosed in the pack's `exclusions[]`, never dropped silently.
   */
  readonly exclude?: {
    readonly reason: string;
    readonly test: (word: CanonWord) => boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* POS matching                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The canon's POS column comes from the HSK 3.0 list, whose tags are
 * `N`, `V`, `Adj`, `Adv`, `M`, `Pron`, `Conj`, `Prep`, `Aux`, `Num`,
 * `Prefix`, `Suffix`, `Intj`, `Phonetic`, and slash-joined combinations
 * (`V/N`). Matching is case-insensitive and any-tag: a `V/N` word is both a
 * verb and a noun. A handful of aliases are accepted so the query survives a
 * canon that normalises the tag set; an alias that never matches simply
 * contributes nothing.
 */
function hasPos(word: CanonWord, tags: readonly string[]): boolean {
  for (const raw of word.pos) {
    const parts = raw.split("/");
    for (const part of parts) {
      const norm = part.trim().toLowerCase();
      if (norm.length === 0) continue;
      for (const tag of tags) {
        if (norm === tag) return true;
      }
    }
  }
  return false;
}

function posPack(args: {
  slug: string;
  title: string;
  tags: readonly string[];
  posTags: readonly string[];
  hskTag: string;
  what: string;
  why: string;
}): PackDef {
  const tagList = args.posTags.map((t) => `'${t}'`).join(", ");
  return {
    slug: args.slug,
    kind: "pos",
    title: args.title,
    oneLiner: `Every HSK 3.0 (2026) headword tagged ${args.hskTag}, across all bands.`,
    description:
      `${args.what} Membership is the part-of-speech column of the HSK 3.0 (2026) ` +
      `word list, read as an any-tag match: a word tagged 'V/N' belongs to both the ` +
      `verb pack and the noun pack. The pack spans every band, so it makes no ` +
      `band-closure claim; each word keeps its own band label.`,
    rationale: args.why,
    tags: ["computed", "pos", ...args.tags],
    source: "computed",
    requires: ["pos"],
    columns: ["pos"],
    rule: `Any part-of-speech tag on the headword matches one of ${tagList} (case-insensitive, slash-separated tags split first).`,
    query: `pos any_of [${tagList}]`,
    closure: null,
    bandClaim: null,
    bandRange: null,
    cumulative: false,
    select: (w) => hasPos(w, args.posTags),
  };
}

/* -------------------------------------------------------------------------- */
/* Band packs                                                                  */
/* -------------------------------------------------------------------------- */

function bandPack(band: number): PackDef {
  return {
    slug: `hsk-2026-t${band}`,
    kind: "band",
    title: `HSK ${band} (2026 syllabus)`,
    oneLiner: `The words in band t${band} of the HSK 3.0 syllabus effective 1 July 2026.`,
    description:
      `Band t${band} of HSK 3.0 (2026), exactly as published. Nothing is added, nothing is ` +
      `promoted from a neighbouring band, and the build asserts closure: every word in ` +
      `this file carries band ${band} in the canon or the pack does not ship.`,
    rationale:
      `The unit learners and exam candidates actually work in. It exists so a saved deck ` +
      `can be checked against the current syllabus rather than a remembered one.`,
    tags: ["computed", "hsk", "hsk-2026", "band", `t${band}`],
    source: "computed",
    requires: ["hsk.band2026"],
    columns: ["hsk.band2026"],
    rule: `The headword's 2026 band label equals ${band}.`,
    query: `hsk_2026 == 't${band}'`,
    closure: { min: band, max: band },
    bandClaim: band,
    bandRange: null,
    cumulative: false,
    select: (w) => w.hsk.band2026 === band,
  };
}

const BAND_7_9: PackDef = {
  slug: "hsk-2026-t7-9",
  kind: "band",
  title: "HSK 7–9 (2026 syllabus)",
  oneLiner: "The advanced band of HSK 3.0, published as a single undivided level.",
  description:
    "HSK 3.0 publishes 7, 8 and 9 as one undivided advanced level, so this pack does too. " +
    "The build asserts closure at bands 7–9: a word labelled 6 or lower cannot appear here.",
  rationale:
    "The largest band by a wide margin and the one every other list truncates. Shipping it " +
    "whole is the cheapest way to be the only complete copy of the syllabus.",
  tags: ["computed", "hsk", "hsk-2026", "band", "t7-9", "advanced"],
  source: "computed",
  requires: ["hsk.band2026"],
  columns: ["hsk.band2026", "hsk.bandRange"],
  rule: "The headword's 2026 band label is 7 or higher (HSK 3.0 does not subdivide 7–9).",
  query: "hsk_2026 >= 't7'",
  closure: { min: 7, max: 9 },
  bandClaim: 7,
  bandRange: "7-9",
  cumulative: false,
  select: (w) => w.hsk.band2026 >= 7,
};

function cumulativePack(args: {
  slug: string;
  maxBand: number;
  title: string;
  oneLiner: string;
  description: string;
  rationale: string;
  extraTags: readonly string[];
  bandRange: string | null;
}): PackDef {
  return {
    slug: args.slug,
    kind: "band",
    title: args.title,
    oneLiner: args.oneLiner,
    description: args.description,
    rationale: args.rationale,
    tags: ["computed", "hsk", "hsk-2026", "cumulative", ...args.extraTags],
    source: "computed",
    requires: ["hsk.band2026"],
    columns: ["hsk.band2026"],
    rule: `The headword's 2026 band label is ${args.maxBand} or lower.`,
    query: `hsk_2026 <= 't${args.maxBand}'`,
    closure: { min: 1, max: args.maxBand },
    bandClaim: args.maxBand,
    bandRange: args.bandRange,
    cumulative: true,
    select: (w) => w.hsk.band2026 <= args.maxBand,
  };
}

/* -------------------------------------------------------------------------- */
/* The tranche-1 list                                                          */
/* -------------------------------------------------------------------------- */

export const PACK_DEFS: readonly PackDef[] = [
  // --- Bands 1-6 (REVISION1 §12.2 packs 1-6) -------------------------------
  bandPack(1),
  bandPack(2),
  bandPack(3),
  bandPack(4),
  bandPack(5),
  bandPack(6),
  BAND_7_9,

  // --- Cumulative (packs 8-10) ---------------------------------------------
  cumulativePack({
    slug: "hsk-2026-t1-t3",
    maxBand: 3,
    title: "HSK 1–3 cumulative (2026 syllabus)",
    oneLiner: "Everything in bands t1 through t3 of HSK 3.0, in one deck.",
    description:
      "Bands 1, 2 and 3 of HSK 3.0 (2026) unioned. Closure is asserted at band 3: no word " +
      "above the claimed level can be present.",
    rationale:
      "The realistic first-year target, and the boundary the elementary exam is written to. " +
      "Cumulative packs exist because nobody revises a single band in isolation.",
    extraTags: ["t1-t3", "beginner"],
    bandRange: "1-3",
  }),
  cumulativePack({
    slug: "hsk-2026-t1-t6",
    maxBand: 6,
    title: "HSK 1–6 cumulative (2026 syllabus)",
    oneLiner: "Every word in bands t1 through t6 of HSK 3.0.",
    description:
      "Bands 1 through 6 of HSK 3.0 (2026) unioned — the whole syllabus short of the " +
      "advanced level. Closure is asserted at band 6.",
    rationale:
      "The scope most learners mean by 'the HSK list', and the direct comparison point " +
      "against the old HSK 2.0 1–6 vocabulary.",
    extraTags: ["t1-t6", "intermediate"],
    bandRange: "1-6",
  }),
  cumulativePack({
    slug: "hsk-2026-complete",
    maxBand: 9,
    title: "HSK 1–9 complete (2026 syllabus)",
    oneLiner: "The complete HSK 3.0 (2026) word list, every band.",
    description:
      "The entire syllabus in one pack. Closure is asserted at bands 1–9, which for this " +
      "pack means every word in the canon carries a 2026 band label.",
    rationale:
      "The reference set everything else is a subset of, and the pack that makes the " +
      "completeness claim checkable in one download.",
    extraTags: ["complete", "reference"],
    bandRange: "1-9",
  }),

  // --- Legacy + delta (packs 11-13) ----------------------------------------
  {
    slug: "hsk-2-0-t1-t6",
    kind: "band",
    title: "HSK 2.0 1–6 survivors (legacy)",
    oneLiner:
      "The old HSK 2.0 levels 1–6 words that are STILL on the 2026 list. Not the full " +
      "HSK 2.0 list — words dropped in the rewrite are not in this corpus and cannot appear.",
    description:
      "The intersection of the legacy HSK 2.0 levels 1–6 vocabulary with the HSK 3.0 (2026) " +
      "syllabus. This corpus contains only 2026 headwords, so an HSK 2.0 word that the " +
      "rewrite dropped has no record here and is absent from this pack by construction. " +
      "Read it as 'what survived', not as 'the HSK 2.0 list'. It is also incomplete in the " +
      "other direction: the HSK 2.0 level is known for roughly 40% of the corpus, so a 2026 " +
      "word with no HSK 2.0 label is excluded whether or not it was on the old list.",
    rationale:
      "Most third-party Chinese decks in circulation are still HSK 2.0. This is the " +
      "overlap that is safe to keep studying, which is the practical question a learner " +
      "with an old deck is actually asking.",
    tags: ["computed", "hsk", "hsk-2.0", "legacy", "partial-coverage"],
    source: "computed",
    requires: ["hsk.band2_0"],
    columns: ["hsk.band2_0"],
    rule: "The headword carries a known HSK 2.0 level of 6 or lower.",
    query: "hsk_2_0 != null && hsk_2_0 <= 6",
    closure: null,
    bandClaim: null,
    bandRange: "1-6",
    cumulative: true,
    select: (w) => w.hsk.band2_0 !== null && w.hsk.band2_0 <= 6,
  },
  {
    slug: "hsk-2021-complete",
    kind: "band",
    title: "HSK 1–9 (2021 revision, legacy)",
    oneLiner: "The 2021 HSK 3.0 revision, superseded by the 2026 syllabus.",
    description:
      "Every headword in this corpus carrying a band label under the 2021 revision. Like " +
      "the HSK 2.0 pack this is an intersection, not the whole 2021 list: the corpus is the " +
      "2026 syllabus, so a 2021 word that the 2026 rewrite dropped has no record here. The " +
      "pack spans the 2021 scheme rather than the 2026 one, so it makes no 2026 closure " +
      "claim; each word keeps both labels in the canon.",
    rationale:
      "The list in force until 1 July 2026, and the other half of any migration diff. " +
      "Kept as its own pack so 'what changed' has two endpoints, not one.",
    tags: ["computed", "hsk", "hsk-2021", "legacy"],
    source: "computed",
    requires: ["hsk.band2021"],
    columns: ["hsk.band2021"],
    rule: "The headword carries a non-null 2021 band label.",
    query: "hsk_2021 != null",
    closure: null,
    bandClaim: null,
    bandRange: "1-9",
    cumulative: true,
    select: (w) => w.hsk.band2021 !== null,
  },
  {
    slug: "hsk-2026-delta",
    kind: "delta",
    title: "HSK 2026 Delta — what changed",
    oneLiner: "Every word that entered, left, or moved band between the 2021 and 2026 lists.",
    description:
      "The difference between the 2021 revision and the 2026 syllabus: words whose band " +
      "moved, and words that carry no 2021 band at all and so are new to the list. " +
      "Computed at build time from the two band columns, so it re-derives whenever either " +
      "moves. The pack spans all bands and deliberately claims no closure.\n\n" +
      "One exclusion, applied on purpose. A handful of records did not join the enrichment " +
      "snapshot, so their 2021 band is null because it is UNKNOWN, not because the word is " +
      "new. Presenting those as 'new in 2026' would be a factual claim the data does not " +
      "support, so they are dropped and the count is disclosed in this pack's " +
      "`exclusions[]`. The true delta is therefore a floor: it is this pack's size, plus " +
      "some unknown part of the excluded set.",
    rationale:
      "The one list nobody else publishes, and the only thing a learner with a two-year-old " +
      "deck actually needs. It is also the anchor for the /hsk-2026 page family — which is " +
      "exactly why it must not overstate itself.",
    tags: ["computed", "hsk", "hsk-2026", "hsk-2021", "delta", "migration"],
    source: "computed",
    requires: ["hsk.band2026", "hsk.band2021"],
    columns: ["hsk.band2026", "hsk.band2021", "enrichedVia"],
    rule:
      "The headword's 2026 band differs from its 2021 band, including words with no 2021 " +
      "label at all — but only where the 2021 label is genuinely known to be absent, i.e. " +
      "the record joined the enrichment snapshot.",
    query: "hsk_2026 != hsk_2021 && enriched_via != null",
    closure: null,
    bandClaim: null,
    bandRange: null,
    cumulative: false,
    select: (w) => w.hsk.band2021 === null || w.hsk.band2021 !== w.hsk.band2026,
    exclude: {
      reason:
        "2021 band is unknown, not absent: the record did not join the enrichment " +
        "snapshot (enrichedVia === null), so it cannot be shown to be new in 2026",
      test: (w) => w.enrichedVia === null,
    },
  },

  // --- Frequency (packs 14-18) ---------------------------------------------
  // Frequency rank is GLOBAL — measured across 118,765 upstream headwords, of
  // which this corpus holds only the 11,092 that are on the HSK 3.0 list. So
  // `core-500` is an intersection and yields well under 500 words. The naming
  // decision: keep the "Core N" name, because it is the phrase people search
  // and REVISION1 §12.2 names it, but make N unmistakably a THRESHOLD rather
  // than a card count in the title, one-liner and description — the three
  // strings that travel with the pack into the catalogue. `size` is the truth.
  ...[500, 1000, 2000, 3000, 5000].map<PackDef>((n) => ({
    slug: `core-${n}`,
    kind: "frequency",
    title: `Zhongdex Core ${n} — HSK words inside the top ${n}`,
    oneLiner:
      `The HSK 3.0 (2026) words that rank in the ${n} most frequent Chinese words overall. ` +
      `This is fewer than ${n} cards, by design — see the description.`,
    description:
      `Frequency rank here is global: it is measured across 118,765 upstream headwords, most ` +
      `of which are proper nouns, variants and function words that the HSK syllabus does not ` +
      `list. This pack is the intersection — every HSK 3.0 (2026) headword whose global rank ` +
      `is ${n} or better — so it deliberately contains materially fewer than ${n} words. ` +
      `The \`size\` field is the real card count; the ${n} in the name is the frequency cutoff, ` +
      `not a quantity. Words whose frequency rank is unknown cannot appear in any Core pack ` +
      `at all; the canon's coverage figures record how many that is.`,
    rationale:
      `'Core ${n}' is a query people type, so the pack keeps the name. What it must not do is ` +
      `let the name imply a card count it does not deliver — a learner who expects ${n} cards ` +
      `and receives fewer has been misled by the title, which is why the arithmetic is stated ` +
      `three times before anyone opens the file.`,
    tags: ["computed", "frequency", `core-${n}`, "threshold-named", "global-rank"],
    source: "computed",
    requires: ["frequencyRank"],
    columns: ["frequencyRank"],
    rule: `The headword has a known global frequency rank of ${n} or better.`,
    query: `frequency_rank != null && frequency_rank <= ${n}`,
    closure: null,
    bandClaim: null,
    bandRange: null,
    cumulative: false,
    select: (w) => w.frequencyRank !== null && w.frequencyRank <= n,
  })),

  // --- Part of speech ------------------------------------------------------
  posPack({
    slug: "pos-nouns",
    title: "Nouns",
    tags: ["nouns"],
    posTags: ["n", "noun"],
    hskTag: "N (noun)",
    what: "Every noun in the HSK 3.0 (2026) list.",
    why:
      "The largest word class in the syllabus and the one that carries the most concrete " +
      "vocabulary. Split out so a learner can drill things separately from actions.",
  }),
  posPack({
    slug: "pos-verbs",
    title: "Verbs",
    tags: ["verbs"],
    posTags: ["v", "verb"],
    hskTag: "V (verb)",
    what: "Every verb in the HSK 3.0 (2026) list.",
    why:
      "Verbs are where Mandarin grammar lives, and the class most worth drilling with " +
      "sentences rather than glosses.",
  }),
  posPack({
    slug: "pos-adjectives",
    title: "Adjectives",
    tags: ["adjectives"],
    posTags: ["adj", "a", "adjective"],
    hskTag: "Adj (adjective)",
    what: "Every adjective in the HSK 3.0 (2026) list.",
    why:
      "Mandarin adjectives behave like stative verbs, which is exactly why they are worth " +
      "isolating from both nouns and verbs when drilling.",
  }),
  posPack({
    slug: "pos-adverbs",
    title: "Adverbs",
    tags: ["adverbs"],
    posTags: ["adv", "d", "adverb"],
    hskTag: "Adv (adverb)",
    what: "Every adverb in the HSK 3.0 (2026) list.",
    why:
      "A small class that does disproportionate work in sentence order, and one that " +
      "glossary-style decks routinely bury.",
  }),
  posPack({
    slug: "pos-measure-words",
    title: "Measure Words",
    tags: ["measure-words", "classifiers"],
    posTags: ["m", "q", "mw", "classifier"],
    hskTag: "M (measure word / classifier)",
    what: "Every measure word in the HSK 3.0 (2026) list.",
    why:
      "The class every learner complains about and almost nobody ships as a deck. This is " +
      "the POS-column version; the noun→classifier pairing from CC-CEDICT 'CL:' tags is a " +
      "separate, later pack.",
  }),
  posPack({
    slug: "pos-pronouns",
    title: "Pronouns",
    tags: ["pronouns"],
    posTags: ["pron", "r", "pronoun"],
    hskTag: "Pron (pronoun)",
    what: "Every pronoun in the HSK 3.0 (2026) list.",
    why:
      "A closed class small enough to finish in one sitting, which makes it the best " +
      "first non-band deck a beginner can take.",
  }),
  posPack({
    slug: "pos-conjunctions",
    title: "Conjunctions",
    tags: ["conjunctions", "connectives"],
    posTags: ["conj", "c", "conjunction"],
    hskTag: "Conj (conjunction)",
    what: "Every conjunction in the HSK 3.0 (2026) list.",
    why:
      "Connectives are what separate sentence-level Mandarin from paragraph-level Mandarin, " +
      "and they are learnable as a set.",
  }),
  posPack({
    slug: "pos-prepositions",
    title: "Prepositions",
    tags: ["prepositions", "coverbs"],
    posTags: ["prep", "p", "preposition"],
    hskTag: "Prep (preposition / coverb)",
    what: "Every preposition in the HSK 3.0 (2026) list.",
    why:
      "Mandarin coverbs govern word order and are a common source of transfer errors, " +
      "so they reward being drilled together.",
  }),
  posPack({
    slug: "pos-numerals",
    title: "Numerals",
    tags: ["numerals", "numbers"],
    posTags: ["num", "numeral"],
    hskTag: "Num (numeral)",
    what: "Every numeral in the HSK 3.0 (2026) list.",
    why:
      "Small, closed, and a hard prerequisite for prices, dates and measure words. " +
      "Worth finishing before anything else.",
  }),
  posPack({
    slug: "pos-auxiliaries",
    title: "Auxiliaries and Particles",
    tags: ["auxiliaries", "particles", "grammar"],
    posTags: ["aux", "u", "auxiliary", "particle"],
    hskTag: "Aux (auxiliary / particle)",
    what: "Every auxiliary and particle in the HSK 3.0 (2026) list.",
    why:
      "了, 着, 过 and their relatives carry aspect and mood with no English equivalent. " +
      "They are grammar wearing a vocabulary costume, and belong in their own deck.",
  }),
];

export const LEVEL_SCHEME = BAND_SCHEME;
