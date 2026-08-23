/**
 * TypeScript types and runtime validators for the Yomitan dictionary format.
 *
 * Transcribed by hand from the schemas in yomidevs/yomitan@master, fetched
 * 2026-08-22 from `ext/data/schemas/`:
 *
 *   dictionary-index-schema.json            ($id dictionaryIndex)
 *   dictionary-term-bank-v3-schema.json     ($id dictionaryTermBankV3)
 *   dictionary-term-meta-bank-v3-schema.json ($id dictionaryTermMetaBankV3)
 *   dictionary-tag-bank-v3-schema.json      ($id dictionaryTagBankV3)
 *
 * The validators below are not a general JSON Schema engine; they check exactly
 * what those four schemas constrain — tuple arity, `additionalItems: false`,
 * required properties, `additionalProperties: false`, and every enum — so a
 * malformed bank fails the build rather than Yomitan's importer.
 */

/* -------------------------------------------------------------------------- */
/* index.json                                                                  */
/* -------------------------------------------------------------------------- */

export interface DictionaryIndex {
  readonly title: string;
  readonly revision: string;
  readonly format: 1 | 2 | 3;
  readonly sequenced?: boolean;
  readonly minimumYomitanVersion?: string;
  readonly author?: string;
  readonly url?: string;
  readonly description?: string;
  readonly attribution?: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  readonly frequencyMode?: "occurrence-based" | "rank-based";
  readonly isUpdatable?: true;
  readonly indexUrl?: string;
  readonly downloadUrl?: string;
}

const INDEX_KEYS: readonly string[] = [
  "title",
  "revision",
  "format",
  "version",
  "sequenced",
  "minimumYomitanVersion",
  "author",
  "url",
  "description",
  "attribution",
  "sourceLanguage",
  "targetLanguage",
  "frequencyMode",
  "isUpdatable",
  "indexUrl",
  "downloadUrl",
  "tagMeta",
];

/* -------------------------------------------------------------------------- */
/* Structured content                                                          */
/* -------------------------------------------------------------------------- */

export type StructuredContentStyle = {
  readonly fontStyle?: "normal" | "italic";
  readonly fontWeight?: "normal" | "bold";
  readonly fontSize?: string;
  readonly color?: string;
  readonly background?: string;
  readonly backgroundColor?: string;
  readonly textDecorationLine?: string | readonly string[];
  readonly verticalAlign?: string;
  readonly textAlign?: string;
  readonly margin?: string;
  readonly marginTop?: number | string;
  readonly marginLeft?: number | string;
  readonly marginRight?: number | string;
  readonly marginBottom?: number | string;
  readonly padding?: string;
  readonly listStyleType?: string;
};

export type StructuredContent =
  | string
  | readonly StructuredContent[]
  | { readonly tag: "br"; readonly data?: Readonly<Record<string, string>> }
  | {
      readonly tag: "ruby" | "rt" | "rp" | "table" | "thead" | "tbody" | "tfoot" | "tr";
      readonly content?: StructuredContent;
      readonly data?: Readonly<Record<string, string>>;
      readonly lang?: string;
    }
  | {
      readonly tag: "td" | "th";
      readonly content?: StructuredContent;
      readonly data?: Readonly<Record<string, string>>;
      readonly colSpan?: number;
      readonly rowSpan?: number;
      readonly style?: StructuredContentStyle;
      readonly lang?: string;
    }
  | {
      readonly tag: "span" | "div" | "ol" | "ul" | "li" | "details" | "summary";
      readonly content?: StructuredContent;
      readonly data?: Readonly<Record<string, string>>;
      readonly style?: StructuredContentStyle;
      readonly title?: string;
      readonly open?: boolean;
      readonly lang?: string;
    }
  | {
      readonly tag: "a";
      readonly href: string;
      readonly content?: StructuredContent;
      readonly lang?: string;
    };

const CONTAINER_TAGS = new Set(["ruby", "rt", "rp", "table", "thead", "tbody", "tfoot", "tr"]);
const CELL_TAGS = new Set(["td", "th"]);
const STYLED_TAGS = new Set(["span", "div", "ol", "ul", "li", "details", "summary"]);

/** `^(?:https?:|\?)[\w\W]*` — the pattern the real schema puts on `a.href`. */
const HREF_PATTERN = /^(?:https?:|\?)[\w\W]*/;

