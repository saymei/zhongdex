/**
 * `npm run export:yomitan` — build installable Yomitan dictionaries from the canon.
 *
 * Emits into dist/yomitan/:
 *   Zhongdex-Terms.zip          term banks: glosses, HSK band badge, saymei.app link
 *   Zhongdex-Frequency.zip      term_meta freq entries   (only if the canon carries ranks)
 *   Zhongdex-Pronunciation.zip  term_meta ipa entries    (marked + numbered pinyin)
 *
 * Plus a sidecar `<name>.index.json` for each, byte-identical to the index.json
 * inside the zip, so a GitHub release can serve both and Yomitan's built-in
 * updater (`isUpdatable`) has something to poll.
 *
 * Format transcribed from yomidevs/yomitan@master ext/data/schemas — see
 * yomitan-schema.ts. Every emitted file is validated against those rules before
 * it is zipped.
 *
 * Deterministic: sorted input, no timestamps, fixed zip metadata.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DictionaryIndex,
  StructuredContent,
  TagBankEntry,
  TermBankEntry,
  TermMetaBankEntry,
} from "./yomitan-schema.js";
import {
  validateIndex,
  validateTagBank,
  validateTermBank,
  validateTermMetaBank,
} from "./yomitan-schema.js";
import type { BandLabel, CanonWord, ExampleSentence } from "./shared.js";
import {
  allSurfaceForms,
  ALL_POS,
  ATTRIBUTION,
  bandLabel,
  bandScore,
  bandTitle,
  chunk,
  corpusVersion,
  DIST_DIR,
  ensureDir,
  formReadings,
  humanBytes,
  loadCanon,
  loadSentencesByWordId,
  markedPinyin,
  numberedPinyin,
  posLabel,
  posTag,
  PROJECT_URL,
  zipBuffer,
} from "./shared.js";

const OUT_DIR = join(DIST_DIR, "yomitan");
const RELEASE_BASE = `${PROJECT_URL}/releases/latest/download`;
const SITE = "https://www.saymei.app";
const UTM = "utm_source=yomitan&utm_medium=dictionary&utm_campaign=zhongdex";

/** yomichan-dict-builder's default bank size, and what the big dictionaries ship. */
const BANK_CHUNK = 10_000;

interface DictionaryFile {
  readonly name: string;
  readonly json: unknown;
}

interface BuiltDictionary {
  readonly zipName: string;
  readonly index: DictionaryIndex;
  readonly files: readonly DictionaryFile[];
  readonly entryCount: number;
}

/* -------------------------------------------------------------------------- */
/* Shared index scaffolding                                                    */
/* -------------------------------------------------------------------------- */

