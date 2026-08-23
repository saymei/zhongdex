/**
 * Zhongdex MCP — the six tools (§5.1) and their handlers.
 *
 * This module is transport-agnostic on purpose: it exports plain tool
 * descriptors and a `callTool` dispatcher over a loaded corpus, so adding a
 * streamable-HTTP transport later means writing a new server entry point, not
 * touching the tool layer.
 *
 * Deterministic tool order is required for prompt-cache hits, so `TOOLS` is
 * ordered lookup → find_words → find_sentences → audio → build_deck → packs and
 * must stay that way.
 *
 * Schema rules applied without exception:
 *   - `additionalProperties: false` on every inputSchema, paired with E8, which
 *     names the legal set (the schema alone does not tell the model what to do).
 *   - every optional parameter has a default that makes the common case a
 *     one-liner: `mandarin_lookup({words:["你好"]})` returns a deck-ready record.
 *   - any parameter with fewer than twelve legal values is an enum, never free text.
 *   - no `$ref`, no `oneOf`: it is unvalidated whether models parse them reliably.
 *   - `outputSchema` is declared on `mandarin_build_deck` only. Declaring it
 *     obliges conforming `structuredContent` on every call, and the spec says a
 *     tool returning structured content SHOULD also serialise it into text —
 *     which would double every lookup response for no gain.
 */

import {
    bandOf,
    editDistance,
    numberedKey,
    packWords,
    type Corpus,
    type PackRecord,
    type SentenceRecord,
    type WordRecord,
} from './data.js';
import {
    DECK_FIELDS,
    e10MissingCombination,
    e11UnknownPattern,
    e12StaleCursor,
    e13BatchCap,
    e14UnknownField,
    e16Truncated,
    e17UnknownPack,
    e1NotChinese,
    e2NotAHeadword,
    e3Polyphone,
    e5BadPinyin,
    e6Bounded,
    e6OutOfRange,
    e7BadEnum,
    e8UnknownParameter,
    e9Empty,
    matchCount,
    nearest,
    rankRelaxations,
    ToolError,
    type Relaxation,
} from './errors.js';
import {
    decodeCursor,
    encodeCursor,
    envelopeFooter,
    estimateTokens,
    fitToBudget,
    listFooter,
    renderPack,
    renderSentence,
    renderWord,
    renderWordLine,
    type DetailRung,
} from './format.js';

/* ── shapes ──────────────────────────────────────────────────────────────── */

export interface JsonSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
}

export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema?: Record<string, unknown>;
    annotations: {
        title: string;
        readOnlyHint: true;
        destructiveHint: false;
        idempotentHint: true;
        openWorldHint: false;
    };
}