/* -------------------------------------------------------------------------- */
/* term_bank_N.json                                                            */
/* -------------------------------------------------------------------------- */

export type TermDefinition =
  | string
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "structured-content"; readonly content: StructuredContent };

/** [term, reading, definitionTags, rules, score, definitions, sequence, termTags] */
export type TermBankEntry = readonly [
  term: string,
  reading: string,
  definitionTags: string | null,
  rules: string,
  score: number,
  definitions: readonly TermDefinition[],
  sequence: number,
  termTags: string,
];

/* -------------------------------------------------------------------------- */
/* term_meta_bank_N.json                                                       */
/* -------------------------------------------------------------------------- */

export type GenericFrequency = string | number | { readonly value: number; readonly displayValue?: string };

export type TermMetaFrequencyEntry = readonly [
  term: string,
  mode: "freq",
  data: GenericFrequency | { readonly reading: string; readonly frequency: GenericFrequency },
];

export interface PhoneticTranscription {
  readonly ipa: string;
  readonly tags?: readonly string[];
}

export type TermMetaIpaEntry = readonly [
  term: string,
  mode: "ipa",
  data: { readonly reading: string; readonly transcriptions: readonly PhoneticTranscription[] },
];

export type TermMetaBankEntry = TermMetaFrequencyEntry | TermMetaIpaEntry;

/* -------------------------------------------------------------------------- */
/* tag_bank_N.json                                                             */
/* -------------------------------------------------------------------------- */

/** [name, category, order, notes, score] */
export type TagBankEntry = readonly [
  name: string,
  category: string,
  order: number,
  notes: string,
  score: number,
];

/**
 * The tag categories Yomitan colours, from docs/making-yomitan-dictionaries.md.
 * Anything else renders with the default styling; it is not an error, but a
 * typo in a category name silently loses the colour, so the build checks it.
 */
export const TAG_CATEGORIES: readonly string[] = [
  "default",
  "name",
  "expression",
  "popular",
  "frequent",
  "archaism",
  "dictionary",
  "frequency",
  "partOfSpeech",
  "search",
  "pronunciation-dictionary",
];

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export class SchemaError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SchemaError";
  }
}

function fail(path: string, message: string): never {
  throw new SchemaError(path, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkStringMap(value: unknown, path: string): void {
  if (!isPlainObject(value)) fail(path, "must be an object of string values");
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") fail(`${path}.${key}`, "must be a string");
  }
}

export function validateStructuredContent(node: unknown, path: string): void {
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      validateStructuredContent(child, `${path}[${String(i)}]`);
    });
    return;
  }
  if (!isPlainObject(node)) fail(path, "must be a string, an array, or an object");

  const tag = node["tag"];
  if (typeof tag !== "string") fail(path, "object nodes require a string `tag`");

  const allowed = new Set<string>(["tag", "data"]);
  if (tag === "br") {
    // nothing further
  } else if (tag === "a") {
    allowed.add("href").add("content").add("lang");
    allowed.delete("data");
    const href = node["href"];
    if (typeof href !== "string") fail(`${path}.href`, "the `a` tag requires a string `href`");
    if (!HREF_PATTERN.test(href)) {
      fail(`${path}.href`, `must match ${String(HREF_PATTERN)} (got ${JSON.stringify(href)})`);
    }
  } else if (CONTAINER_TAGS.has(tag)) {
    allowed.add("content").add("lang");
  } else if (CELL_TAGS.has(tag)) {
    allowed.add("content").add("lang").add("colSpan").add("rowSpan").add("style");
  } else if (STYLED_TAGS.has(tag)) {
    allowed.add("content").add("lang").add("style").add("title").add("open");
  } else {
    fail(`${path}.tag`, `unsupported tag ${JSON.stringify(tag)}`);
  }

  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, `not permitted on tag ${JSON.stringify(tag)}`);
  }
  if ("data" in node) checkStringMap(node["data"], `${path}.data`);
  if ("content" in node) validateStructuredContent(node["content"], `${path}.content`);
  if ("lang" in node && typeof node["lang"] !== "string") fail(`${path}.lang`, "must be a string");
  if ("style" in node && !isPlainObject(node["style"])) fail(`${path}.style`, "must be an object");
}

