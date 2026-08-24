/**
 * `npm run export:pleco` — build importable Pleco flashcard files from the canon.
 *
 * Emits into dist/pleco/:
 *   Zhongdex-HSK-2026-t1.txt  ...  -t6.txt, -t7-9.txt   one file per band
 *   Zhongdex-HSK-2026-Complete.txt                      all seven, one file
 *   README.txt                                          attribution (CC BY-SA)
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT, AS PLECO DOCUMENTS IT
 * ---------------------------------------------------------------------------
 *
 * Sources (fetched 2026-08-24, quoted verbatim below):
 *   [M1] Pleco iOS manual 3.2, "Import / Export File Format"
 *        https://iphone.pleco.com/manual/30200/flash.html
 *   [M2] Pleco Android manual 3.1, same section, identical wording
 *        https://android.pleco.com/manual/310/flash.html
 *   [M3] Pleco Android manual 3.1, "Pinyin Search" (tone-number table, umlaut)
 *        https://android.pleco.com/manual/310/dict.html
 *   [F1] mikelove (Pleco staff), "new line in flashcards, when importing from
 *        a text file?" https://www.plecoforums.com/threads/2118/
 *   [F2] mikelove (Pleco staff), "Importing a list of characters"
 *        https://www.plecoforums.com/threads/importing-a-list-of-characters.284/
 *   [F3] mikelove (Pleco staff), "Format for imports"
 *        https://www.plecoforums.com/threads/format-for-imports.2694/
 *
 * Delimiter and column order [M1]:
 *
 *     characters{tab}Pinyin pronunciation{tab}definition
 *
 * "Make sure not to use more than one tab in each of those {tab} spaces,
 *  otherwise the importer might get confused about whether it's reading Pinyin
 *  or the definition for a word." [M1]
 *
 * There is no fourth column, and CSV is refused upstream — "csv is also
 * dangerous because then we need to deal with the weird quotation mark
 * policies / number conversions of Excel" [F3]. So the format has no quoting
 * and therefore no escape sequence: a tab inside a field cannot be written at
 * all. This exporter does not escape tabs, it guarantees fields never contain
 * one (see `sanitiseField`) and then re-reads its own output to prove it.
 *
 * Traditional characters [M1]: "if you're supplying both, put the simplified
 * characters first and the traditional characters immediately after them
 * enclosed by square brackets ... simplified[traditional]". When the two forms
 * are identical the brackets are omitted, matching Pleco's own example, which
 * writes 你好 bare and 我们[我們] bracketed.
 *
 * Pinyin [M1]: "Pinyin syllables should be entered with tone numbers after
 * each syllable, just as in a Pinyin dictionary search; Pinyin with tone marks
 * is also supported, but it's a bit less reliable, and in UTF-8 and UTF-16
 * files it only works with actual characters (Unicode range 0000-01DC) and not
 * with combining diacritical marks, so if possible you should always use tone
 * numbers." The canon carries both forms; we ship the numbered one, which is
 * also the one that is pure ASCII and cannot be broken by NFD normalisation.
 * Tone 5 is the neutral tone and ü is written `v`, both per Pleco's own
 * dictionary-search table [M3]: "To enter an umlaut (ü, as in nü or lü), enter
 * a 'v'". CC-CEDICT writes ü as `u:`, so 79 canon readings are rewritten.
 *
 * Categories [M1]: "A '//' at the start of a line indicates that this is the
 * beginning of a new flashcard category ... until it reaches another '//'
 * line". A '/' inside the name appears to open a subcategory — that is not in
 * the manual, but it is what published community decks do (e.g.
 * `//HSK Standard Course 3/L01`), and if Pleco does not read it that way the
 * only consequence is a category whose name contains a slash.
 *
 * Encoding: UTF-8, no BOM, LF line endings.
 *   - UTF-8 [M1]: "UTF-8 is the best choice in most cases, since it should
 *     open seamlessly in most desktop text editors and other programs".
 *   - No BOM: Pleco staff tell importers to strip it — "And make sure to
 *     uncheck the 'BOM' checkbox" [F2] — and the same thread notes Pleco
 *     "should be able to skip over them but it's not quite 100%". A BOM would
 *     land immediately before the file's first `//`, which is exactly the
 *     byte position where being wrong turns a category line into a card.
 *   - LF: not specified anywhere in the manual. Verified instead against a
 *     published, working Pleco deck (MyBeta/AwesomeChinesePlecoFlashcards,
 *     HSKStandardCourse3.txt): 5,080 bytes, no BOM, 168 LF line endings, zero
 *     CR bytes, tab-delimited, `//Name/Sub` category lines.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE NO EXAMPLE SENTENCES
 * ---------------------------------------------------------------------------
 *
 * data/sentences.jsonl holds 32,725 graded sentences, and they are deliberately
 * left out of this export. The text format has no field for them and no
 * supported way to start a second line inside a definition: asked directly
 * about newlines in text imports, Pleco staff answered "At the moment, this is
 * only supported in XML flashcard imports, not text-based ones" [F1]. The
 * community workaround is the private-use character U+EAB1, which the same
 * staff member calls unofficial and "not guaranteed to continue working in
 * future releases" [F1]; the XML alternative is documented as unfinalised —
 * "the format for XML is undocumented and will probably be changing in our
 * next update anyway" [M1].
 *
 * That leaves only concatenating a sentence into the gloss on one line, which
 * imports fine but makes every card's definition a paragraph and poisons
 * Pleco's own full-text search over definitions. A correct import without
 * sentences beats a mangled one with them, so: no sentences.
 *
 * NO AUDIO: none is hosted, so nothing here references a clip or a URL. The
 * verifier fails the build if a `http` ever appears in an emitted field.
 *
 * ---------------------------------------------------------------------------
 * Deterministic: no clock, no randomness, no network. Two runs over the same
 * canon produce byte-identical files.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BandLabel, CanonWord } from "./shared.js";
import {
  ATTRIBUTION,
  BANDS,
  bandLabel,
  bandTitle,
  corpusVersion,
  DIST_DIR,
  ensureDir,
  humanBytes,
  loadCanon,
  LICENCE,
  PROJECT_URL,
  sha256Hex,
} from "./shared.js";

const OUT_DIR = join(DIST_DIR, "pleco");

/** The one delimiter the format has. It is not escapable; fields must not hold it. */
const TAB = "\t";
const LF = "\n";