export interface ToolResult {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

type Args = Record<string, unknown>;

/**
 * Every tool is a read of a prebuilt index over a fixed corpus with no outbound
 * calls, so all four annotations are literally true. The defaults are hostile —
 * an omitted annotation advertises a destructive, non-idempotent, open-world
 * write — and missing annotations are a named rejection cause in both
 * Anthropic's connector review criteria and OpenAI's app submission guidelines.
 */
function annotations(title: string): ToolDefinition['annotations'] {
    return {
        title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    };
}

/**
 * The six descriptions from §5.1a, verbatim. They are the interface; do not
 * paraphrase them. Where a description promises MP3 URLs, {@link AUDIO_PENDING}
 * is appended — an addition, not a rewrite — because there is no audio hosting
 * in 0.1 and a description that promises a URL the server cannot return is the
 * one failure the agent has no way to recover from.
 */
const AUDIO_PENDING =
    '\n\n0.1 status: audio hosting is not live. No tool returns an audio URL; every audio field reports status "pending" instead.';

/**
 * Measured, not asserted, and stated where an agent will see it before it
 * builds study material. A blind read of 42 sentences found roughly 75% clearly
 * natural, 15% awkward but parseable and 8-10% clearly broken, concentrated on
 * band 7 and single-character headwords. This is source-data quality; no
 * computable gate catches it, so the only honest option is to say so.
 */
const SENTENCE_QUALITY =
    '\n\nQuality caveat, measured on a 42-sentence sample: about 75% read as clearly natural, 15% as awkward but parseable, and 8-10% as clearly broken - concentrated on band 7 and on single-character headwords (e.g. a character used as a surname that is not one). Review band-7 results before putting them in front of a learner.';

const DESCRIPTIONS = {
    lookup:
        'Look up Chinese (Mandarin) words you already know the spelling of, and get everything needed to make a flashcard in one call: simplified and traditional hanzi, tone-marked and numbered pinyin, English gloss, part of speech, measure words, the HSK band in all three standards, frequency rank, and direct MP3 URLs in a female (Amy) and a male (James) native voice — plus up to 3 example sentences per word, each graded by difficulty and each with its own audio in both voices. Batch up to 20 words per call. Use this when you already have the words. To FIND words by level, topic or frequency, call mandarin_find_words first and pass its ids here. Accepts simplified hanzi ("你好"), traditional, or numbered pinyin ("ni3 hao3"). For a character with more than one reading, append the reading to pin it: "行:hang2"; without one, every reading is returned. Read-only, free, no API key, no rate limit, no quota. Identical arguments always return an identical response within a release.',
    findWords:
        'Find Chinese (Mandarin) words by criteria rather than by spelling: HSK level, frequency band, topic, curated pack, or a text query in English, pinyin or hanzi. Returns a compact list of word ids with hanzi and pinyin — pass those ids to mandarin_lookup for full records, or straight to mandarin_build_deck. This is the right first call for "build me an HSK 3 deck", "the 200 most common verbs", "words about food". All filters are optional and AND together. band_standard defaults to HSK 3.0 (2026 revision), which is 40-60% smaller at levels 1-5 than the 2021 revision — set it explicitly if you need the older list. hsk:3 means exactly band 3; pass scope:\'cumulative\' for bands 1-3. Cursor-paginated, max 100 per page; every response states the total so you know the size of the set before fetching more. Read-only, free, no API key, no rate limit.',
    findSentences:
        "Find example Chinese sentences in a 467,000-sentence corpus, filtered the way a teacher or a deck-maker actually filters: by a word or character that must appear (contains), by named grammar pattern (162 of them, e.g. 'ba-disposal', 'bei-passive', 'le-change-of-state'), by difficulty 1-7 (the highest HSK 3.0 band of any word in the sentence), and by max_new_words — how many words in the sentence fall outside a given HSK level. max_new_words:1 gives true i+1 sentences where the target word is the only unknown; no other Mandarin source exposes that filter. Every sentence returns hanzi, tone-marked and numbered pinyin, English, its difficulty grade, and MP3 URLs in a female and a male voice. If you only want the 2-3 curated sentences that belong to a specific headword, use mandarin_lookup instead. Read-only, free, no API key, no rate limit.",
    audio:
        "Get an existing MP3 recording of Mandarin text in a female (Amy) or male (James) native voice, without generating anything. Covers 186,000 single words, 177,000 sentences, 79,000 recorded dialogue lines, and the full pinyin syllable chart. Three uses: (1) check whether a recording exists before you pay a TTS provider — pass up to 100 strings with check_only:true and get a yes/no per string in a few hundred tokens; (2) fetch the URL for text you already have; (3) pass a bare pinyin syllable ('zhi1') or a tone pair ('2-3') for pronunciation-drill audio and minimal-pair contrasts. Returns URLs, never bytes, unless you set inline:true for a single clip — one base64 MP3 costs about 19,000 tokens and a URL costs about 15. Nothing is synthesised on demand: text outside the corpus returns a clean miss, never a bill. Read-only, free, no API key, no rate limit.",
    buildDeck:
        "Turn a list of Chinese words into a ready-to-import flashcard deck. Returns three things: notes[] — an array shaped exactly like the notes argument of the Anki MCP server's addNotes tool, with [sound:...] references already written into the fields; media[] — one {filename, url} object per clip, shaped exactly like the arguments of that server's storeMediaFile tool; and next_steps — the literal sequence of calls to make. Store the media first: a note whose audio is not yet in the collection shows a broken reference. Maximum 100 words per call, the same cap addNotes enforces, so one build maps to exactly one addNotes call; for more, page mandarin_find_words and call this once per page. Accepts a pack id instead of a word list, and exclude_packs to subtract words the learner already knows. format defaults to 'anki-mcp'; set 'anki-csv', 'tsv', 'json' or 'pleco' to get a downloadable file, returned as a link rather than inline. Read-only — building a deck creates nothing on our side. Free, no API key, no rate limit.",
    packs:
        "List the 54 ready-made Chinese vocabulary packs — HSK bands under both the 2026 and 2021 syllabus, frequency tiers (Core 500 through Core 5000), measure words, high-yield radicals, separable verbs, slang, words that look alike, sung vocabulary, graded sentence sets, tone pairs, and 23 topic packs. Each entry gives the pack id, size, what it is band-closed at, and its audio coverage. The whole catalogue is about 2,000 tokens, so calling this first is cheaper than searching. Pass a pack id to mandarin_find_words({pack:...}) for the words, or straight to mandarin_build_deck({pack:...}) for a deck. Every pack's word list is generated by a published deterministic query over the corpus, not written by a model, and re-derives on every monthly release. Read-only, free, no API key, no rate limit.",
} as const;

const VOICES = ['both', 'female', 'male'] as const;
const STANDARDS = ['hsk2026', 'hsk2021', 'hsk2_0'] as const;
const DECK_FORMATS = ['anki-mcp', 'anki-csv', 'tsv', 'json', 'pleco'] as const;

type Standard = (typeof STANDARDS)[number];

/** Band count per standard. Out-of-range never clamps; it raises E6. */
const BANDS: Record<Standard, number> = { hsk2026: 7, hsk2021: 9, hsk2_0: 6 };

/* ── tool definitions ────────────────────────────────────────────────────── */

export const TOOLS: readonly ToolDefinition[] = [
    {
        name: 'mandarin_lookup',
        title: 'Look up Chinese words',
        description: DESCRIPTIONS.lookup + AUDIO_PENDING,
        annotations: annotations('Look up Chinese words'),
        inputSchema: {
            type: 'object',
            properties: {
                words: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 20,
                    description:
                        'Simplified hanzi, traditional hanzi, or numbered pinyin. Append a reading to pin a polyphone: "行:hang2".',
                },
                sentences: { type: 'integer', minimum: 0, maximum: 3, default: 2 },
                voice: { type: 'string', enum: [...VOICES], default: 'both' },
                script: {
                    type: 'string',
                    enum: ['simplified', 'traditional', 'both'],
                    default: 'simplified',
                },
                response_format: {
                    type: 'string',
                    enum: ['concise', 'detailed', 'json'],
                    default: 'concise',
                },
            },
            required: ['words'],
            additionalProperties: false,
        },
    },
    {
        name: 'mandarin_find_words',
        title: 'Find Chinese words by criteria',
        description: DESCRIPTIONS.findWords,
        annotations: annotations('Find Chinese words by criteria'),
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', maxLength: 64 },
                query_type: {
                    type: 'string',
                    enum: ['auto', 'hanzi', 'pinyin', 'english'],
                    default: 'auto',
                },
                hsk: { type: 'integer', minimum: 1, maximum: 9 },
                band_standard: { type: 'string', enum: [...STANDARDS], default: 'hsk2026' },
                scope: {
                    type: 'string',
                    enum: ['band', 'cumulative'],
                    default: 'band',
                    description: "'band' is exactly that band; 'cumulative' is bands 1..n.",
                },
                freq_min: { type: 'integer', minimum: 1 },
                freq_max: { type: 'integer', minimum: 1 },
                topic: { type: 'string', description: 'One of the published topic pack slugs.' },
                pack: { type: 'string', description: 'One of the pack ids from mandarin_packs.' },
                has_audio: {
                    type: 'string',
                    enum: ['any', 'both_voices', 'female', 'male'],
                    default: 'any',
                },
                order: {
                    type: 'string',
                    enum: ['frequency', 'hsk', 'alphabetical'],
                    default: 'frequency',
                },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                cursor: { type: 'string' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'mandarin_find_sentences',
        title: 'Find Chinese example sentences',
        description: DESCRIPTIONS.findSentences + AUDIO_PENDING + SENTENCE_QUALITY,
        annotations: annotations('Find Chinese example sentences'),
        inputSchema: {
            type: 'object',
            properties: {
                contains: { type: 'string', maxLength: 16 },
                pattern: { type: 'string', description: 'A grammar pattern id.' },
                word: { type: 'string' },
                hsk: { type: 'integer', minimum: 1, maximum: 9 },
                band_standard: { type: 'string', enum: [...STANDARDS], default: 'hsk2026' },
                difficulty: { type: 'integer', minimum: 1, maximum: 7 },
                max_new_words: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 5,
                    description: 'Requires hsk. Words in the sentence outside that level.',
                },
                count: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
                voice: { type: 'string', enum: [...VOICES], default: 'both' },
                cursor: { type: 'string' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'mandarin_audio',
        title: 'Fetch or check Mandarin recordings',
        description: DESCRIPTIONS.audio + AUDIO_PENDING,
        annotations: annotations('Fetch or check Mandarin recordings'),
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
                voice: { type: 'string', enum: [...VOICES], default: 'both' },
                check_only: { type: 'boolean', default: false },
                inline: {
                    type: 'boolean',
                    default: false,
                    description: 'Base64 a single clip. Rejected when text has more than one entry.',
                },
                contrast: { type: 'boolean', default: false },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'mandarin_build_deck',
        title: 'Build an import-ready flashcard deck',
        description: DESCRIPTIONS.buildDeck + AUDIO_PENDING,
        annotations: annotations('Build an import-ready flashcard deck'),
        inputSchema: {
            type: 'object',
            properties: {
                words: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
                pack: { type: 'string' },
                exclude_packs: { type: 'array', items: { type: 'string' } },
                deck_name: { type: 'string', default: 'Zhongdex::HSK' },
                model_name: { type: 'string', default: 'Zhongdex Mandarin' },
                fields: { type: 'array', items: { type: 'string', enum: [...DECK_FIELDS] } },
                format: { type: 'string', enum: [...DECK_FORMATS], default: 'anki-mcp' },
                voice: { type: 'string', enum: [...VOICES], default: 'female' },
                sentences: { type: 'integer', minimum: 0, maximum: 2, default: 1 },
                tags: { type: 'array', items: { type: 'string' }, default: ['zhongdex'] },
            },
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: {
                deck_name: { type: 'string' },
                model_name: { type: 'string' },
                media: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { filename: { type: 'string' }, url: { type: 'string' } },
                        required: ['filename', 'url'],
                        additionalProperties: false,
                    },
                },
                notes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            fields: { type: 'object', additionalProperties: { type: 'string' } },
                            tags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['fields'],
                        additionalProperties: false,
                    },
                },
                next_steps: { type: 'string' },
                audio_status: { type: 'string', enum: ['available', 'pending'] },
            },
            required: ['deck_name', 'model_name', 'media', 'notes', 'next_steps', 'audio_status'],
            additionalProperties: false,
        },
    },
    {
        name: 'mandarin_packs',
        title: 'List the curated vocabulary packs',
        description: DESCRIPTIONS.packs,
        annotations: annotations('List the curated vocabulary packs'),
        inputSchema: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    enum: ['band', 'frequency', 'theme', 'form', 'grammar', 'media'],
                },
                level: { type: 'integer', minimum: 1, maximum: 7 },
                q: { type: 'string', maxLength: 32 },
                limit: { type: 'integer', minimum: 1, maximum: 60, default: 60 },
            },
            additionalProperties: false,
        },
    },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ── argument reading ────────────────────────────────────────────────────── */