function makeIndex(
  title: string,
  zipName: string,
  description: string,
  extra: Partial<DictionaryIndex> = {},
): DictionaryIndex {
  return {
    title,
    revision: `zhongdex-${corpusVersion()}`,
    format: 3,
    sequenced: true,
    author: "SayMei",
    url: PROJECT_URL,
    description,
    attribution: ATTRIBUTION,
    sourceLanguage: "zh",
    targetLanguage: "en",
    isUpdatable: true,
    indexUrl: `${RELEASE_BASE}/${zipName.replace(/\.zip$/, "")}.index.json`,
    downloadUrl: `${RELEASE_BASE}/${zipName}`,
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/* Structured-content gloss                                                    */
/* -------------------------------------------------------------------------- */

const MUTED = { fontSize: "0.85em", color: "#777777" } as const;

function headwordLine(word: CanonWord): StructuredContent {
  const parts: StructuredContent[] = [
    { tag: "span", lang: "zh-Hans", content: word.simplified, data: { zhongdex: "simplified" } },
  ];
  if (word.traditional !== word.simplified) {
    parts.push(" / ");
    parts.push({ tag: "span", lang: "zh-Hant", content: word.traditional, data: { zhongdex: "traditional" } });
  }
  return { tag: "div", data: { zhongdex: "headword" }, content: parts };
}

function pinyinLine(word: CanonWord): StructuredContent {
  const marked = markedPinyin(word);
  const numbered = numberedPinyin(word);
  const text = numbered.length > 0 && numbered !== marked ? `${marked} [${numbered}]` : marked;
  return { tag: "div", data: { zhongdex: "pinyin" }, style: MUTED, content: text };
}

function bandLine(word: CanonWord, band: BandLabel | null): StructuredContent | null {
  const bits: string[] = [];
  if (band !== null) bits.push(`${bandTitle(band)} (2026 syllabus)`);
  if (word.pos.length > 0) bits.push(word.pos.map(posLabel).join(", "));
  if (bits.length === 0) return null;
  return { tag: "div", data: { zhongdex: "band" }, style: MUTED, content: bits.join(" - ") };
}

function glossList(word: CanonWord): StructuredContent | null {
  if (word.definitions.length === 0) return null;
  return {
    tag: "ul",
    data: { zhongdex: "definition" },
    content: word.definitions.map((definition) => ({
      tag: "li" as const,
      content: definition.text,
    })),
  };
}

function exampleList(sentences: readonly ExampleSentence[]): StructuredContent | null {
  if (sentences.length === 0) return null;
  const items: StructuredContent[] = sentences.slice(0, 3).map((sentence) => {
    const rows: StructuredContent[] = [{ tag: "span", lang: "zh", content: sentence.hanzi }];
    if (sentence.pinyin !== null) {
      rows.push({ tag: "div", style: MUTED, content: sentence.pinyin });
    }
    if (sentence.english !== null) {
      rows.push({ tag: "div", style: MUTED, content: sentence.english });
    }
    return { tag: "li", content: rows };
  });
  return {
    tag: "div",
    data: { zhongdex: "examples" },
    content: [
      { tag: "div", style: MUTED, content: "Examples" },
      { tag: "ul", content: items },
    ],
  };
}

/** The link back. Every entry gets one, and it deep-links to the live page. */
function attributionLine(word: CanonWord): StructuredContent {
  const href = `${SITE}/dictionary/${encodeURIComponent(word.simplified)}?${UTM}`;
  return {
    tag: "div",
    data: { zhongdex: "attribution" },
    style: MUTED,
    content: ["Hear it and say it back on ", { tag: "a", href, content: "SayMei", lang: "en" }],
  };
}

function glossContent(
  word: CanonWord,
  band: BandLabel | null,
  sentences: readonly ExampleSentence[],
): StructuredContent {
  const blocks: StructuredContent[] = [headwordLine(word), pinyinLine(word)];
  const banded = bandLine(word, band);
  if (banded !== null) blocks.push(banded);
  const glosses = glossList(word);
  if (glosses !== null) blocks.push(glosses);
  const examples = exampleList(sentences);
  if (examples !== null) blocks.push(examples);
  blocks.push(attributionLine(word));
  return { tag: "div", lang: "zh", data: { zhongdex: "entry" }, content: blocks };
}

/* -------------------------------------------------------------------------- */
/* Tags                                                                        */
/* -------------------------------------------------------------------------- */

function bandTag(band: BandLabel): string {
  return `hsk${band}`;
}

function termTagBank(): TagBankEntry[] {
  const tags: TagBankEntry[] = [];
  const bands: BandLabel[] = ["1", "2", "3", "4", "5", "6", "7-9"];
  bands.forEach((band) => {
    tags.push([
      bandTag(band),
      "frequency",
      -bandScore(band),
      `${bandTitle(band)} of the HSK 3.0 word list effective 1 July 2026`,
      bandScore(band),
    ]);
  });
  [...ALL_POS].sort().forEach((pos, i) => {
    tags.push([posTag(pos), "partOfSpeech", i, posLabel(pos), 0]);
  });
  return tags;
}

/* -------------------------------------------------------------------------- */
/* 1. Terms                                                                    */
/* -------------------------------------------------------------------------- */

function buildTerms(words: readonly CanonWord[]): BuiltDictionary {
  const sentencesByWord = loadSentencesByWordId();
  const entries: TermBankEntry[] = [];

  words.forEach((word, sequence) => {
    const band = bandLabel(word);
    const sentences = sentencesByWord.get(word.id) ?? [];
    const content = glossContent(word, band, sentences);
    const definitionTags = word.pos.map(posTag).join(" ");
    const termTags = band === null ? "" : bandTag(band);
    const rank = word.frequencyRank;
    const score = typeof rank === "number" ? Math.max(0, 100_000 - rank) : bandScore(band);

    for (const { form, reading } of formReadings(word)) {
      entries.push([
        form,
        reading,
        definitionTags,
        "",
        score,
        [{ type: "structured-content", content }],
        sequence,
        termTags,
      ]);
    }
  });

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[6] - b[6]));

  const files: DictionaryFile[] = [];
  chunk(entries, BANK_CHUNK).forEach((bank, i) => {
    files.push({ name: `term_bank_${String(i + 1)}.json`, json: bank });
  });
  files.push({ name: "tag_bank_1.json", json: termTagBank() });

  const index = makeIndex(
    "Zhongdex Terms",
    "Zhongdex-Terms.zip",
    "Every word of the HSK 3.0 (2026) syllabus with CC-CEDICT glosses, tone-marked " +
      "and numbered pinyin, and its official band. Built from the Zhongdex canon; " +
      "each entry links to its page on SayMei.",
  );
  return { zipName: "Zhongdex-Terms.zip", index, files, entryCount: entries.length };
}