/** Parent category; each band becomes a subcategory of it. */
const ROOT_CATEGORY = "Zhongdex HSK 3.0 (2026)";

/** Han-only, matching the ranges the canon's own surface-form check uses. */
const HAN_ONLY = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3007]+$/u;

/** A numbered-pinyin syllable: letters then a tone digit, 5 = neutral [M3]. */
const SYLLABLE = /^[A-Za-z]+[1-5]$/;

/** Unicode private use area. Pleco's unofficial markup lives here; ours must not. */
const PRIVATE_USE = /[\uE000-\uF8FF]/u;

/* -------------------------------------------------------------------------- */
/* Canon row -> card                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The HSK 3.0 list writes editorial notation into its headword column, and the
 * canon passes it through verbatim. None of it is part of the word:
 *
 *   哥哥|哥        alternate written forms; the first is the one the canon's
 *                  numbered pinyin describes (`ge1 ge5`)
 *   们（朋友们）    a trailing usage example
 *   有（一）些      an optional element; the numbered pinyin (`you3 xie1`)
 *                  describes the form WITHOUT it, so dropping the brackets and
 *                  their contents is what keeps characters and syllables aligned
 *   称1 / 面2       a homograph index
 *   …极了          a slot pattern
 *
 * Stripping all five leaves pure Han for every one of the 11,092 canon rows,
 * and the simplified and traditional columns always come out the same length,
 * which is what makes the `simplified[traditional]` pairing safe.
 */