export function validateIndex(index: unknown, path = "index.json"): void {
  if (!isPlainObject(index)) fail(path, "must be an object");
  if (typeof index["title"] !== "string") fail(`${path}.title`, "required string");
  if (typeof index["revision"] !== "string") fail(`${path}.revision`, "required string");
  const format = index["format"] ?? index["version"];
  if (format !== 1 && format !== 2 && format !== 3) {
    fail(`${path}.format`, "one of `format` or `version` is required and must be 1, 2 or 3");
  }
  for (const key of Object.keys(index)) {
    if (!INDEX_KEYS.includes(key)) fail(`${path}.${key}`, "not a property of the index schema");
  }
  const languageKeys = ["sourceLanguage", "targetLanguage"] as const;
  for (const key of languageKeys) {
    const value = index[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^[a-z]{2,3}$/.test(value)) {
      fail(`${path}.${key}`, "must be an ISO 639-1/639-3 code matching ^[a-z]{2,3}$");
    }
  }
  const frequencyMode = index["frequencyMode"];
  if (frequencyMode !== undefined && frequencyMode !== "occurrence-based" && frequencyMode !== "rank-based") {
    fail(`${path}.frequencyMode`, 'must be "occurrence-based" or "rank-based"');
  }
  if (index["isUpdatable"] !== undefined) {
    if (index["isUpdatable"] !== true) fail(`${path}.isUpdatable`, "must be the constant true");
    if (typeof index["indexUrl"] !== "string" || typeof index["downloadUrl"] !== "string") {
      fail(`${path}.isUpdatable`, "requires both `indexUrl` and `downloadUrl` (schema `dependencies`)");
    }
  }
}

function validateTermDefinition(definition: unknown, path: string): void {
  if (typeof definition === "string") return;
  if (Array.isArray(definition)) {
    // The deinflection form: [uninflectedTerm, [rule, ...]]
    if (definition.length !== 2) fail(path, "a deinflection definition must have exactly 2 items");
    if (typeof definition[0] !== "string") fail(`${path}[0]`, "must be a string");
    if (!Array.isArray(definition[1])) fail(`${path}[1]`, "must be an array of rule strings");
    return;
  }
  if (!isPlainObject(definition)) fail(path, "must be a string, object or deinflection array");
  const type = definition["type"];
  if (type === "text") {
    if (typeof definition["text"] !== "string") fail(`${path}.text`, "required string");
    for (const key of Object.keys(definition)) {
      if (key !== "type" && key !== "text") fail(`${path}.${key}`, "not permitted on a text definition");
    }
    return;
  }
  if (type === "structured-content") {
    if (!("content" in definition)) fail(`${path}.content`, "required");
    for (const key of Object.keys(definition)) {
      if (key !== "type" && key !== "content") {
        fail(`${path}.${key}`, "not permitted on a structured-content definition");
      }
    }
    validateStructuredContent(definition["content"], `${path}.content`);
    return;
  }
  if (type === "image") return; // valid, but this project emits none
  fail(`${path}.type`, 'must be "text", "image" or "structured-content"');
}

export function validateTermBank(bank: unknown, path: string): void {
  if (!Array.isArray(bank)) fail(path, "a term bank must be an array");
  bank.forEach((entry, i) => {
    const at = `${path}[${String(i)}]`;
    if (!Array.isArray(entry)) fail(at, "must be an array");
    if (entry.length !== 8) fail(at, `must have exactly 8 items (got ${String(entry.length)})`);
    if (typeof entry[0] !== "string") fail(`${at}[0] term`, "must be a string");
    if (typeof entry[1] !== "string") fail(`${at}[1] reading`, "must be a string");
    if (entry[2] !== null && typeof entry[2] !== "string") fail(`${at}[2] definitionTags`, "must be a string or null");
    if (typeof entry[3] !== "string") fail(`${at}[3] rules`, "must be a string");
    if (typeof entry[4] !== "number") fail(`${at}[4] score`, "must be a number");
    if (!Array.isArray(entry[5])) fail(`${at}[5] definitions`, "must be an array");
    (entry[5] as unknown[]).forEach((definition, j) => {
      validateTermDefinition(definition, `${at}[5][${String(j)}]`);
    });
    if (!Number.isInteger(entry[6])) fail(`${at}[6] sequence`, "must be an integer");
    if (typeof entry[7] !== "string") fail(`${at}[7] termTags`, "must be a string");
  });
}