/* -------------------------------------------------------------------------- */
/* 2. Frequency                                                                */
/* -------------------------------------------------------------------------- */

function buildFrequency(words: readonly CanonWord[]): BuiltDictionary | null {
  const ranked: { form: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const rank = word.frequencyRank;
    if (typeof rank !== "number" || !Number.isFinite(rank)) continue;
    for (const form of allSurfaceForms(word)) {
      const key = `${form} ${String(rank)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ form, rank });
    }
  }
  if (ranked.length === 0) return null;

  ranked.sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : a.rank - b.rank));
  const entries: TermMetaBankEntry[] = ranked.map(({ form, rank }) => [
    form,
    "freq",
    { value: rank, displayValue: `#${rank.toLocaleString("en-US")}` },
  ]);

  const files: DictionaryFile[] = [];
  chunk(entries, BANK_CHUNK).forEach((bank, i) => {
    files.push({ name: `term_meta_bank_${String(i + 1)}.json`, json: bank });
  });

  const index = makeIndex(
    "Zhongdex Frequency",
    "Zhongdex-Frequency.zip",
    "Corpus frequency ranks for the HSK 3.0 (2026) vocabulary, as a rank-based " +
      "Yomitan frequency dictionary.",
    { frequencyMode: "rank-based" },
  );
  return { zipName: "Zhongdex-Frequency.zip", index, files, entryCount: entries.length };
}

/* -------------------------------------------------------------------------- */
/* 3. Pronunciation                                                            */
/* -------------------------------------------------------------------------- */

function pronunciationTagBank(): TagBankEntry[] {
  return [
    ["pinyin", "pronunciation-dictionary", 0, "Hanyu Pinyin with tone marks", 0],
    ["numbered", "pronunciation-dictionary", 1, "Hanyu Pinyin with tone numbers (CC-CEDICT style)", 0],
  ];
}

interface PronunciationRow {
  readonly form: string;
  readonly reading: string;
  readonly transcriptions: readonly { readonly ipa: string; readonly tags: readonly string[] }[];
}