function primaryForm(headword: string): string {
  const primary = headword.split("|")[0] ?? "";
  return primary
    .replace(/[（(][^（）()]*[)）]/gu, "")
    .replace(/[0-9…\s]/gu, "");
}

/** `你好`, or `我们[我們]` when the two character sets differ [M1]. */
function plecoHeadword(simplified: string, traditional: string): string {
  return simplified === traditional ? simplified : `${simplified}[${traditional}]`;
}

/**
 * Numbered pinyin in Pleco's dictionary-search spelling: `u:` becomes `v` [M3].
 *
 * One canon row needs trimming as well. When the HSK list gives alternate
 * written forms the canon derives its numbered column from the whole
 * tone-marked string with the `|` removed, so `zhè shíhou|zhè shí` becomes
 * `zhe4 shi2 hou5 zhe4 shi2` — the readings of both variants, run together.
 * We keep the primary written form, so we keep the leading syllables that
 * describe it. This is a slice of an existing string, never an invention, and
 * it only fires when the tone-marked column proves a variant is present.
 *
 * Everything else must already align: Pleco assumes it does, promising that its
 * multiple-choice tests "always make sure that the number of characters in the
 * headword match the number of syllables in all of the possible Pinyin answers
 * for it" [M2]. A row that cannot be aligned is a bug in this exporter or a
 * change in the canon, and either way it stops the build.
 */
function plecoPinyin(word: CanonWord, characters: number): string {
  const numbered = word.pinyin.numbered.replace(/u:/gu, "v").replace(/U:/gu, "V");
  let syllables = numbered.trim().split(/\s+/u).filter((s) => s.length > 0);

  if (word.pinyin.marked.includes("|") && syllables.length > characters) {
    syllables = syllables.slice(0, characters);
  }

  if (syllables.length !== characters) {
    throw new Error(
      `${word.id}: ${String(characters)} characters but ${String(syllables.length)} ` +
        `pinyin syllables ("${numbered}"). Pleco matches syllables to characters, ` +
        `so this card cannot be emitted. Fix the reading in src/build/canon.ts, ` +
        `or teach primaryForm() the notation this headword uses.`,
    );
  }
  for (const syllable of syllables) {
    if (!SYLLABLE.test(syllable)) {
      throw new Error(
        `${word.id}: "${syllable}" is not a numbered-pinyin syllable (letters then ` +
          `a tone digit 1-5). Pleco reads tone numbers, not tone marks.`,
      );
    }
  }
  return syllables.join(" ");
}

/**
 * Collapses anything that would break the line format.
 *
 * The format cannot escape its own delimiter, so a tab has to become a space
 * rather than an escape sequence; the same is true of a line break, which would
 * silently split one card into two. No canon gloss contains either today — this
 * is here so that stays true rather than becoming a corrupted import later.
 */
function sanitiseField(text: string): string {
  return text.replace(/[\t\r\n\u000B\u000C\u0085\u2028\u2029]/gu, " ").replace(/ {2,}/gu, " ").trim();
}

/**
 * The glosses, in canon order, joined the way CC-CEDICT separates senses.
 *
 * `/` is safe as a separator precisely because CC-CEDICT reserves it as its own
 * field delimiter upstream, so no gloss can contain one — verified against all
 * 11,092 rows, which yield zero glosses containing `/`, a tab or a line break.
 */
