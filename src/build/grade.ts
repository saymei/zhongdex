/**
 * Zhongdex Sentence Grade (ZSG) — the grading engine.
 *
 * §4.2 of the spec: **ZSG is the highest HSK 3.0 (2026) band of any content
 * token in the sentence, after segmentation.** One number, 1-7, and anybody
 * holding the same word list can re-derive it. Nothing here is a model call, a
 * heuristic score, or a copy of a grade somebody else wrote down.
 *
 * The three things that make the definition operational, and the rulings this
 * file makes about each:
 *
 * 1. **Segmentation.** Forward maximum matching over the canon's own simplified
 *    forms. No third-party segmenter: the grade must be reproducible from the
 *    published word list alone, and a segmenter carrying its own dictionary
 *    would make the number depend on data nobody downstream can see.
 *
 * 2. **Tokens the canon does not contain.** A multi-character run the canon
 *    does not know falls apart into single characters. A single character that
 *    is not itself a headword gets the *character exposure band*: the lowest
 *    band of any canon word that contains it — the band by which a learner
 *    working through the list has met the character. A character no canon word
 *    contains is outside HSK 3.0 entirely; it forces the grade to 7 (the top of
 *    the scale) and is counted in `beyondHskTokens` so the reason is visible.
 *
 * 3. **Content tokens.** Punctuation, whitespace, digits and Latin runs are not
 *    content and are skipped. Every Han token is content — including function
 *    words, which the HSK list bands like anything else.
 */

import { createHash } from "node:crypto";

import type { Band } from "./types.js";
import type { DropReason } from "./sentence-schema.js";

/* -------------------------------------------------------------------------- */
/* Canon index                                                                 */
/* -------------------------------------------------------------------------- */

/** One canon row, reduced to what grading and selection need. */
export interface CanonRow {
  id: string;
  simplified: string;
  band: Band;
}

export interface CanonIndex {
  /** Lowest band per lookup form. A polyphone known at band 1 is known. */
  bandByForm: ReadonlyMap<string, Band>;
  /** Lowest band of any canon word containing this single character. */
  bandByChar: ReadonlyMap<string, Band>;
  maxFormLength: number;
}

const HAN = /\p{Script=Han}/u;
const LATIN_RUN = /[A-Za-z]{3,}/;
const LATIN_CHAR = /[A-Za-z]/g;
/** Replacement char, C0/C1 controls, HTML entities, HTML tags. */
const MOJIBAKE = /[\uFFFD\u0000-\u0008\u000B-\u001F\u007F-\u009F]|&[a-z]{2,8};|&#\d+;|<\/?[a-z][^>]*>/i;
/** Zero-width space, ZWNJ, ZWJ, BOM. */
const INVISIBLE = /[\u200B\u200C\u200D\uFEFF]/g;

function isHan(ch: string): boolean {
  return HAN.test(ch);
}

/**
 * The word list writes a handful of entries with editorial notation:
 * `哥哥|哥` (two accepted forms), `们（朋友们）` (the form plus an example of
 * its use), `面2` (a disambiguating index), `…极了` (a slot marker). Grading
 * needs the bare forms, so expand each row into the forms it actually licenses.
 * 43 of the 11,092 rows need this; the rest pass through untouched.
 */
export function lookupForms(simplified: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const clean = raw.replace(/[\u20260-9]/g, "").trim();
    if (clean !== "" && [...clean].every(isHan) && !out.includes(clean)) out.push(clean);
  };
  for (const alt of simplified.split("|")) {
    push(alt.replace(/（[^）]*）/g, ""));
    // A one-character parenthetical is optional content: 有（一）些 licenses both
    // 有些 and 有一些. A longer one is a usage example: 们（朋友们） does not
    // license 们朋友们. Only the short kind is expanded.
    const groups = alt.match(/（[^）]*）/g) ?? [];
    if (groups.length > 0 && groups.every((g) => [...g].length === 3)) {
      push(alt.replace(/[（）]/g, ""));
    }
  }
  return out;
}