/** E8 — reject an invented parameter by name and list the legal set. */
function checkKeys(tool: ToolDefinition, args: Args): void {
    const accepted = Object.keys(tool.inputSchema.properties);
    for (const key of Object.keys(args)) {
        if (!accepted.includes(key)) throw new ToolError(e8UnknownParameter(tool.name, key, accepted));
    }
}

function readEnum<T extends string>(
    args: Args,
    key: string,
    allowed: readonly T[],
    fallback: T
): T {
    const v = args[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
        throw new ToolError(e7BadEnum(key, allowed, String(v)));
    }
    return v as T;
}

/** E6 — bounded integer, never clamped. */
function readInt(
    args: Args,
    key: string,
    min: number,
    max: number,
    fallback: number,
    why: string
): number {
    const v = args[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ToolError(e6Bounded(key, min, max, Number(v), why));
    }
    if (v < min || v > max) throw new ToolError(e6Bounded(key, min, max, v, why));
    return v;
}

function readOptionalInt(args: Args, key: string, min: number, max: number, why: string): number | null {
    if (args[key] === undefined || args[key] === null) return null;
    return readInt(args, key, min, max, min, why);
}

function readBool(args: Args, key: string, fallback: boolean): boolean {
    const v = args[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') throw new ToolError(e7BadEnum(key, ['true', 'false'], String(v)));
    return v;
}

function readString(args: Args, key: string, maxLength: number): string | null {
    const v = args[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new ToolError(e7BadEnum(key, ['a string'], String(v)));
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > maxLength) {
        throw new ToolError(
            `${key} must be at most ${maxLength} characters; you passed ${trimmed.length}. Shorten it and call again.`
        );
    }
    return trimmed;
}

function readStringArray(args: Args, key: string, min: number, max: number, tool: string, why: string): string[] {
    const v = args[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
        throw new ToolError(`${key} must be an array of strings. You passed ${typeof v}. Wrap it: ${key}:["${String(v)}"].`);
    }
    const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((s) => s.length > 0);
    if (out.length < min) {
        throw new ToolError(`${key} needs at least ${min} entry. You passed ${out.length}.`);
    }
    if (out.length > max) throw new ToolError(e13BatchCap(tool, max, out.length, why));
    return out;
}

/** Render a literal call an agent can paste back. Used by every `Next:` clause. */
function renderCall(tool: string, args: Args): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        parts.push(`${key}:${JSON.stringify(value)}`);
    }
    return `${tool}({${parts.join(', ')}})`;
}

function text(body: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text: body }], isError };
}

/* ── 1. mandarin_lookup ──────────────────────────────────────────────────── */