function plecoDefinition(texts: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of texts) {
    const text = sanitiseField(raw);
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join(" / ");
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

interface Card {
  /** `simplified` or `simplified[traditional]`; column 1. */
  readonly headword: string;
  /** Numbered pinyin, space separated; column 2. */
  readonly pinyin: string;
  /** Glosses, or "" when the canon has none and Pleco should fill it in. */
  readonly definition: string;
  /** Lowest band any merged row carried. Decides which band file holds the card. */
  readonly band: BandLabel;
  /** Smallest merged canon id. Sort key, so the order never depends on Map order. */
  readonly id: string;
}

interface Draft {
  headword: string;
  pinyin: string;
  definitions: string[];
  band: BandLabel;
  bandIndex: number;
  id: string;
  rows: number;
}

/**
 * One Pleco card per (headword, reading).
 *
 * The canon is one row per (simplified, reading, primary POS) — 白/Adj at band 1
 * and 白/Adv at band 3 are two rows on purpose. A Pleco card has no POS field,
 * so those two rows describe one card, and emitting both would hand every
 * importer a duplicate-card prompt for 86 words. They are merged instead: the
 * union of the glosses, filed under the earliest band the learner meets it in,
 * which is also what makes the seven band files an exact partition of the
 * complete file.
 *
 * Homograph indices merge here too, since stripping them makes 面1 and 面2 the
 * same headword with the same reading — which for a flashcard they are.
 */
function buildCards(words: readonly CanonWord[]): { cards: Card[]; merged: number; unbanded: number } {
  const drafts = new Map<string, Draft>();
  let unbanded = 0;
  let merged = 0;

  for (const word of words) {
    const band = bandLabel(word);
    if (band === null) {
      unbanded += 1;
      continue;
    }
    const simplified = primaryForm(word.simplified);
    const traditional = primaryForm(word.traditional);
    if (!HAN_ONLY.test(simplified) || !HAN_ONLY.test(traditional)) {
      throw new Error(
        `${word.id}: headword "${word.simplified}" / "${word.traditional}" still ` +
          `carries non-Han notation after primaryForm(). Teach primaryForm() this ` +
          `notation before exporting; a Pleco headword must be characters only.`,
      );
    }

    const headword = plecoHeadword(simplified, traditional);
    const pinyin = plecoPinyin(word, [...simplified].length);
    const key = `${headword} ${pinyin}`;
    const bandIndex = BANDS.indexOf(band);
    const texts = word.definitions.map((definition) => definition.text);

    const existing = drafts.get(key);
    if (existing === undefined) {
      drafts.set(key, { headword, pinyin, definitions: texts, band, bandIndex, id: word.id, rows: 1 });
      continue;
    }
    merged += 1;
    existing.rows += 1;
    existing.definitions.push(...texts);
    if (bandIndex < existing.bandIndex) {
      existing.band = band;
      existing.bandIndex = bandIndex;
    }
    if (word.id < existing.id) existing.id = word.id;
  }

  const cards = [...drafts.values()].map((draft) => ({
    headword: draft.headword,
    pinyin: draft.pinyin,
    definition: plecoDefinition(draft.definitions),
    band: draft.band,
    id: draft.id,
  }));
  cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cards, merged, unbanded };
}

/**
 * One card, as a line.
 *
 * A card with no gloss is emitted as two fields, not three with an empty one.
 * That is the documented way to ask Pleco to supply the definition itself — "if
 * you don't supply one, Pleco will attempt to find one in its built-in
 * dictionaries" [M1] — and it is what Pleco's own example does for 再见.
 */
function cardLine(card: Card): string {
  const head = `${card.headword}${TAB}${card.pinyin}`;
  return card.definition.length === 0 ? head : `${head}${TAB}${card.definition}`;
}

function categoryLine(band: BandLabel): string {
  return `//${ROOT_CATEGORY}/${bandTitle(band)}`;
}

