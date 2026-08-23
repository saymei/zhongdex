/**
 * pack-v1 — the Zhongdex card-pack schema.
 *
 * Design rules (REVISION1 §12.1, §12.6):
 *  - Word membership is COMPUTED, never authored. Every pack carries the query
 *    that produced it and a digest that lets anyone re-derive the same list.
 *  - `words[]` holds stable word IDs only. Pack files never duplicate canon
 *    word data, so a pack can never drift from the canon.
 *  - Nothing in this module is time-dependent: no timestamps are emitted, so
 *    two builds over the same canon are byte-identical.
 *
 * Node builtins only. No LLM anywhere on this path.
 */

import { createHash } from "node:crypto";

export const PACK_SCHEMA_VERSION = "pack-v1" as const;

/**
 * Corpus/pack version. CalVer. Bumped by hand when the canon snapshot moves;
 * deliberately NOT derived from the clock so builds stay reproducible.
 */
export const CORPUS_VERSION = "2026.09" as const;
export const PACK_VERSION = "2026.09.1" as const;

/** Band scheme every tranche-1 pack is measured against. */
export const BAND_SCHEME = "hsk-3.0-2026" as const;

/** A pack smaller than this is not worth shipping; it is deferred instead. */
export const MIN_PACK_SIZE = 20;

/* -------------------------------------------------------------------------- */
/* Canon input                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-voice audio state. `available` means a clip exists upstream; `hosted`
 * means there is a public URL a learner could actually play. They are not the
 * same thing and a pack must never conflate them.
 */
export interface CanonVoiceAudio {
  readonly hosted: boolean;
  /** null = availability could not be determined (the record did not join). */
  readonly available: boolean | null;
}

/**
 * One record of `data/hsk_bands.json`, produced by `npm run build:canon`.
 * The optional fields are columns the canon does not carry yet; packs that
 * need them are declared but deferred rather than fabricated.
 *
 * `enrichedVia` is load-bearing: on an unjoined record every enrichment column
 * is null because it is UNKNOWN, not because it is absent. Read it before
 * treating any null as a fact.
 */
export interface CanonWord {
  readonly id: string;
  readonly simplified: string;
  readonly traditional: string;
  readonly pinyin: { readonly marked: string; readonly numbered: string };
  readonly pos: readonly string[];
  readonly hsk: {
    readonly band2026: number;
    readonly bandRange?: string;
    readonly band2021: number | null;
    readonly band2_0: number | null;
    readonly listId: string;
  };
  /** Opaque here: packs never copy definition text, they only count coverage. */
  readonly definitions: readonly unknown[];
  readonly audio: {
    readonly female: CanonVoiceAudio;
    readonly male: CanonVoiceAudio;
    readonly status: string;
  };
  /** How the record joined the enrichment snapshot. null = it did not join. */
  readonly enrichedVia: "reading" | "form" | null;
  readonly frequencyRank: number | null;
  readonly zipf: number | null;
  /** Not in the canon yet. Declared so radical packs can be deferred, not faked. */
  readonly radical?: string | null;
}

/**
 * Canon columns a pack definition may depend on. A definition listing a
 * capability the loaded canon does not provide is deferred, never guessed.
 */
export type CanonCapability =
  | "hsk.band2026"
  | "hsk.band2021"
  | "hsk.band2_0"
  | "pos"
  | "frequencyRank"
  | "zipf"
  | "radical"
  | "audio";

/* -------------------------------------------------------------------------- */
/* pack-v1                                                                     */
/* -------------------------------------------------------------------------- */

export type PackKind = "band" | "frequency" | "pos" | "delta";
export type PackSource = "computed" | "computed+curated";

export interface PackLevel {
  readonly scheme: string;
  /** null = the pack makes no level claim (it spans the corpus). */
  readonly band: number | null;
  readonly bandRange: string | null;
  readonly cumulative: boolean;
}

/** The reproducibility contract. */
export interface PackSelection {
  readonly query: string;
  readonly order: string;
  readonly deterministic: true;
  readonly seedSource: string | null;
}

/**
 * Measured, not asserted. `closed` is the result of an actual scan of the
 * selected words against the claimed band window.
 *
 * `claim` distinguishes the two honest states that a bare `closed: false`
 * would blur together:
 *  - "band-closed"  the pack claims a level, so closure is a testable promise
 *                   and `closed` is true or the pack does not ship;
 *  - "spans-bands"  the pack deliberately makes no level claim (a POS pack, a
 *                   delta), so `closed` is null — not failed, never attempted.
 */
