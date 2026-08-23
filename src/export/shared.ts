/**
 * Shared plumbing for the distribution formats (`src/export/yomitan.ts`,
 * `src/export/anki.ts`).
 *
 * Contains only what both exporters need:
 *  - loading and shape-checking the canon and the computed packs
 *  - turning a syllabus headword into the surface forms a lookup can match
 *  - a deterministic ZIP writer (both output formats are zip containers)
 *
 * No network. No new dependencies. Node builtins only.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(HERE, "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const CANON_PATH = join(DATA_DIR, "hsk_bands.json");
export const PACK_INDEX_PATH = join(DATA_DIR, "packs", "index.json");
export const SENTENCES_PATH = join(DATA_DIR, "sentences.jsonl");
export const DIST_DIR = join(ROOT, "dist");

export const SAYMEI_URL = "https://saymei.app";
export const PROJECT_URL = "https://github.com/saymei/zhongdex";
export const ATTRIBUTION =
  "SayMei Zhongdex — https://saymei.app. Definitions from CC-CEDICT " +
  "(https://cc-cedict.org/), CC BY-SA 4.0. HSK 3.0 (2026) banding from the " +
  "official word list effective 1 July 2026. Dictionary data licensed CC BY-SA 4.0.";
export const LICENCE = "CC-BY-SA-4.0";

/** Fallback only. The real value is read from data/packs/index.json when present. */
const CORPUS_VERSION_FALLBACK = "2026.09";

/* -------------------------------------------------------------------------- */
/* Canon                                                                       */
/* -------------------------------------------------------------------------- */

export interface CanonDefinition {
  readonly text: string;
  readonly source: string;
  readonly sourceKey: string | null;
  readonly license: string;
}

export interface CanonWord {
  readonly id: string;
  readonly simplified: string;
  readonly traditional: string;
  readonly pinyin: { readonly marked: string; readonly numbered: string };
  readonly pos: readonly string[];
  readonly hsk: {
    readonly band2026: number | null;
    readonly bandRange: string | null;
    readonly band2021: number | null;
    readonly listId: string | null;
  };
  readonly definitions: readonly CanonDefinition[];
  /** Present only once the canon is enriched with frequency data. */
  readonly frequencyRank?: number | null;
  readonly zipf?: number | null;
  readonly radical?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDefinitions(value: unknown): CanonDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: CanonDefinition[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const text = asString(raw["text"]).trim();
    if (text.length === 0) continue;
    out.push({
      text,
      source: asString(raw["source"]),
      sourceKey: typeof raw["sourceKey"] === "string" ? raw["sourceKey"] : null,
      license: asString(raw["license"]),
    });
  }
  return out;
}

/**
 * Reads data/hsk_bands.json. Throws with an actionable message if the canon
 * has not been built; never invents rows.
 */