export function buildCanonIndex(rows: readonly CanonRow[]): CanonIndex {
  const bandByForm = new Map<string, Band>();
  const bandByChar = new Map<string, Band>();
  let maxFormLength = 1;
  for (const row of rows) {
    for (const form of lookupForms(row.simplified)) {
      const seen = bandByForm.get(form);
      if (seen === undefined || row.band < seen) bandByForm.set(form, row.band);
      const length = [...form].length;
      if (length > maxFormLength) maxFormLength = length;
      for (const ch of form) {
        const known = bandByChar.get(ch);
        if (known === undefined || row.band < known) bandByChar.set(ch, row.band);
      }
    }
  }
  return { bandByForm, bandByChar, maxFormLength };
}

/* -------------------------------------------------------------------------- */
/* Segmentation                                                                */
/* -------------------------------------------------------------------------- */

export type TokenKind = "canon" | "char" | "other";

export interface Token {
  text: string;
  kind: TokenKind;
  /**
   * Effective HSK band. Null means the token is Han but outside HSK 3.0
   * altogether; `other` tokens carry null because they are not content.
   */
  band: Band | null;
}

/** Forward maximum matching over the canon forms. Deterministic, no state. */
export function segment(hanzi: string, index: CanonIndex): Token[] {
  const chars = [...hanzi];
  const tokens: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const head = chars[i];
    if (head === undefined) break;
    if (!isHan(head)) {
      let j = i;
      let run = "";
      while (j < chars.length) {
        const ch = chars[j];
        if (ch === undefined || isHan(ch)) break;
        run += ch;
        j += 1;
      }
      tokens.push({ text: run, kind: "other", band: null });
      i = j;
      continue;
    }
    let matched = false;
    const limit = Math.min(index.maxFormLength, chars.length - i);
    for (let len = limit; len >= 2; len -= 1) {
      const slice = chars.slice(i, i + len);
      if (!slice.every(isHan)) continue;
      const candidate = slice.join("");
      const band = index.bandByForm.get(candidate);
      if (band !== undefined) {
        tokens.push({ text: candidate, kind: "canon", band });
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const own = index.bandByForm.get(head);
    if (own !== undefined) tokens.push({ text: head, kind: "canon", band: own });
    else tokens.push({ text: head, kind: "char", band: index.bandByChar.get(head) ?? null });
    i += 1;
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Grade                                                                       */
/* -------------------------------------------------------------------------- */

export const BANDS: readonly Band[] = [1, 2, 3, 4, 5, 6, 7];

/** A band the 1-7 scale cannot express. Used only inside `newWordCount`. */
const BEYOND = 8;

export interface Grade {
  zsg: Band;
  charLen: number;
  /** Distinct canon forms attested, sorted. */
  words: string[];
  /** Distinct Han tokens outside HSK 3.0 at any band. */
  beyondHskTokens: number;
  newWordCount: Record<string, number>;
}

/**
 * Grade a sentence. Returns null when there is no content token to grade, which
 * `sentences.ts` turns into a `no-content-token` drop rather than a grade of 1.
 */
export function grade(hanzi: string, index: CanonIndex): Grade | null {
  const tokens = segment(hanzi, index);
  const effective = new Map<string, number>();
  let zsg = 0;
  for (const token of tokens) {
    if (token.kind === "other") continue;
    const band = token.band ?? BEYOND;
    if (!effective.has(token.text)) effective.set(token.text, band);
    zsg = Math.max(zsg, Math.min(band, 7));
  }
  if (effective.size === 0) return null;

  const newWordCount: Record<string, number> = {};
  for (const prefix of BANDS) {
    let n = 0;
    for (const band of effective.values()) if (band > prefix) n += 1;
    newWordCount[String(prefix)] = n;
  }

  const seen = new Set<string>();
  const words: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "canon" || seen.has(token.text)) continue;
    seen.add(token.text);
    words.push(token.text);
  }
  words.sort();

  let beyondHskTokens = 0;
  for (const band of effective.values()) if (band === BEYOND) beyondHskTokens += 1;

  return {
    zsg: Math.max(1, zsg) as Band,
    charLen: [...hanzi].length,
    words,
    beyondHskTokens,
    newWordCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Quality gates                                                               */
/* -------------------------------------------------------------------------- */

/** Longer than this is not a sentence anybody wants on a flashcard. */
export const MAX_CHAR_LEN = 100;
/** Fewer Han characters than this is a fragment, not a sentence. */
export const MIN_HAN_CHARS = 2;

export interface Candidate {
  hanzi: string;
  pinyin: string;
  english: string;
}

/**
 * Everything a sentence must survive before it is graded. Order matters only in
 * that the first failure is the reason recorded; each check is independent.
 */
export function rejectionReason(candidate: Candidate, headword: string): DropReason | null {
  const { hanzi, pinyin, english } = candidate;
  if (hanzi === "") return "empty-hanzi";
  const chars = [...hanzi];
  const hanCount = chars.filter(isHan).length;
  if (hanCount === 0) return "no-han";
  if (hanCount < MIN_HAN_CHARS) return "too-short";
  if (chars.length > MAX_CHAR_LEN) return "too-long";
  if (MOJIBAKE.test(hanzi)) return "mojibake";
  if (/(.)\1{3,}/u.test(hanzi)) return "mojibake";
  if (LATIN_RUN.test(hanzi)) return "latin-prose";
  if ((hanzi.match(LATIN_CHAR) ?? []).length > 6) return "latin-prose";
  if (english === "") return "missing-english";
  if (pinyin === "") return "missing-pinyin";
  if (!containsHeadword(hanzi, headword)) return "headword-absent";
  return null;
}

/** Does the sentence actually use the word it is filed under? */
export function containsHeadword(hanzi: string, headword: string): boolean {
  for (const form of lookupForms(headword)) if (hanzi.includes(form)) return true;
  return false;
}

/** Trim, collapse internal whitespace runs, strip zero-width characters. */
export function normalizeText(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Ids                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `dex:s:<12 hex>` over the sentence text. Content-derived, so the same
 * sentence keeps its id across builds and across headwords; 12 hex digits put
 * the collision probability for a corpus this size around 3e-5, and
 * `sentences.ts` fails the build outright if one happens anyway.
 */
export function sentenceId(hanzi: string): string {
  return `dex:s:${createHash("sha256").update(hanzi, "utf8").digest("hex").slice(0, 12)}`;
}

/* -------------------------------------------------------------------------- */
/* Character-length percentiles                                                */
/* -------------------------------------------------------------------------- */

/**
 * §4.2 ships `charLengthPercentile` so a deck maker can filter on length
 * without trusting our grade. The spec quotes p50/p90 measured on the dialogue
 * corpus; this build reads a different corpus, so it measures its own
 * distribution rather than importing numbers that describe other sentences.
 */
export class CharLengthTable {
  private readonly sorted = new Map<Band, number[]>();

  constructor(samples: ReadonlyArray<{ band: Band; charLen: number }>) {
    for (const band of BANDS) this.sorted.set(band, []);
    for (const sample of samples) this.sorted.get(sample.band)?.push(sample.charLen);
    for (const list of this.sorted.values()) list.sort((a, b) => a - b);
  }

  /** Mid-rank percentile, 0-100, rounded. An empty band answers 50. */
  percentile(band: Band, charLen: number): number {
    const list = this.sorted.get(band);
    if (list === undefined || list.length === 0) return 50;
    let below = 0;
    let equal = 0;
    for (const value of list) {
      if (value < charLen) below += 1;
      else if (value === charLen) equal += 1;
    }
    return Math.round((100 * (below + equal / 2)) / list.length);
  }

  /** Median length for a band. 0 when the band has no samples. */
  median(band: Band): number {
    return quantile(this.sorted.get(band) ?? [], 0.5);
  }

  summary(): Record<string, { n: number; p50: number; p90: number }> {
    const out: Record<string, { n: number; p50: number; p90: number }> = {};
    for (const band of BANDS) {
      const list = this.sorted.get(band) ?? [];
      out[String(band)] = { n: list.length, p50: quantile(list, 0.5), p90: quantile(list, 0.9) };
    }
    return out;
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[index] ?? 0;
}