function buildPronunciation(words: readonly CanonWord[]): BuiltDictionary | null {
  const seen = new Set<string>();
  const rows: PronunciationRow[] = [];

  for (const word of words) {
    for (const { form, reading, marked, numbered } of formReadings(word)) {
      if (marked.length === 0 || reading.length === 0) continue;
      const key = `${form} ${reading}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const transcriptions: { ipa: string; tags: string[] }[] = [{ ipa: marked, tags: ["pinyin"] }];
      if (numbered !== null && numbered !== marked) {
        transcriptions.push({ ipa: numbered, tags: ["numbered"] });
      }
      rows.push({ form, reading, transcriptions });
    }
  }
  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    if (a.form !== b.form) return a.form < b.form ? -1 : 1;
    return a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0;
  });
  const entries: TermMetaBankEntry[] = rows.map((row) => [
    row.form,
    "ipa",
    { reading: row.reading, transcriptions: row.transcriptions },
  ]);

  const files: DictionaryFile[] = [];
  chunk(entries, BANK_CHUNK).forEach((bank, i) => {
    files.push({ name: `term_meta_bank_${String(i + 1)}.json`, json: bank });
  });
  files.push({ name: "tag_bank_1.json", json: pronunciationTagBank() });

  const index = makeIndex(
    "Zhongdex Pronunciation",
    "Zhongdex-Pronunciation.zip",
    "Mandarin pronunciation for the HSK 3.0 (2026) vocabulary: tone-marked pinyin " +
      "and CC-CEDICT-style numbered pinyin, delivered through Yomitan's phonetic " +
      "transcription channel. Readings follow the CC-CEDICT for Yomitan convention " +
      "(lower-case, unspaced, tone-marked) so the entries attach to that dictionary too.",
  );
  return { zipName: "Zhongdex-Pronunciation.zip", index, files, entryCount: entries.length };
}

/* -------------------------------------------------------------------------- */
/* Emit + validate                                                             */
/* -------------------------------------------------------------------------- */

function validateFile(file: DictionaryFile): void {
  if (file.name.startsWith("term_meta_bank_")) validateTermMetaBank(file.json, file.name);
  else if (file.name.startsWith("term_bank_")) validateTermBank(file.json, file.name);
  else if (file.name.startsWith("tag_bank_")) validateTagBank(file.json, file.name);
  else throw new Error(`${file.name}: unexpected file in a Yomitan dictionary`);
}

function emit(dictionary: BuiltDictionary): { path: string; bytes: number } {
  validateIndex(dictionary.index, `${dictionary.zipName}/index.json`);
  for (const file of dictionary.files) validateFile(file);

  const indexJson = JSON.stringify(dictionary.index, null, 2);
  const entries = [
    { name: "index.json", data: Buffer.from(indexJson, "utf8") },
    ...dictionary.files.map((file) => ({
      name: file.name,
      data: Buffer.from(JSON.stringify(file.json), "utf8"),
    })),
  ];

  ensureDir(OUT_DIR);
  const zipPath = join(OUT_DIR, dictionary.zipName);
  const buffer = zipBuffer(entries);
  writeFileSync(zipPath, buffer);
  writeFileSync(join(OUT_DIR, `${dictionary.zipName.replace(/\.zip$/, "")}.index.json`), indexJson);
  return { path: zipPath, bytes: buffer.length };
}

function main(): void {
  const words = loadCanon();
  process.stdout.write(`canon: ${String(words.length)} words (corpus ${corpusVersion()})\n`);

  const built: BuiltDictionary[] = [buildTerms(words)];

  const frequency = buildFrequency(words);
  if (frequency === null) {
    process.stdout.write(
      "SKIPPED Zhongdex Frequency: no `frequencyRank` on any canon row. " +
        "Ranks are not invented; re-run this export once the canon carries them.\n",
    );
  } else {
    built.push(frequency);
  }

  const pronunciation = buildPronunciation(words);
  if (pronunciation !== null) built.push(pronunciation);

  for (const dictionary of built) {
    const { path, bytes } = emit(dictionary);
    process.stdout.write(
      `${dictionary.index.title}: ${String(dictionary.entryCount)} entries, ` +
        `${String(dictionary.files.length)} data files, ${humanBytes(bytes)} -> ${path}\n`,
    );
  }
}

main();