export function loadCanon(): CanonWord[] {
  if (!existsSync(CANON_PATH)) {
    throw new Error(
      `${CANON_PATH} is missing. Run \`npm run build\` first — the exporters ` +
        `read the canon, they do not build it.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(CANON_PATH, "utf8"));
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["words"])
      ? parsed["words"]
      : null;
  if (!Array.isArray(rows)) {
    throw new Error(`${CANON_PATH} is neither an array nor { words: [...] }.`);
  }

  const words: CanonWord[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = asString(row["id"]);
    const simplified = asString(row["simplified"]);
    if (id.length === 0 || simplified.length === 0) continue;
    const pinyin = isRecord(row["pinyin"]) ? row["pinyin"] : {};
    const hsk = isRecord(row["hsk"]) ? row["hsk"] : {};
    words.push({
      id,
      simplified,
      traditional: asString(row["traditional"]) || simplified,
      pinyin: {
        marked: asString(pinyin["marked"]),
        numbered: asString(pinyin["numbered"]),
      },
      pos: Array.isArray(row["pos"]) ? row["pos"].filter((p): p is string => typeof p === "string") : [],
      hsk: {
        band2026: asNumberOrNull(hsk["band2026"]),
        bandRange: typeof hsk["bandRange"] === "string" ? hsk["bandRange"] : null,
        band2021: asNumberOrNull(hsk["band2021"]),
        listId: typeof hsk["listId"] === "string" ? hsk["listId"] : null,
      },
      definitions: readDefinitions(row["definitions"]),
      frequencyRank: asNumberOrNull(row["frequencyRank"]),
      zipf: asNumberOrNull(row["zipf"]),
      radical: typeof row["radical"] === "string" ? row["radical"] : null,
    });
  }
  if (words.length === 0) throw new Error(`${CANON_PATH} produced zero usable rows.`);
  words.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return words;
}

/** The corpus version recorded by the pack build, so exports do not drift from it. */
export function corpusVersion(): string {
  if (!existsSync(PACK_INDEX_PATH)) return CORPUS_VERSION_FALLBACK;
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACK_INDEX_PATH, "utf8"));
    if (isRecord(parsed) && typeof parsed["corpusVersion"] === "string") {
      return parsed["corpusVersion"];
    }
  } catch {
    /* a half-written index from a concurrent build is not fatal here */
  }
  return CORPUS_VERSION_FALLBACK;
}

/* -------------------------------------------------------------------------- */
/* Bands                                                                       */
/* -------------------------------------------------------------------------- */

/** The seven shipping bands of HSK 3.0 (2026); 7-9 is one band in the syllabus. */
export const BANDS = ["1", "2", "3", "4", "5", "6", "7-9"] as const;
export type BandLabel = (typeof BANDS)[number];

export function bandLabel(word: CanonWord): BandLabel | null {
  const range = word.hsk.bandRange;
  if (range !== null && (BANDS as readonly string[]).includes(range)) {
    return range as BandLabel;
  }
  const band = word.hsk.band2026;
  if (band === null) return null;
  if (band >= 7) return "7-9";
  if (band >= 1 && band <= 6) return String(band) as BandLabel;
  return null;
}

export function bandTitle(band: BandLabel): string {
  return band === "7-9" ? "HSK 7-9" : `HSK ${band}`;
}

/** Lower band = more common = higher Yomitan score. */
export function bandScore(band: BandLabel | null): number {
  if (band === null) return 0;
  return band === "7-9" ? 1 : 8 - Number(band);
}

const POS_LABELS: Readonly<Record<string, string>> = {
  N: "noun",
  V: "verb",
  Adj: "adjective",
  Adv: "adverb",
  Num: "numeral",
  M: "measure word",
  Aux: "auxiliary",
  Pron: "pronoun",
  Prep: "preposition",
  Conj: "conjunction",
  Intj: "interjection",
  Prefix: "prefix",
  Suffix: "suffix",
  Phonetic: "phonetic",
};

export function posLabel(pos: string): string {
  return POS_LABELS[pos] ?? pos.toLowerCase();
}

export function posTag(pos: string): string {
  return pos.toLowerCase();
}

export const ALL_POS: readonly string[] = Object.keys(POS_LABELS);

/* -------------------------------------------------------------------------- */
/* Readings and surface forms                                                  */
/* -------------------------------------------------------------------------- */

/** Tone-marked pinyin exactly as recorded in the canon, notation intact. */
export function markedPinyin(word: CanonWord): string {
  return word.pinyin.marked;
}

/** Space-separated numbered pinyin, e.g. `zhong1 guo2`. */
export function numberedPinyin(word: CanonWord): string {
  return word.pinyin.numbered;
}

const HAN_ONLY = /^[㐀-䶿一-鿿豈-﫿〇]+$/u;
const HEAD_PAREN = /^(.*)（([^（）]*)）(.*)$/u;
const PINYIN_PAREN = /^(.*?)\s*[（(]([^（）()]*)[)）]\s*(.*)$/u;

/**
 * The lookup key for a reading.
 *
 * Yomitan attaches a pronunciation entry only when `data.reading` is character
 * for character equal to the reading on the headword it found (see
 * `Translator._addTermMeta` in yomidevs/yomitan). The one Chinese term
 * dictionary Yomitan recommends is MarvNC/cc-cedict-yomitan, whose reading is
 * lower-cased, space-stripped, tone-marked pinyin (`src/pinyinUtils.ts`).
 * Matching that convention is what lets the pronunciation pack light up on a
 * CC-CEDICT install as well as on ours, so the separators that only exist in
 * printed pinyin — spaces, syllable apostrophes, compound hyphens — come out.
 */
function readingKeyOf(pinyin: string): string {
  return pinyin
    .replace(/[（(][^（）()]*[)）]/gu, "")
    .replace(/[\s'’·-]/gu, "")
    .replace(/…/gu, "")
    .toLocaleLowerCase("en-US");
}

/** One surface form paired with the pinyin that actually belongs to it. */
export interface FormReading {
  /** Pure-Han text as it appears in running prose. */
  readonly form: string;
  /** Lookup key: lower-case, unspaced, notation-free tone-marked pinyin. */
  readonly reading: string;
  /** Tone-marked pinyin for this form, as printed. */
  readonly marked: string;
  /**
   * Numbered pinyin, but only when it is known to describe this exact form.
   * `null` for variant headwords, where the canon's single numbered string
   * describes the primary form and would be wrong on the others.
   */
  readonly numbered: string | null;
}

function cleanForm(text: string): string | null {
  const cleaned = text.replace(/[0-9…]/gu, "").trim();
  if (cleaned.length === 0) return null;
  if (!HAN_ONLY.test(cleaned)) return null;
  return cleaned;
}

/**
 * Resolves one headword variant and its pinyin into surface forms.
 *
 * The HSK 3.0 list writes notation that no running text ever contains, and the
 * pinyin column mirrors it:
 *
 *   `们（朋友们）` / `men (péngyoumen)`   trailing usage example - drop it
 *   `有（一）些`  / `yǒu(yī)xiē`         optional element - both forms are real
 *   `称1`                               homograph index
 *   `…极了`                             slot pattern
 */
function expandVariant(head: string, pinyin: string): { form: string; marked: string }[] {
  const headParen = HEAD_PAREN.exec(head);
  const pinParen = PINYIN_PAREN.exec(pinyin);
  const pinBefore = pinParen?.[1] ?? pinyin;
  const pinInner = pinParen?.[2] ?? "";
  const pinAfter = pinParen?.[3] ?? "";

  if (headParen === null) {
    const form = cleanForm(head);
    return form === null ? [] : [{ form, marked: pinyin.trim() }];
  }

  const before = headParen[1] ?? "";
  const inner = headParen[2] ?? "";
  const after = headParen[3] ?? "";

  if (after.trim().length === 0) {
    // Trailing parenthesis: an example of the word in use, not part of it.
    const form = cleanForm(before);
    return form === null ? [] : [{ form, marked: pinBefore.trim() }];
  }

  // Inner parenthesis: the bracketed element is optional, so both are the word.
  const out: { form: string; marked: string }[] = [];
  const withInner = cleanForm(before + inner + after);
  if (withInner !== null) out.push({ form: withInner, marked: `${pinBefore}${pinInner}${pinAfter}`.trim() });
  const withoutInner = cleanForm(before + after);
  if (withoutInner !== null) out.push({ form: withoutInner, marked: `${pinBefore}${pinAfter}`.trim() });
  return out;
}

/**
 * Every (surface form, reading) pair a word should be findable under.
 *
 * Variants are paired positionally: `哥哥|哥` with `gēge|gē` yields 哥哥/gēge
 * and 哥/gē, not one entry reading `gēge|gē`. When the counts do not line up —
 * the 34 rows where only the traditional column has variants — every form takes
 * the single recorded pinyin. A pinyin holding alternatives separated by `/`
 * (谁 `shéi/shuí`) produces one pair per reading.
 */
export function formReadings(word: CanonWord): FormReading[] {
  const pinVariants = word.pinyin.marked.split("|");
  const fullMarked = word.pinyin.marked;
  const numbered = word.pinyin.numbered.trim();

  const out: FormReading[] = [];
  const seen = new Set<string>();

  for (const headword of [word.simplified, word.traditional]) {
    const heads = headword.split("|");
    for (let i = 0; i < heads.length; i += 1) {
      const head = heads[i] ?? "";
      const pinyin = (pinVariants.length === heads.length ? pinVariants[i] : pinVariants[0]) ?? "";
      for (const { form, marked } of expandVariant(head, pinyin)) {
        for (const alternative of marked.split("/")) {
          const display = alternative.trim();
          const reading = readingKeyOf(display);
          const key = `${form} ${reading}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            form,
            reading,
            marked: display,
            // The numbered column describes the primary reading only.
            numbered: display === fullMarked && numbered.length > 0 ? numbered : null,
          });
        }
      }
    }
  }
  return out;
}