const HAN = /\p{Script=Han}/u;
const ALL_HAN = /^\p{Script=Han}+$/u;
const PINYIN_ISH = /^[a-zü:'\s0-9]+$/i;

/** The numbered pinyin of some headword, ignoring tones. Distinguishes E5 from E1. */
function tonelessMatch(corpus: Corpus, term: string): string | null {
    const stripped = numberedKey(term).replace(/[1-5]/g, '');
    if (stripped.length === 0) return null;
    for (const [key, bucket] of corpus.byNumbered) {
        if (key.replace(/[1-5]/g, '') === stripped) return bucket[0]?.pinyinNumbered ?? null;
    }
    return null;
}

interface LookupHit {
    word: WordRecord;
    note: string | null;
}

function resolveTerm(
    corpus: Corpus,
    term: string,
    missIndex: number,
    total: number
): { hits: WordRecord[]; note: string | null } {
    const colon = term.lastIndexOf(':');
    if (colon > 0 && HAN.test(term.slice(0, colon))) {
        const head = term.slice(0, colon);
        const reading = numberedKey(term.slice(colon + 1));
        const all = corpus.bySimplified.get(head) ?? corpus.byTraditional.get(head) ?? [];
        const pinned = all.filter(
            (w) => w.pinyinNumbered !== null && numberedKey(w.pinyinNumbered) === reading
        );
        if (pinned.length > 0) return { hits: pinned, note: null };
        if (all.length > 0) {
            const readings = all
                .map((w) => w.pinyinNumbered)
                .filter((p): p is string => p !== null)
                .map((p) => numberedKey(p));
            throw new ToolError(
                `${head} has no reading "${term.slice(colon + 1)}". Readings on file: ${readings.join(', ')}. ` +
                    `Next: mandarin_lookup({words:["${head}:${readings[0] ?? ''}"]}).`
            );
        }
    }

    const direct = corpus.bySimplified.get(term) ?? corpus.byTraditional.get(term);
    if (direct !== undefined && direct.length > 0) {
        const note =
            direct.length > 1
                ? e3Polyphone(
                      term,
                      direct.map((w) => (w.pinyinNumbered === null ? w.pinyin : numberedKey(w.pinyinNumbered)))
                  )
                : null;
        return { hits: direct, note };
    }

    if (ALL_HAN.test(term)) {
        // E2: real hanzi, not a headword. Segment greedily against the index.
        const segments: { hanzi: string; id: string }[] = [];
        const unknown: string[] = [];
        let run = '';
        let i = 0;
        const chars = [...term];
        while (i < chars.length) {
            let matched = false;
            for (let len = Math.min(4, chars.length - i); len >= 1; len--) {
                const candidate = chars.slice(i, i + len).join('');
                const found = corpus.bySimplified.get(candidate)?.[0];
                if (found !== undefined) {
                    if (run !== '') {
                        unknown.push(run);
                        run = '';
                    }
                    if (!segments.some((seg) => seg.hanzi === candidate)) {
                        segments.push({ hanzi: candidate, id: found.id });
                    }
                    i += len;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                run += chars[i] ?? '';
                i += 1;
            }
        }
        if (run !== '') unknown.push(run);
        throw new ToolError(e2NotAHeadword(term, segments, unknown));
    }

    // Pinyin, but only if it carries a tone digit or spells a real headword's
    // syllables. Without that test "zzzz" reads as broken pinyin instead of as
    // the English word it probably is, and E1 never fires.
    if (PINYIN_ISH.test(term) && /[a-z]/i.test(term)) {
        const hits = corpus.byNumbered.get(numberedKey(term));
        if (hits !== undefined && hits.length > 0) {
            const note =
                hits.length > 1
                    ? `${term} matches ${hits.length} headwords; all are returned below.`
                    : null;
            return { hits, note };
        }
        const syllables = term.toLowerCase().match(/[a-zü:]+[1-5]?/g) ?? [];
        const toneless = syllables.find((s) => !/[1-5]$/.test(s));
        if (toneless !== undefined) {
            const suggestion = tonelessMatch(corpus, term);
            if (/[1-5]/.test(term) || suggestion !== null) {
                throw new ToolError(e5BadPinyin(term, toneless, suggestion));
            }
        }
    }

    // E1: neither Han nor valid numbered pinyin.
    const near: string[] = [];
    for (const word of corpus.words) {
        if (near.length >= 3) break;
        if (Math.abs(word.simplified.length - term.length) > 2) continue;
        if (editDistance(term, word.simplified, 2) <= 2) near.push(word.simplified);
    }
    throw new ToolError(e1NotChinese(term, missIndex, total, near));
}

function runLookup(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const words = readStringArray(
        args,
        'words',
        1,
        20,
        'mandarin_lookup',
        'The cap keeps one lookup inside the 10,000-token client warning.'
    );
    if (words.length === 0) {
        throw new ToolError(
            'mandarin_lookup needs words. Next: mandarin_lookup({words:["你好"]}), or call mandarin_find_words first to select a set.'
        );
    }
    const sentences = readInt(args, 'sentences', 0, 3, 2, 'Each word carries at most 3 curated sentences.');
    readEnum(args, 'voice', VOICES, 'both');
    const script = readEnum(args, 'script', ['simplified', 'traditional', 'both'] as const, 'simplified');
    const format = readEnum(args, 'response_format', ['concise', 'detailed', 'json'] as const, 'concise');

    const hits: LookupHit[] = [];
    const misses: string[] = [];
    for (const term of words) {
        try {
            const resolved = resolveTerm(corpus, term, misses.length + 1, words.length);
            let first = true;
            for (const word of resolved.hits) {
                hits.push({ word, note: first ? resolved.note : null });
                first = false;
            }
        } catch (error) {
            if (error instanceof ToolError) misses.push(error.message);
            else throw error;
        }
    }

    if (hits.length === 0) {
        return text([...misses, envelopeFooter(corpus)].join('\n\n'), true);
    }

    if (format === 'json') {
        const payload = hits.map(({ word }) => ({
            id: word.id,
            simplified: word.simplified,
            traditional: word.traditional,
            pinyin: word.pinyin,
            pinyin_numbered: word.pinyinNumbered,
            pos: word.pos,
            gloss: word.gloss,
            measure_words: word.measureWords,
            hsk: { hsk2026: word.hsk2026, hsk2021: word.hsk2021, hsk2_0: word.hsk2 },
            freq: word.freq,
            packs: word.packs,
            audio: { status: corpus.audioHosting ? 'available' : 'pending' },
            sentences: word.sentenceIds
                .map((id) => corpus.sentencesById.get(id))
                .filter((s): s is SentenceRecord => s !== undefined)
                .slice(0, sentences)
                .map((s) => ({
                    id: s.id,
                    hanzi: s.hanzi,
                    pinyin: s.pinyin,
                    english: s.english,
                    difficulty: s.difficulty,
                    audio: { status: corpus.audioHosting ? 'available' : 'pending' },
                })),
        }));
        return text(
            `${JSON.stringify({ words: payload, misses, release: corpus.version }, null, 1)}\n${envelopeFooter(corpus)}`
        );
    }

    const render = (rung: DetailRung, upTo: number): string => {
        const blocks: string[] = [];
        for (const { word, note } of hits.slice(0, upTo)) {
            if (note !== null) blocks.push(`> ${note}`);
            blocks.push(
                renderWord(corpus, word, {
                    sentences,
                    script,
                    detailed: format === 'detailed',
                    rung,
                })
            );
        }
        if (misses.length > 0) blocks.push(misses.join('\n\n'));
        blocks.push(envelopeFooter(corpus));
        return blocks.join('\n\n');
    };

    const body = fitToBudget(hits.length, render, (returned, asked) =>
        e16Truncated(
            10_000,
            returned,
            asked,
            'Pass sentences:0 to drop the example block, or split into two calls.'
        )
    );
    // Partial success beats an error: misses ride along with `isError: false`.
    return text(body);
}

/* ── 2. mandarin_find_words ──────────────────────────────────────────────── */

interface WordFilter {
    key: string;
    label: string;
    test: (word: WordRecord) => boolean;
    /** How to describe dropping it, and the args that result. */
    relaxed: Args;
    describe: string;
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Is `needle` a subsequence of `hay`? `hsk7` matches `hsk-2026-t7`, which plain edit distance does not. */
function isSubsequence(needle: string, hay: string): boolean {
    let i = 0;
    for (const ch of hay) {
        if (ch === needle[i]) i++;
        if (i === needle.length) return true;
    }
    return needle.length === 0;
}

function packOrThrow(corpus: Corpus, slug: string, param: 'pack' | 'topic'): PackRecord {
    const pack = corpus.packsBySlug.get(slug);
    if (pack !== undefined) return pack;
    const pool = corpus.packs.filter((p) => (param === 'topic' ? p.kind === 'theme' : true));
    if (pool.length === 0 && param === 'topic') {
        throw new ToolError(
            `No topic "${slug}": release ${corpus.version} ships no topic packs yet. ` +
                'Next: call mandarin_packs() and pass one of its ids as pack, e.g. mandarin_find_words({pack:"hsk-2026-t1"}).'
        );
    }
    const needle = alnum(slug);
    const scored = pool
        .map((p) => ({
            pack: p,
            sub: isSubsequence(needle, alnum(p.slug)),
            near: nearest(slug, [p.slug], 4) !== null,
        }))
        .filter((c) => c.sub || c.near)
        .sort((a, b) => (a.sub ? 0 : 1) - (b.sub ? 0 : 1) || a.pack.slug.length - b.pack.slug.length)
        .slice(0, 2)
        .map((c) => ({ slug: c.pack.slug, size: c.pack.size }));
    throw new ToolError(e17UnknownPack(slug, scored, pool.length));
}

function buildWordFilters(corpus: Corpus, args: Args): { filters: WordFilter[]; base: Args } {
    const filters: WordFilter[] = [];
    const base: Args = {};

    const standard = readEnum(args, 'band_standard', STANDARDS, 'hsk2026');
    if (args['band_standard'] !== undefined) base['band_standard'] = standard;
    const scope = readEnum(args, 'scope', ['band', 'cumulative'] as const, 'band');
    if (args['scope'] !== undefined) base['scope'] = scope;

    const hsk = args['hsk'];
    if (hsk !== undefined && hsk !== null) {
        if (typeof hsk !== 'number' || !Number.isInteger(hsk) || hsk < 1 || hsk > BANDS[standard]) {
            throw new ToolError(e6OutOfRange(standard, Number(hsk)));
        }
        base['hsk'] = hsk;
        filters.push({
            key: 'hsk',
            label: `hsk ${hsk} (${standard}, ${scope})`,
            test: (w) => {
                const band = bandOf(w, standard);
                if (band === null) return false;
                return scope === 'cumulative' ? band <= hsk : band === hsk;
            },
            relaxed: { scope: 'cumulative' },
            describe: `widening hsk ${hsk} to scope:'cumulative'`,
        });
    }

    const query = readString(args, 'query', 64);
    if (query !== null) {
        base['query'] = query;
        const queryType = readEnum(
            args,
            'query_type',
            ['auto', 'hanzi', 'pinyin', 'english'] as const,
            'auto'
        );
        if (args['query_type'] !== undefined) base['query_type'] = queryType;
        const resolved =
            queryType !== 'auto'
                ? queryType
                : HAN.test(query)
                  ? 'hanzi'
                  : /[1-5]/.test(query)
                    ? 'pinyin'
                    : 'english';
        const needle = query.toLowerCase();
        const pinyinNeedle = numberedKey(query);
        filters.push({
            key: 'query',
            label: `query "${query}" (${resolved})`,
            test: (w) => {
                if (resolved === 'hanzi') return w.simplified.includes(query) || w.traditional.includes(query);
                if (resolved === 'pinyin') {
                    return w.pinyinNumbered !== null && numberedKey(w.pinyinNumbered).includes(pinyinNeedle);
                }
                return w.gloss.some((g) => g.toLowerCase().includes(needle));
            },
            relaxed: {},
            describe: `dropping query "${query}"`,
        });
    }

    const topic = readString(args, 'topic', 64);
    if (topic !== null) {
        const pack = packOrThrow(corpus, topic, 'topic');
        base['topic'] = topic;
        const members = new Set(packWords(corpus, pack).map((w) => w.id));
        filters.push({
            key: 'topic',
            label: `topic ${topic}`,
            test: (w) => members.has(w.id),
            relaxed: {},
            describe: `dropping topic ${topic}`,
        });
    }

    const packSlug = readString(args, 'pack', 64);
    if (packSlug !== null) {
        const pack = packOrThrow(corpus, packSlug, 'pack');
        base['pack'] = packSlug;
        const members = new Set(packWords(corpus, pack).map((w) => w.id));
        filters.push({
            key: 'pack',
            label: `pack ${packSlug}`,
            test: (w) => members.has(w.id),
            relaxed: {},
            describe: `dropping pack ${packSlug}`,
        });
    }

    const freqMin = readOptionalInt(args, 'freq_min', 1, 1_000_000, 'Frequency rank 1 is the commonest word.');
    const freqMax = readOptionalInt(args, 'freq_max', 1, 1_000_000, 'Frequency rank 1 is the commonest word.');
    if (freqMin !== null || freqMax !== null) {
        if (freqMin !== null) base['freq_min'] = freqMin;
        if (freqMax !== null) base['freq_max'] = freqMax;
        filters.push({
            key: 'freq',
            label: `freq ${freqMin ?? 1}-${freqMax ?? '∞'}`,
            test: (w) =>
                w.freq !== null && (freqMin === null || w.freq >= freqMin) && (freqMax === null || w.freq <= freqMax),
            relaxed: {},
            describe: 'dropping the frequency range',
        });
    }

    const hasAudio = readEnum(args, 'has_audio', ['any', 'both_voices', 'female', 'male'] as const, 'any');
    if (hasAudio !== 'any') {
        base['has_audio'] = hasAudio;
        filters.push({
            key: 'has_audio',
            label: `has_audio ${hasAudio}`,
            // No clips are hosted in 0.1, so this filter is honestly empty rather
            // than quietly matching everything.
            test: () => corpus.audioHosting,
            relaxed: { has_audio: 'any' },
            describe: "setting has_audio:'any' (no clips are hosted in this release)",
        });
    }

    return { filters, base };
}

function applyFilters(words: readonly WordRecord[], filters: readonly WordFilter[]): WordRecord[] {
    return words.filter((w) => filters.every((f) => f.test(w)));
}

function relaxationsFor(
    tool: string,
    words: readonly WordRecord[],
    filters: readonly WordFilter[],
    base: Args
): Relaxation[] {
    const out: (Relaxation & { count: number; widened: boolean })[] = [];
    for (let i = 0; i < filters.length; i++) {
        const dropped = filters[i];
        if (dropped === undefined) continue;
        const kept = filters.filter((_, j) => j !== i);
        const widened = Object.keys(dropped.relaxed).length > 0;
        const relaxedArgs: Args = { ...base, ...dropped.relaxed };
        if (!widened) delete relaxedArgs[dropped.key];
        const count = applyFilters(words, kept).length;
        out.push({
            describe: `${dropped.describe} ${matchCount(count)}`,
            nextCall: count > 0 ? renderCall(tool, relaxedArgs) : null,
            count,
            widened,
        });
    }
    return rankRelaxations(out);
}

function runFindWords(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const { filters, base } = buildWordFilters(corpus, args);
    const order = readEnum(args, 'order', ['frequency', 'hsk', 'alphabetical'] as const, 'frequency');
    const limit = readInt(args, 'limit', 1, 100, 20, 'The cap keeps a page inside the token budget.');
    const cursor = readString(args, 'cursor', 128);

    let matched = applyFilters(corpus.words, filters);
    if (order === 'hsk') {
        matched = [...matched].sort(
            (a, b) => (a.hsk2026 ?? 99) - (b.hsk2026 ?? 99) || (a.freq ?? 1e9) - (b.freq ?? 1e9)
        );
    } else if (order === 'alphabetical') {
        matched = [...matched].sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    }

    if (matched.length === 0) {
        const labels = filters.map((f) => f.label);
        throw new ToolError(
            e9Empty(
                'words',
                labels.length === 0 ? ['none'] : labels,
                relaxationsFor('mandarin_find_words', corpus.words, filters, { ...base, limit })
            )
        );
    }

    let start = 0;
    if (cursor !== null) {
        const { id, release } = decodeCursor(cursor);
        if (release !== null && release !== corpus.version) {
            throw new ToolError(e12StaleCursor(cursor, release, corpus.version));
        }
        const at = matched.findIndex((w) => w.id === id);
        if (at === -1) throw new ToolError(e12StaleCursor(cursor, release ?? 'an earlier release', corpus.version));
        start = at;
    }

    const page = matched.slice(start, start + limit);
    const next = matched[start + limit];
    const body = [
        page.map(renderWordLine).join('\n'),
        listFooter(
            corpus,
            page.length,
            matched.length,
            'words',
            next === undefined ? null : encodeCursor(corpus, next.id),
            100
        ),
    ].join('\n');
    return text(body);
}

/* ── 3. mandarin_find_sentences ──────────────────────────────────────────── */

interface SentenceFilter {
    key: string;
    label: string;
    test: (s: SentenceRecord) => boolean;
    relaxed: Args;
    describe: string;
}

/**
 * Words in the sentence outside band prefix 1..hsk. The build precomputes this
 * per band against HSK 3.0, so use its number where it exists — it segments the
 * sentence properly, which a join over surface forms does not.
 */
function newWordCount(corpus: Corpus, sentence: SentenceRecord, hsk: number, standard: Standard): number {
    if (standard === 'hsk2026' && sentence.newWordCount !== null) {
        const precomputed = sentence.newWordCount[String(hsk)];
        if (precomputed !== undefined) return precomputed;
    }
    let count = 0;
    for (const form of sentence.words) {
        const word = corpus.bySimplified.get(form)?.[0];
        const band = word === undefined ? null : bandOf(word, standard);
        if (band === null || band > hsk) count++;
    }
    return count;
}

function runFindSentences(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const standard = readEnum(args, 'band_standard', STANDARDS, 'hsk2026');
    const contains = readString(args, 'contains', 16);
    const pattern = readString(args, 'pattern', 64);
    const word = readString(args, 'word', 32);
    const difficulty = readOptionalInt(args, 'difficulty', 1, 7, 'The ZSG grade runs 1-7.');
    const count = readInt(args, 'count', 1, 50, 10, 'The cap keeps a page inside the token budget.');
    readEnum(args, 'voice', VOICES, 'both');
    const cursor = readString(args, 'cursor', 128);

    const hskRaw = args['hsk'];
    let hsk: number | null = null;
    if (hskRaw !== undefined && hskRaw !== null) {
        if (
            typeof hskRaw !== 'number' ||
            !Number.isInteger(hskRaw) ||
            hskRaw < 1 ||
            hskRaw > BANDS[standard]
        ) {
            throw new ToolError(e6OutOfRange(standard, Number(hskRaw)));
        }
        hsk = hskRaw;
    }

    if (contains === null && pattern === null && word === null && hsk === null) {
        const passed = Object.keys(args).filter((k) => !['contains', 'pattern', 'word', 'hsk'].includes(k));
        throw new ToolError(
            e10MissingCombination(
                'mandarin_find_sentences',
                ['contains', 'pattern', 'word', 'hsk'],
                passed,
                'For the 把 construction at HSK 4: mandarin_find_sentences({pattern:"ba-disposal", hsk:4, count:10}).'
            )
        );
    }

    const maxNew = readOptionalInt(args, 'max_new_words', 0, 5, 'Counts words outside the given HSK level.');
    if (maxNew !== null && hsk === null) {
        throw new ToolError(
            'max_new_words requires hsk: "new" is only defined relative to a level. ' +
                `Next: mandarin_find_sentences({${contains === null ? '' : `contains:"${contains}", `}hsk:4, max_new_words:${maxNew}, count:${count}}).`
        );
    }

    if (corpus.sentences.length === 0) {
        throw new ToolError(
            'This release ships no sentence corpus, so mandarin_find_sentences has nothing to search. ' +
                'Next: mandarin_lookup({words:["你好"]}) returns the curated sentences attached to a headword, ' +
                'and mandarin_find_words selects vocabulary.'
        );
    }

    const filters: SentenceFilter[] = [];
    const base: Args = {};
    if (contains !== null) {
        base['contains'] = contains;
        filters.push({
            key: 'contains',
            label: `contains "${contains}"`,
            test: (s) => s.hanzi.includes(contains),
            relaxed: {},
            describe: `dropping contains "${contains}"`,
        });
    }
    if (word !== null) {
        base['word'] = word;
        filters.push({
            key: 'word',
            label: `word ${word}`,
            test: (s) => s.words.includes(word),
            relaxed: {},
            describe: `dropping word ${word}`,
        });
    }
    if (pattern !== null) {
        const known = corpus.patterns.some((p) => p.id === pattern);
        if (!known) {
            const near = nearest(pattern, corpus.patterns.map((p) => p.id), 5);
            throw new ToolError(
                e11UnknownPattern(
                    pattern,
                    corpus.patterns.filter((p) => p.id === near).slice(0, 3),
                    corpus.patterns.length
                )
            );
        }
        base['pattern'] = pattern;
        filters.push({
            key: 'pattern',
            label: `pattern ${pattern}`,
            test: (s) => s.pattern === pattern,
            relaxed: {},
            describe: `dropping pattern ${pattern}`,
        });
    }
    if (hsk !== null) {
        const level = hsk;
        base['hsk'] = level;
        filters.push({
            key: 'hsk',
            label: `hsk ${level}`,
            test: (s) => s.difficulty === null || s.difficulty <= level,
            relaxed: {},
            describe: `dropping hsk ${level}`,
        });
    }
    if (difficulty !== null) {
        base['difficulty'] = difficulty;
        filters.push({
            key: 'difficulty',
            label: `difficulty ${difficulty}`,
            test: (s) => s.difficulty === difficulty,
            relaxed: {},
            describe: `dropping difficulty ${difficulty}`,
        });
    }
    if (maxNew !== null && hsk !== null) {
        const level = hsk;
        const cap = maxNew;
        base['max_new_words'] = cap;
        filters.push({
            key: 'max_new_words',
            label: `max_new_words ${cap}`,
            test: (s) => newWordCount(corpus, s, level, standard) <= cap,
            relaxed: { max_new_words: Math.min(cap + 1, 5) },
            describe: `relaxing max_new_words to ${Math.min(cap + 1, 5)}`,
        });
    }
    base['count'] = count;

    const test = (list: readonly SentenceFilter[]): SentenceRecord[] =>
        corpus.sentences.filter((s) => list.every((f) => f.test(s)));

    const matched = test(filters);
    if (matched.length === 0) {
        const relaxations: (Relaxation & { count: number; widened: boolean })[] = [];
        for (let i = 0; i < filters.length; i++) {
            const dropped = filters[i];
            if (dropped === undefined) continue;
            // max_new_words is only defined relative to hsk, so dropping hsk drops both.
            const kept = filters.filter(
                (f, j) => j !== i && !(dropped.key === 'hsk' && f.key === 'max_new_words')
            );
            let n: number;
            const relaxedArgs: Args = { ...base, ...dropped.relaxed };
            if (dropped.key === 'hsk') delete relaxedArgs['max_new_words'];
            if (Object.keys(dropped.relaxed).length === 0) {
                delete relaxedArgs[dropped.key];
                n = test(kept).length;
            } else if (dropped.key === 'max_new_words' && hsk !== null) {
                const level = hsk;
                const widened = Number(dropped.relaxed['max_new_words'] ?? 5);
                n = test([
                    ...kept,
                    { ...dropped, test: (s) => newWordCount(corpus, s, level, standard) <= widened },
                ]).length;
            } else {
                n = test(kept).length;
            }
            relaxations.push({
                describe: `${dropped.describe} ${matchCount(n)}`,
                nextCall: n > 0 ? renderCall('mandarin_find_sentences', relaxedArgs) : null,
                count: n,
                widened: Object.keys(dropped.relaxed).length > 0,
            });
        }
        throw new ToolError(
            e9Empty('sentences', filters.map((f) => f.label), rankRelaxations(relaxations))
        );
    }

    let start = 0;
    if (cursor !== null) {
        const { id, release } = decodeCursor(cursor);
        if (release !== null && release !== corpus.version) {
            throw new ToolError(e12StaleCursor(cursor, release, corpus.version));
        }
        const at = matched.findIndex((s) => s.id === id);
        if (at === -1) throw new ToolError(e12StaleCursor(cursor, release ?? 'an earlier release', corpus.version));
        start = at;
    }

    const page = matched.slice(start, start + count);
    const next = matched[start + count];
    return text(
        [
            page.map((s) => renderSentence(corpus, s)).join('\n\n'),
            listFooter(
                corpus,
                page.length,
                matched.length,
                'sentences',
                next === undefined ? null : encodeCursor(corpus, next.id),
                50
            ),
        ].join('\n\n')
    );
}

/* ── 4. mandarin_audio ───────────────────────────────────────────────────── */

function runAudio(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const items = readStringArray(
        args,
        'text',
        1,
        100,
        'mandarin_audio',
        'The cap keeps a check_only sweep inside a few hundred tokens.'
    );
    if (items.length === 0) {
        throw new ToolError(
            'mandarin_audio needs text. Next: mandarin_audio({text:["你好"], check_only:true}).'
        );
    }
    const voice = readEnum(args, 'voice', VOICES, 'both');
    const checkOnly = readBool(args, 'check_only', false);
    const inline = readBool(args, 'inline', false);
    readBool(args, 'contrast', false);

    if (inline && items.length > 1) {
        throw new ToolError(
            `inline:true takes exactly one string; you passed ${items.length}. One base64 MP3 costs about 19,000 tokens ` +
                `and a URL costs about 15. Next: mandarin_audio({text:["${items[0] ?? ''}"], inline:true}), or drop inline to get URLs for all ${items.length}.`
        );
    }

    if (!corpus.audioHosting) {
        // Honest answer, not an error: the agent asked whether a clip exists and
        // the answer is "no clip is served by this release", for every string.
        const lines = items.map((t) => `${t} · pending`);
        const head =
            `No audio is hosted in release ${corpus.version}: the clip release has not shipped, so every string below is "pending" ` +
            `for voice "${voice}" — not "missing", and not a URL. Nothing was synthesised and nothing was billed. ` +
            (checkOnly
                ? 'Treat check_only as "unknown" for now and keep your own TTS path.'
                : 'Use your own TTS for now; mandarin_lookup and mandarin_build_deck omit audio fields rather than emit a dead link.');
        return text([head, lines.join('\n'), envelopeFooter(corpus)].join('\n\n'));
    }

    throw new ToolError('Audio index present but unreadable; report this as a build bug.');
}

/* ── 5. mandarin_build_deck ──────────────────────────────────────────────── */

const DEFAULT_FIELDS = [
    'hanzi',
    'pinyin',
    'english',
    'audio',
    'sentence',
    'sentence_audio',
] as const;

const FIELD_LABELS: Record<string, string> = {
    hanzi: 'Hanzi',
    traditional: 'Traditional',
    pinyin: 'Pinyin',
    pinyin_numbered: 'PinyinNumbered',
    english: 'English',
    pos: 'PartOfSpeech',
    measure_words: 'MeasureWords',
    hsk: 'HSK',
    frequency: 'Frequency',
    audio: 'Audio',
    sentence: 'Sentence',
    sentence_pinyin: 'SentencePinyin',
    sentence_english: 'SentenceEnglish',
    sentence_audio: 'SentenceAudio',
    id: 'Id',
};

function runBuildDeck(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const packSlug = readString(args, 'pack', 64);
    const requested = readStringArray(
        args,
        'words',
        0,
        100,
        'mandarin_build_deck',
        'The cap matches the Anki MCP addNotes cap so one build is one addNotes call.'
    );
    if (requested.length === 0 && packSlug === null) {
        throw new ToolError(
            e10MissingCombination(
                'mandarin_build_deck',
                ['words', 'pack'],
                Object.keys(args),
                'For a ready-made list: mandarin_build_deck({pack:"hsk-2026-t1", voice:"female"}). For your own: mandarin_build_deck({words:["你好","谢谢"]}).'
            )
        );
    }

    const deckName = readString(args, 'deck_name', 120) ?? 'Zhongdex::HSK';
    if (deckName.split('::').length > 2) {
        throw new ToolError(
            `deck_name "${deckName}" has ${deckName.split('::').length} levels; createDeck accepts at most 2. ` +
                `Next: mandarin_build_deck({deck_name:"${deckName.split('::').slice(0, 2).join('::')}"}).`
        );
    }
    const modelName = readString(args, 'model_name', 120) ?? 'Zhongdex Mandarin';
    const format = readEnum(args, 'format', DECK_FORMATS, 'anki-mcp');
    const voice = readEnum(args, 'voice', VOICES, 'female');
    const sentenceCount = readInt(args, 'sentences', 0, 2, 1, 'At most 2 sentences fit on a card.');
    const tags = readStringArray(args, 'tags', 0, 32, 'mandarin_build_deck', '');
    const fieldsRaw = readStringArray(args, 'fields', 0, 15, 'mandarin_build_deck', '');
    for (const field of fieldsRaw) {
        if (!(DECK_FIELDS as readonly string[]).includes(field)) throw new ToolError(e14UnknownField(field));
    }
    const fields = fieldsRaw.length > 0 ? fieldsRaw : [...DEFAULT_FIELDS];

    let members: WordRecord[] = [];
    if (packSlug !== null) {
        members = packWords(corpus, packOrThrow(corpus, packSlug, 'pack'));
    }
    const missing: string[] = [];
    for (const ref of requested) {
        const word = corpus.byId.get(ref) ?? corpus.bySimplified.get(ref)?.[0] ?? corpus.byTraditional.get(ref)?.[0];
        if (word === undefined) missing.push(ref);
        else if (!members.some((m) => m.id === word.id)) members.push(word);
    }

    const excludeSlugs = readStringArray(args, 'exclude_packs', 0, 60, 'mandarin_build_deck', '');
    if (excludeSlugs.length > 0) {
        const excluded = new Set<string>();
        for (const slug of excludeSlugs) {
            for (const w of packWords(corpus, packOrThrow(corpus, slug, 'pack'))) excluded.add(w.id);
        }
        members = members.filter((w) => !excluded.has(w.id));
    }

    if (members.length > 100) {
        throw new ToolError(
            e13BatchCap(
                'mandarin_build_deck',
                100,
                members.length,
                'The cap matches the Anki MCP addNotes cap so one build is one addNotes call.'
            )
        );
    }
    if (members.length === 0) {
        throw new ToolError(
            e9Empty(
                'words',
                [packSlug === null ? `words ${requested.length}` : `pack ${packSlug}`, `exclude_packs ${excludeSlugs.join(',')}`],
                [
                    {
                        describe: 'dropping exclude_packs gives back the whole pack',
                        nextCall:
                            packSlug === null
                                ? renderCall('mandarin_build_deck', { words: requested })
                                : renderCall('mandarin_build_deck', { pack: packSlug }),
                    },
                ]
            )
        );
    }

    const notes: { fields: Record<string, string>; tags: string[] }[] = [];
    const usedTags = tags.length > 0 ? tags : ['zhongdex'];
    for (const word of members) {
        const sentence = word.sentenceIds
            .map((id) => corpus.sentencesById.get(id))
            .filter((s): s is SentenceRecord => s !== undefined)
            .slice(0, sentenceCount);
        const row: Record<string, string> = {};
        for (const field of fields) {
            const label = FIELD_LABELS[field] ?? field;
            switch (field) {
                case 'hanzi':
                    row[label] = word.simplified;
                    break;
                case 'traditional':
                    row[label] = word.traditional;
                    break;
                case 'pinyin':
                    row[label] = word.pinyin;
                    break;
                case 'pinyin_numbered':
                    row[label] = word.pinyinNumbered ?? '';
                    break;
                case 'english':
                    row[label] = word.gloss.join('; ');
                    break;
                case 'pos':
                    row[label] = word.pos.join('/');
                    break;
                case 'measure_words':
                    row[label] = word.measureWords.join(', ');
                    break;
                case 'hsk':
                    row[label] = word.hsk2026 === null ? '' : `t${word.hsk2026}`;
                    break;
                case 'frequency':
                    row[label] = word.freq === null ? '' : String(word.freq);
                    break;
                case 'sentence':
                    row[label] = sentence.map((s) => s.hanzi).join(' ');
                    break;
                case 'sentence_pinyin':
                    row[label] = sentence.map((s) => s.pinyin).join(' ');
                    break;
                case 'sentence_english':
                    row[label] = sentence.map((s) => s.english).join(' ');
                    break;
                case 'id':
                    row[label] = word.id;
                    break;
                case 'audio':
                case 'sentence_audio':
                    // Omitted while audio hosting is pending: a [sound:] reference
                    // with no stored media renders as a broken card in Anki.
                    break;
                default:
                    break;
            }
        }
        const bandTag = word.hsk2026 === null ? null : `hsk${word.hsk2026}-2026`;
        notes.push({ fields: row, tags: bandTag === null ? usedTags : [...usedTags, bandTag] });
    }

    const nextSteps =
        `1) createDeck({deckName:"${deckName}"}) 2) addNotes({deckName:"${deckName}", modelName:"${modelName}", notes}) with the notes array above. ` +
        'media[] is empty in this release because no audio is hosted yet, so there is nothing to storeMediaFile and no [sound:] reference is written into any field. ' +
        'When audio ships, store every media[] entry before adding notes: a note whose audio is not in the collection shows a broken reference.';

    const structured: Record<string, unknown> = {
        deck_name: deckName,
        model_name: modelName,
        media: [],
        notes,
        next_steps: nextSteps,
        audio_status: 'pending',
    };

    if (format === 'anki-mcp') {
        const summary = [
            `${notes.length} notes for deck "${deckName}" (model "${modelName}", voice ${voice} requested).`,
            missing.length === 0 ? null : `Not found, skipped: ${missing.join(', ')}.`,
            'media[]: 0 entries — audio hosting is pending, so no [sound:] reference was written.',
            nextSteps,
            envelopeFooter(corpus),
        ]
            .filter((s): s is string => s !== null)
            .join('\n\n');
        return { content: [{ type: 'text', text: summary }], structuredContent: structured };
    }

    // Other formats are files. There is no download host in 0.1, so the file is
    // returned inline rather than as a link that would not resolve.
    const file = renderDeckFile(format, fields, notes);
    const body = [
        `${format} export, ${notes.length} rows. No download host in release ${corpus.version}, so the file is inline below; write it yourself and import it.`,
        file,
        envelopeFooter(corpus),
    ].join('\n\n');
    if (estimateTokens(body) > 10_000) {
        throw new ToolError(
            e16Truncated(
                10_000,
                0,
                notes.length,
                `The ${format} export does not fit in one response. Next: page mandarin_find_words with limit:50 and build one deck per page.`
            )
        );
    }
    return { content: [{ type: 'text', text: body }], structuredContent: structured };
}

function renderDeckFile(
    format: string,
    fields: readonly string[],
    notes: readonly { fields: Record<string, string>; tags: string[] }[]
): string {
    const labels = fields.map((f) => FIELD_LABELS[f] ?? f).filter((l) => notes.some((n) => l in n.fields));
    if (format === 'json') return JSON.stringify(notes, null, 1);
    const sep = format === 'tsv' ? '\t' : format === 'pleco' ? '\t' : ',';
    const escape = (v: string): string =>
        sep === ',' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v.replace(/[\t\n]/g, ' ');
    const rows = [labels.join(sep)];
    for (const note of notes) {
        rows.push(labels.map((l) => escape(note.fields[l] ?? '')).join(sep));
    }
    return rows.join('\n');
}

/* ── 6. mandarin_packs ───────────────────────────────────────────────────── */

function runPacks(corpus: Corpus, tool: ToolDefinition, args: Args): ToolResult {
    checkKeys(tool, args);
    const kind = args['kind'] === undefined ? null : readEnum(
        args,
        'kind',
        ['band', 'frequency', 'theme', 'form', 'grammar', 'media'] as const,
        'band'
    );
    const level = readOptionalInt(args, 'level', 1, 7, 'HSK 3.0 (2026) has 7 bands.');
    const q = readString(args, 'q', 32);
    const limit = readInt(args, 'limit', 1, 60, 60, 'The catalogue is 54 packs.');

    let matched = corpus.packs;
    if (kind !== null) matched = matched.filter((p) => p.kind === kind);
    if (level !== null) matched = matched.filter((p) => p.level === level || p.closedAt === level);
    if (q !== null) {
        const needle = q.toLowerCase();
        matched = matched.filter(
            (p) =>
                p.slug.toLowerCase().includes(needle) ||
                p.title.toLowerCase().includes(needle) ||
                p.oneLiner.toLowerCase().includes(needle)
        );
    }

    if (matched.length === 0) {
        const relaxations: Relaxation[] = [];
        if (kind !== null) {
            const n = corpus.packs.filter((p) => (level === null || p.level === level) && (q === null || p.slug.includes(q))).length;
            relaxations.push({
                describe: `dropping kind ${kind} gives ${n} pack${n === 1 ? '' : 's'}`,
                nextCall: n > 0 ? renderCall('mandarin_packs', { level, q, limit }) : null,
            });
        }
        if (level !== null) {
            const n = corpus.packs.filter((p) => (kind === null || p.kind === kind)).length;
            relaxations.push({
                describe: `dropping level ${level} gives ${n} pack${n === 1 ? '' : 's'}`,
                nextCall: n > 0 ? renderCall('mandarin_packs', { kind, q, limit }) : null,
            });
        }
        if (q !== null) {
            const n = corpus.packs.filter((p) => kind === null || p.kind === kind).length;
            relaxations.push({
                describe: `dropping q "${q}" gives ${n} pack${n === 1 ? '' : 's'}`,
                nextCall: n > 0 ? renderCall('mandarin_packs', { kind, level, limit }) : null,
            });
        }
        relaxations.push({
            describe: `the whole catalogue is ${corpus.packs.length} packs`,
            nextCall: 'mandarin_packs()',
        });
        throw new ToolError(
            e9Empty(
                'packs',
                [kind === null ? null : `kind ${kind}`, level === null ? null : `level ${level}`, q === null ? null : `q "${q}"`].filter(
                    (s): s is string => s !== null
                ),
                relaxations
            )
        );
    }

    const page = matched.slice(0, limit);
    return text(
        [
            page.map((p) => renderPack(corpus, p)).join('\n'),
            listFooter(corpus, page.length, matched.length, 'packs', null, 60),
        ].join('\n')
    );
}

/* ── dispatch ────────────────────────────────────────────────────────────── */

/** Thrown for an unknown tool name, which is a protocol error, not a model error. */
export class UnknownToolError extends Error {}

/**
 * Run one tool. Returns a normal result on success and on any model-fixable
 * failure (`isError: true`); throws only for an unknown tool name.
 */
export function callTool(corpus: Corpus, name: string, rawArgs: unknown): ToolResult {
    const tool = BY_NAME.get(name);
    if (tool === undefined) {
        throw new UnknownToolError(
            `Unknown tool "${name}". This server has six: ${TOOLS.map((t) => t.name).join(', ')}.`
        );
    }
    const args: Args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
    try {
        switch (name) {
            case 'mandarin_lookup':
                return runLookup(corpus, tool, args);
            case 'mandarin_find_words':
                return runFindWords(corpus, tool, args);
            case 'mandarin_find_sentences':
                return runFindSentences(corpus, tool, args);
            case 'mandarin_audio':
                return runAudio(corpus, tool, args);
            case 'mandarin_build_deck':
                return runBuildDeck(corpus, tool, args);
            case 'mandarin_packs':
                return runPacks(corpus, tool, args);
            default:
                throw new UnknownToolError(`Unknown tool "${name}".`);
        }
    } catch (error) {
        if (error instanceof ToolError) {
            return text(`${error.message}\n\n${envelopeFooter(corpus)}`, true);
        }
        throw error;
    }
}

/** Completion sources for `completion/complete`: pack ids, topics, patterns, levels. */
export function completionValues(corpus: Corpus, name: string, prefix: string): string[] {
    const lower = prefix.toLowerCase();
    const pool =
        name === 'pack'
            ? corpus.packs.map((p) => p.slug)
            : name === 'topic'
              ? corpus.topics
              : name === 'pattern'
                ? corpus.patterns.map((p) => p.id)
                : name === 'level'
                  ? ['1', '2', '3', '4', '5', '6', '7']
                  : name === 'voice'
                    ? [...VOICES]
                    : name === 'id'
                      ? corpus.words.map((w) => w.id)
                      : [];
    return pool.filter((v) => v.toLowerCase().startsWith(lower));
}