export type PackClosureClaim = "band-closed" | "spans-bands";

export interface PackBandClosure {
  readonly scheme: string;
  readonly claim: PackClosureClaim;
  readonly claimedMinBand: number | null;
  readonly claimedMaxBand: number | null;
  readonly observedMinBand: number | null;
  readonly observedMaxBand: number | null;
  readonly overBand: number;
  readonly underBand: number;
  readonly offList: number;
  /** true/false only when `claim` is "band-closed"; null when it is not. */
  readonly closed: boolean | null;
}

export interface PackProvenance {
  /** How membership was decided. */
  readonly words: PackSource;
  /** Canon columns the query read. */
  readonly columns: readonly string[];
  /** The rule, in prose, that turns those columns into this list. */
  readonly rule: string;
  readonly curationSource: string | null;
  readonly corpus: string;
  readonly bands: string;
  readonly definitions: string;
  readonly audio: string;
  /** Tranche 1 ships zero model-written text. */
  readonly copy: string;
}

export interface PackLicence {
  readonly data: string;
  readonly attribution: string;
}

/**
 * Fractions of the pack, all in [0,1]. `female`/`male` count clips a learner
 * could actually play today. A clip that exists upstream but has no public URL
 * is counted separately, because calling it "complete" would be a lie.
 */
export interface PackAudioCompleteness {
  readonly female: number;
  readonly male: number;
  readonly femaleAvailableUnhosted: number;
  readonly maleAvailableUnhosted: number;
  /** Availability could not be determined (the canon record did not join). */
  readonly unknown: number;
  readonly status: "pending" | "partial" | "complete";
}

export interface PackCoverage {
  readonly bandLabelled: number;
  readonly band2021Labelled: number;
  readonly posLabelled: number;
  readonly defined: number;
  readonly frequencyRanked: number;
  readonly senseDisambiguated: number;
}

/**
 * Words the query matched but the pack deliberately drops, with the count.
 * Emitted so a removal is disclosed rather than silent.
 */
export interface PackExclusion {
  readonly reason: string;
  readonly count: number;
}

export interface Pack {
  readonly schemaVersion: typeof PACK_SCHEMA_VERSION;
  readonly id: string;
  readonly slug: string;
  readonly kind: PackKind;
  readonly itemType: "word";
  readonly title: string;
  readonly oneLiner: string;
  readonly description: string;
  readonly rationale: string;
  readonly level: PackLevel;
  readonly size: number;
  readonly tags: readonly string[];
  readonly source: PackSource;
  readonly selection: PackSelection;
  readonly exclusions: readonly PackExclusion[];
  readonly bandClosure: PackBandClosure;
  readonly provenance: PackProvenance;
  readonly licence: PackLicence;
  readonly audioCompleteness: PackAudioCompleteness;
  readonly coverage: PackCoverage;
  readonly version: string;
  readonly corpusVersion: string;
  /** sha256 over the sorted word-id list. This is what makes a pack reproducible. */
  readonly digest: string;
  /** Stable canon word IDs, ascending. Never duplicated word data. */
  readonly words: readonly string[];
}

export interface PackIndexEntry {
  readonly id: string;
  readonly slug: string;
  readonly file: string;
  readonly kind: PackKind;
  readonly title: string;
  readonly description: string;
  readonly level: PackLevel;
  readonly size: number;
  readonly tags: readonly string[];
  readonly source: PackSource;
  readonly digest: string;
}

export interface PackIndex {
  readonly schemaVersion: typeof PACK_SCHEMA_VERSION;
  readonly corpusVersion: string;
  readonly version: string;
  readonly count: number;
  readonly packs: readonly PackIndexEntry[];
}

export interface DeferredPack {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: PackKind;
  readonly reason: string;
  readonly missing: readonly string[];
}