/** The deduplicated surface forms of a word, simplified first. */
export function allSurfaceForms(word: CanonWord): string[] {
  const forms: string[] = [];
  for (const { form } of formReadings(word)) {
    if (!forms.includes(form)) forms.push(form);
  }
  return forms;
}

/* -------------------------------------------------------------------------- */
/* Sentences (optional input)                                                  */
/* -------------------------------------------------------------------------- */

export interface ExampleSentence {
  readonly hanzi: string;
  readonly pinyin: string | null;
  readonly english: string | null;
}

/**
 * Collects the canon word ids a sentence record is linked to.
 *
 * The sentence build emits `headwords: [{ wordId, ... }]`. Note that its
 * sibling field `words` is a list of *surface tokens*, not ids, so it must not
 * be used as a fallback.
 */
function sentenceWordIds(record: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const headwords = record["headwords"];
  if (Array.isArray(headwords)) {
    for (const headword of headwords) {
      if (!isRecord(headword)) continue;
      const wordId = headword["wordId"];
      if (typeof wordId === "string" && wordId.length > 0) ids.push(wordId);
    }
  }
  const wordIds = record["wordIds"];
  if (Array.isArray(wordIds)) {
    for (const wordId of wordIds) {
      if (typeof wordId === "string" && wordId.length > 0) ids.push(wordId);
    }
  }
  return ids;
}