function validateGenericFrequency(data: unknown, path: string): void {
  if (typeof data === "string" || typeof data === "number") return;
  if (!isPlainObject(data)) fail(path, "must be a string, a number, or a {value, displayValue} object");
  if (typeof data["value"] !== "number") fail(`${path}.value`, "required number");
  for (const key of Object.keys(data)) {
    if (key !== "value" && key !== "displayValue") fail(`${path}.${key}`, "not permitted on a frequency object");
  }
  if (data["displayValue"] !== undefined && typeof data["displayValue"] !== "string") {
    fail(`${path}.displayValue`, "must be a string");
  }
}

export function validateTermMetaBank(bank: unknown, path: string): void {
  if (!Array.isArray(bank)) fail(path, "a term meta bank must be an array");
  bank.forEach((entry, i) => {
    const at = `${path}[${String(i)}]`;
    if (!Array.isArray(entry)) fail(at, "must be an array");
    if (entry.length !== 3) fail(at, `must have exactly 3 items (got ${String(entry.length)})`);
    if (typeof entry[0] !== "string") fail(`${at}[0] term`, "must be a string");
    const mode: unknown = entry[1];
    if (mode !== "freq" && mode !== "pitch" && mode !== "ipa") {
      fail(`${at}[1] mode`, 'must be "freq", "pitch" or "ipa"');
    }
    const data: unknown = entry[2];
    if (mode === "freq") {
      if (isPlainObject(data) && "reading" in data) {
        if (typeof data["reading"] !== "string") fail(`${at}[2].reading`, "must be a string");
        if (!("frequency" in data)) fail(`${at}[2].frequency`, "required alongside `reading`");
        for (const key of Object.keys(data)) {
          if (key !== "reading" && key !== "frequency") fail(`${at}[2].${key}`, "not permitted");
        }
        validateGenericFrequency(data["frequency"], `${at}[2].frequency`);
      } else {
        validateGenericFrequency(data, `${at}[2]`);
      }
      return;
    }
    if (mode === "ipa") {
      if (!isPlainObject(data)) fail(`${at}[2]`, "must be an object");
      if (typeof data["reading"] !== "string") fail(`${at}[2].reading`, "required string");
      const transcriptions: unknown = data["transcriptions"];
      if (!Array.isArray(transcriptions)) fail(`${at}[2].transcriptions`, "required array");
      for (const key of Object.keys(data)) {
        if (key !== "reading" && key !== "transcriptions") fail(`${at}[2].${key}`, "not permitted");
      }
      transcriptions.forEach((transcription, j) => {
        const tp = `${at}[2].transcriptions[${String(j)}]`;
        if (!isPlainObject(transcription)) fail(tp, "must be an object");
        if (typeof transcription["ipa"] !== "string") fail(`${tp}.ipa`, "required string");
        for (const key of Object.keys(transcription)) {
          if (key !== "ipa" && key !== "tags") fail(`${tp}.${key}`, "not permitted");
        }
        const tags: unknown = transcription["tags"];
        if (tags !== undefined) {
          if (!Array.isArray(tags)) fail(`${tp}.tags`, "must be an array of strings");
          tags.forEach((tag, k) => {
            if (typeof tag !== "string") fail(`${tp}.tags[${String(k)}]`, "must be a string");
          });
        }
      });
      return;
    }
    fail(`${at}[1] mode`, "pitch entries are not emitted by this project");
  });
}

export function validateTagBank(bank: unknown, path: string): void {
  if (!Array.isArray(bank)) fail(path, "a tag bank must be an array");
  bank.forEach((entry, i) => {
    const at = `${path}[${String(i)}]`;
    if (!Array.isArray(entry)) fail(at, "must be an array");
    if (entry.length !== 5) fail(at, `must have exactly 5 items (got ${String(entry.length)})`);
    if (typeof entry[0] !== "string") fail(`${at}[0] name`, "must be a string");
    if (typeof entry[1] !== "string") fail(`${at}[1] category`, "must be a string");
    if (typeof entry[2] !== "number") fail(`${at}[2] order`, "must be a number");
    if (typeof entry[3] !== "string") fail(`${at}[3] notes`, "must be a string");
    if (typeof entry[4] !== "number") fail(`${at}[4] score`, "must be a number");
    if (!TAG_CATEGORIES.includes(entry[1] as string)) {
      fail(`${at}[1] category`, `unknown tag category ${JSON.stringify(entry[1])}`);
    }
  });
}