function renderFile(bands: readonly BandLabel[], byBand: ReadonlyMap<BandLabel, Card[]>): string {
  const lines: string[] = [];
  for (const band of bands) {
    const cards = byBand.get(band) ?? [];
    if (cards.length === 0) continue;
    lines.push(categoryLine(band));
    for (const card of cards) lines.push(cardLine(card));
  }
  return lines.join(LF) + LF;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

interface FileReport {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly cards: number;
  readonly categories: number;
  readonly twoFieldCards: number;
  readonly keys: readonly string[];
}

function fail(name: string, line: number, message: string): never {
  throw new Error(`${name}:${String(line)} ${message}`);
}

/**
 * Re-reads a written file from disk and proves it is what Pleco documents.
 *
 * This is the only verification that could be done: Pleco is iOS and Android
 * only, there is no importer to run on a build machine, and no claim is made
 * here that the file imports — only that every property the manual states is
 * true of the bytes on disk.
 */
function verify(path: string, name: string): FileReport {
  const bytes = readFileSync(path);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(name, 1, "starts with a UTF-8 BOM; Pleco is told to strip these and the byte lands on the first '//'.");
  }
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    fail(name, 1, "starts with a UTF-16 BOM; this export is UTF-8.");
  }

  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(name, 1, "is not valid UTF-8 (it does not survive a decode/encode round trip).");
  }
  if (text.includes("\r")) fail(name, 1, "contains a CR byte; line endings must be bare LF.");
  if (!text.endsWith(LF)) fail(name, 1, "does not end with a newline.");
  if (text.endsWith(LF + LF)) fail(name, 1, "ends with a blank line; a blank line is not a card.");

  const lines = text.slice(0, -1).split(LF);
  const keys: string[] = [];
  const seen = new Set<string>();
  let cards = 0;
  let categories = 0;
  let twoFieldCards = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const number = index + 1;

    if (line.length === 0) fail(name, number, "is blank.");
    if (line.startsWith("//")) {
      if (line.includes(TAB)) fail(name, number, "is a category line but contains a tab.");
      categories += 1;
      continue;
    }

    const fields = line.split(TAB);
    if (fields.length !== 2 && fields.length !== 3) {
      fail(
        name,
        number,
        `has ${String(fields.length)} tab-separated fields; the format is ` +
          `characters{tab}pinyin{tab}definition, with the definition optional.`,
      );
    }
    const headword = fields[0] ?? "";
    const pinyin = fields[1] ?? "";
    const definition = fields[2] ?? "";

    // Field count already proves no field holds a tab; these prove the rest.
    const bracketed = /^(.+?)\[(.+)\]$/u.exec(headword);
    const simplified = bracketed?.[1] ?? headword;
    const traditional = bracketed?.[2] ?? headword;
    if (!HAN_ONLY.test(simplified) || !HAN_ONLY.test(traditional)) {
      fail(name, number, `headword "${headword}" is not characters, or characters[characters].`);
    }

    const syllables = pinyin.split(" ");
    for (const syllable of syllables) {
      if (!SYLLABLE.test(syllable)) fail(name, number, `pinyin "${pinyin}" has a syllable without a tone number 1-5.`);
    }
    if (syllables.length !== [...simplified].length) {
      fail(name, number, `"${headword}" has ${String([...simplified].length)} characters but ${String(syllables.length)} syllables.`);
    }

    if (fields.length === 2) twoFieldCards += 1;
    else {
      if (definition.length === 0) fail(name, number, "has an empty third field; omit the tab instead.");
      if (definition.startsWith("//")) fail(name, number, "definition starts with '//' and would be read as a category.");
      if (PRIVATE_USE.test(definition)) fail(name, number, "definition contains a private-use character.");
      if (definition.includes("http")) fail(name, number, "definition contains a URL; this release hosts no audio and links nothing.");
    }

    const key = `${headword} ${pinyin}`;
    if (seen.has(key)) fail(name, number, `duplicates "${key}"; Pleco would prompt about it on import.`);
    seen.add(key);
    keys.push(key);
    cards += 1;
  }

  return { name, bytes: bytes.length, sha256: sha256Hex(bytes), cards, categories, twoFieldCards, keys };
}