/**
 * data/sentences.jsonl is produced by a separate build step and may not exist.
 * When it is absent the exporters ship without examples rather than inventing
 * them.
 */
export function loadSentencesByWordId(): Map<string, ExampleSentence[]> {
  const byWord = new Map<string, ExampleSentence[]>();
  if (!existsSync(SENTENCES_PATH)) return byWord;

  const text = readFileSync(SENTENCES_PATH, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // a half-written final line from a concurrent build
    }
    if (!isRecord(parsed)) continue;

    const hanzi = asString(parsed["hanzi"]);
    if (hanzi.length === 0) continue;
    const sentence: ExampleSentence = {
      hanzi,
      pinyin: typeof parsed["pinyin"] === "string" ? parsed["pinyin"] : null,
      english: typeof parsed["english"] === "string" ? parsed["english"] : null,
    };

    for (const wordId of sentenceWordIds(parsed)) {
      const bucket = byWord.get(wordId);
      if (bucket === undefined) byWord.set(wordId, [sentence]);
      else if (!bucket.some((existing) => existing.hanzi === sentence.hanzi)) bucket.push(sentence);
    }
  }

  // Deterministic order regardless of file order.
  for (const bucket of byWord.values()) {
    bucket.sort((a, b) => (a.hanzi < b.hanzi ? -1 : a.hanzi > b.hanzi ? 1 : 0));
  }
  return byWord;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A stable non-negative integer of `bits` width derived from a string. */
export function stableInt(input: string, bits: number): number {
  const hex = sha256Hex(input).slice(0, 12); // 48 bits
  const value = Number.parseInt(hex, 16) % 2 ** bits;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Deterministic ZIP writer                                                    */
/* -------------------------------------------------------------------------- */

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  /** Store instead of deflate. Used for data that is already compressed. */
  readonly store?: boolean;
}

/**
 * Minimal ZIP writer: deflate, no data descriptors, no zip64, fixed MS-DOS
 * timestamp of 1980-01-01 so two builds of the same corpus are byte-identical.
 * Both target formats (Yomitan dictionaries, Anki .apkg) are plain zips with
 * every member at the archive root, which is exactly what this emits.
 */
export function zipBuffer(entries: readonly ZipEntry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = entry.store === true ? raw : deflateRawSync(raw, { level: 9 });
    const useStore = entry.store === true || deflated.length >= raw.length;
    const payload = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const checksum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
