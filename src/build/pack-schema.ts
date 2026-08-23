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
 * One record of `data/hsk_bands.json`, produced by `npm run build:canon`.
 * The optional fields are columns the canon does not carry yet; packs that
 * need them are declared but deferred rather than fabricated.
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
    readonly listId: string;
  };
  /** Opaque here: packs never copy definition text, they only count coverage. */
  readonly definitions: readonly unknown[];
  readonly audio: {
    readonly female: string | null;
    readonly male: string | null;
    readonly status: string;
  };
  /** Not in the v1 canon. Present here so frequency packs can be declared+deferred. */
  readonly frequencyRank?: number | null;
  readonly zipf?: number | null;
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
 */
export interface PackBandClosure {
  readonly scheme: string;
  readonly claimedMinBand: number | null;
  readonly claimedMaxBand: number | null;
  readonly observedMinBand: number | null;
  readonly observedMaxBand: number | null;
  readonly overBand: number;
  readonly underBand: number;
  readonly offList: number;
  readonly closed: boolean;
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

export interface PackAudioCompleteness {
  readonly female: number;
  readonly male: number;
  readonly pending: number;
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
    readonly bandClosed: boolean;
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
    if (!pack.bandClosure.closed) {
      errors.push(
        `pack claims level band ${pack.level.band} but is not band-closed ` +
          `(overBand=${pack.bandClosure.overBand}, underBand=${pack.bandClosure.underBand}, ` +
          `offList=${pack.bandClosure.offList})`,
      );
    }
    if (pack.bandClosure.claimedMaxBand === null) {
      errors.push("pack claims a level but declares no closure window");
    }
  }
  if (pack.kind === "band" && pack.bandClosure.offList > 0) {
    errors.push(`band pack contains ${pack.bandClosure.offList} off-list words`);
  }

  return errors;
}