export interface PackStats {
  readonly schemaVersion: typeof PACK_SCHEMA_VERSION;
  readonly corpusVersion: string;
  readonly version: string;
  readonly canonWords: number;
  readonly packCount: number;
  readonly totalSlots: number;
  readonly audio: {
    readonly overallFemale: number;
    readonly overallMale: number;
    readonly note: string;
  };
  readonly packs: readonly {
    readonly id: string;
    readonly slug: string;
    readonly size: number;
    readonly digest: string;
    /** "band-closed" = level claimed and verified; "spans-bands" = no claim. */
    readonly bandClosure: PackClosureClaim;
    readonly excluded: number;
    readonly audioCompleteness: PackAudioCompleteness;
  }[];
  readonly deferred: readonly DeferredPack[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Code-unit comparison. Deliberately NOT `localeCompare`, whose result depends
 * on the host ICU data and would make the build non-reproducible.
 */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** sha256 over the sorted word-id list. Order-invariant by construction. */
export function computeDigest(wordIds: readonly string[]): string {
  const sorted = [...wordIds].sort(compareIds);
  const hash = createHash("sha256");
  hash.update(sorted.join("\n"), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Structural + semantic validation of one pack. Returns the list of failures;
 * an empty array means the pack may publish.
 *
 * Blocking gates implemented here are the tranche-1 subset of REVISION1 §12.6
 * that is checkable with local data. The audio-coverage gate is reported but
 * non-blocking while every clip is still `pending`.
 */
export function validatePack(pack: Pack): string[] {
  const errors: string[] = [];

  if (pack.schemaVersion !== PACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${PACK_SCHEMA_VERSION}"`);
  }
  if (!pack.id.startsWith("dex:p:")) errors.push(`id must be namespaced "dex:p:*" (got "${pack.id}")`);
  if (pack.id !== `dex:p:${pack.slug}`) errors.push(`id "${pack.id}" does not match slug "${pack.slug}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pack.slug)) errors.push(`slug "${pack.slug}" is not kebab-case`);
  if (pack.title.length === 0) errors.push("title is empty");
  if (pack.description.length === 0) errors.push("description is empty");
  if (pack.rationale.length === 0) errors.push("rationale is empty");
  if (pack.tags.length === 0) errors.push("tags is empty");
  if (pack.selection.query.length === 0) errors.push("selection.query is empty");

  if (pack.words.length === 0) errors.push("words[] is empty");
  if (pack.words.length !== pack.size) {
    errors.push(`size ${pack.size} disagrees with words[].length ${pack.words.length}`);
  }
  if (pack.words.length < MIN_PACK_SIZE) {
    errors.push(`pack has ${pack.words.length} words, below the minimum of ${MIN_PACK_SIZE}`);
  }

  const seen = new Set<string>();
  for (const id of pack.words) {
    if (id.length === 0) errors.push("words[] contains an empty id");
    if (seen.has(id)) errors.push(`words[] contains duplicate id "${id}"`);
    seen.add(id);
  }

  for (let i = 1; i < pack.words.length; i += 1) {
    const prev = pack.words[i - 1];
    const cur = pack.words[i];
    if (prev === undefined || cur === undefined) continue;
    if (compareIds(prev, cur) >= 0) {
      errors.push("words[] is not sorted ascending by id");
      break;
    }
  }

  if (pack.digest !== computeDigest(pack.words)) {
    errors.push("digest does not reproduce from words[]");
  }

  // Band closure: asserted from measurement, never assumed.
  if (pack.level.band !== null) {
    if (pack.bandClosure.claim !== "band-closed") {
      errors.push(`pack claims level band ${pack.level.band} but declares claim "${pack.bandClosure.claim}"`);
    }
    if (pack.bandClosure.closed !== true) {
      errors.push(
        `pack claims level band ${pack.level.band} but is not band-closed ` +
          `(overBand=${pack.bandClosure.overBand}, underBand=${pack.bandClosure.underBand}, ` +
          `offList=${pack.bandClosure.offList})`,
      );
    }
    if (pack.bandClosure.claimedMaxBand === null) {
      errors.push("pack claims a level but declares no closure window");
    }
  } else {
    if (pack.bandClosure.claim !== "spans-bands") {
      errors.push(`pack makes no level claim but declares claim "${pack.bandClosure.claim}"`);
    }
    if (pack.bandClosure.closed !== null) {
      errors.push("pack makes no level claim, so bandClosure.closed must be null");
    }
  }

  for (const exclusion of pack.exclusions) {
    if (exclusion.count < 0) errors.push("exclusion count is negative");
    if (exclusion.reason.length === 0) errors.push("exclusion has no reason");
  }
  if (pack.kind === "band" && pack.bandClosure.offList > 0) {
    errors.push(`band pack contains ${pack.bandClosure.offList} off-list words`);
  }

  return errors;
}