function write(name: string, text: string): FileReport {
  const path = join(OUT_DIR, name);
  writeFileSync(path, Buffer.from(text, "utf8"));
  return verify(path, name);
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A Pleco text file has nowhere to put a licence: every line is either a card
 * or a category, so an attribution line would import as one or the other. The
 * notice CC BY-SA 4.0 requires therefore travels beside the files.
 */
function readme(cards: number, files: readonly FileReport[]): string {
  const lines = [
    "Zhongdex — HSK 3.0 (2026) flashcards for Pleco",
    "",
    `${String(cards)} cards, corpus ${corpusVersion()}. ${PROJECT_URL}`,
    "",
    "Import: put a .txt on your device, then Pleco > Import/Export > Import Cards,",
    "with Text encoding set to UTF-8. Each file files its cards under",
    `"${ROOT_CATEGORY}". Import Complete, or one band at a time — the seven band`,
    "files are an exact partition of the complete file, so importing all seven and",
    "importing Complete give the same cards.",
    "",
    "Format: tab-separated characters / numbered pinyin / definition, UTF-8 with no",
    "byte order mark and LF line endings, per the Pleco manual's",
    "\"Import / Export File Format\" section.",
    "",
    "No audio: none is hosted, so no card references a clip.",
    "No example sentences: the text format has no field for them and no supported",
    "way to break a line inside a definition.",
    "",
    `Licence: ${LICENCE}.`,
    ATTRIBUTION,
    "",
    "Files:",
  ];
  for (const file of files) {
    lines.push(`  ${file.name}  ${String(file.cards)} cards  sha256 ${file.sha256}`);
  }
  return lines.join(LF) + LF;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

function main(): void {
  const words = loadCanon();
  const { cards, merged, unbanded } = buildCards(words);

  process.stdout.write(
    `canon: ${String(words.length)} rows -> ${String(cards.length)} Pleco cards ` +
      `(${String(merged)} rows merged into an existing headword+reading; corpus ${corpusVersion()})\n`,
  );
  if (unbanded > 0) {
    process.stdout.write(`  ${String(unbanded)} rows carry no 2026 band and are not exported\n`);
  }

  const byBand = new Map<BandLabel, Card[]>();
  for (const card of cards) {
    const bucket = byBand.get(card.band);
    if (bucket === undefined) byBand.set(card.band, [card]);
    else bucket.push(card);
  }

  ensureDir(OUT_DIR);

  const reports: FileReport[] = [];
  const bandKeys: string[] = [];
  for (const band of BANDS) {
    const bandCards = byBand.get(band) ?? [];
    if (bandCards.length === 0) continue;
    const report = write(`Zhongdex-HSK-2026-t${band}.txt`, renderFile([band], byBand));
    reports.push(report);
    bandKeys.push(...report.keys);
    process.stdout.write(
      `${bandTitle(band)}: ${String(report.cards)} cards, ${humanBytes(report.bytes)} -> ${report.name}\n`,
    );
  }

  const complete = write("Zhongdex-HSK-2026-Complete.txt", renderFile(BANDS, byBand));
  reports.push(complete);
  process.stdout.write(
    `Complete: ${String(complete.cards)} cards in ${String(complete.categories)} categories, ` +
      `${humanBytes(complete.bytes)} -> ${complete.name}\n`,
  );

  // The band files must partition the complete file: same cards, no overlap.
  if (bandKeys.length !== complete.cards) {
    throw new Error(
      `band files hold ${String(bandKeys.length)} cards but Complete holds ` +
        `${String(complete.cards)}. They must be the same set.`,
    );
  }
  const completeKeys = new Set(complete.keys);
  for (const key of bandKeys) {
    if (!completeKeys.has(key)) throw new Error(`"${key}" is in a band file but not in Complete.`);
  }

  writeFileSync(join(OUT_DIR, "README.txt"), Buffer.from(readme(complete.cards, reports), "utf8"));

  const twoField = reports.reduce((total, report) => total + (report.name.includes("Complete") ? report.twoFieldCards : 0), 0);
  process.stdout.write(
    `verified: ${String(reports.length)} files re-read from disk — UTF-8 with no BOM, LF only, ` +
      `every card line 2 or 3 tab-separated fields, every field free of tabs, every reading ` +
      `tone-numbered and syllable-aligned to its characters, no duplicate headword+reading, ` +
      `no URLs. ${String(twoField)} cards ship no gloss and let Pleco supply one.\n`,
  );
  process.stdout.write(
    "NOT verified: that Pleco imports these. Pleco is iOS/Android only and has no " +
      "importable build on a CI machine, so no end-to-end import test was run.\n",
  );
}

main();
