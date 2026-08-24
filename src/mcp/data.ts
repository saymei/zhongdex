/**
 * Zhongdex MCP — data loading and in-memory indices.
 *
 * Everything the tool layer serves comes from files written by `npm run build`.
 * Nothing here touches the network, at load time or at request time.
 *
 * ── The files this reads ───────────────────────────────────────────────────
 *
 *   data/hsk_bands.json            required. `{version, words: WordRow[]}` or a bare WordRow[].
 *   data/packs/<slug>.pack.json    required (>=1). pack-v1, §12.1 of the revision.
 *   data/sentences.jsonl           optional. One SentenceRow per line:
 *                                  {id, hanzi, pinyin, pinyinNumbered, english, zsg,
 *                                   newWordCount:{"1".."7"}, words[],
 *                                   headwords:[{wordId, slot}]}
 *   data/sentences.json            optional. `{version, sentences: SentenceRow[]}` or a bare array.
 *   data/grammar_patterns.json     optional. `{id, hanzi?, gloss?, hsk?}[]` or a bare id[].
 *
 * The canon rows `src/build/canon.ts` emits look like this, and that is the
 * shape read first; the alias lists behind each field exist because the two
 * builders and this server are written separately and the spelling has already
 * moved once:
 *
 *   {id, simplified, traditional, pinyin:{marked,numbered}, pos:[],
 *    hsk:{band2026,band2021,bandRange,listId}, definitions:[{text,source}],
 *    audio:{female,male,status}}
 *
 *   id                id                                 (constructed if absent)
 *   simplified        simplified | Simplified | hanzi | word
 *   traditional       traditional | Traditional | trad
 *   pinyin (marked)   pinyin.marked | pinyin_marked | pinyin | Pinyin
 *   pinyin (numbered) pinyin.numbered | pinyin_numbered | pinyinNumbered | numbered
 *   pos               pos | POS            (string or string[])
 *   band 2026         hsk.band2026 | band2026 | hsk_2026 | hsk2026
 *   band 2021         hsk.band2021 | band2021 | hsk_2021 | hsk2021
 *   HSK 2.0 level     hsk.band2_0 | hsk2Level | hsk_2_0 | hsk2
 *   gloss             definitions[].text | gloss | english | en | glosses
 *   frequency rank    freq | frequency_rank | frequencyRank
 *   zipf              zipf | zipfScore
 *   sentence ids      sentences | sentence_ids
 *   audio             audio.female / audio.male URLs, else status "pending"
 *
 * ── Audio ──────────────────────────────────────────────────────────────────
 * The canon distinguishes RECORDED from HOSTED: `audio.female` is an object
 * `{available, hosted}`, not a URL. A clip can exist in the source archive and
 * still have no address. `audioHosting` is true only when something is actually
 * `hosted`, so nothing here can emit a URL that would 404 — and if a later build
 * changes `female` to a URL string, that is recognised too.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class DataMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DataMissingError';
    }
}

/** Per-voice state. `recorded` means a clip exists in the archive but has no address yet. */
export type VoiceAudio = 'hosted' | 'recorded' | 'none' | 'unknown';

export interface AudioState {
    female: VoiceAudio;
    male: VoiceAudio;
}

export interface WordRecord {
    /** `dex:w:<simplified>:<numbered, spaces stripped>` */
    id: string;
    simplified: string;
    traditional: string;
    /** Tone-marked pinyin, as published. */
    pinyin: string;
    /** Numbered pinyin with spaces, e.g. `ni3 hao3`. Null when the build did not supply one. */
    pinyinNumbered: string | null;
    pos: string[];
    gloss: string[];
    /** Classifiers, lifted out of the CC-CEDICT `CL:` annotation in the definitions. */
    measureWords: string[];
    hsk2026: number | null;
    hsk2021: number | null;
    hsk2: number | null;
    freq: number | null;
    zipf: number | null;
    sentenceIds: string[];
    /** Pack slugs this word belongs to; filled from the pack index at load. */
    packs: string[];
    audio: AudioState;
}

export interface SentenceRecord {
    id: string;
    hanzi: string;
    pinyin: string;
    pinyinNumbered: string | null;
    english: string;
    /** ZSG grade 1-7: the highest HSK 3.0 band of any word in the sentence. */
    difficulty: number | null;
    /** Simplified content-token forms attested in the sentence. */
    words: string[];
    pattern: string | null;
    /**
     * Distinct token forms outside each HSK 3.0 band prefix, precomputed by the
     * build. `newWordCount["4"] === 1` is an i+1 sentence at HSK 4.
     */
    newWordCount: Record<string, number> | null;
    /** Headword links: which canon word this sentence was selected for, and how hard it is for it. */
    headwords: { wordId: string; slot: string }[];
    audio: VoiceAudio;
}

export interface PackRecord {
    id: string;
    slug: string;
    kind: string;
    title: string;
    oneLiner: string;
    size: number;
    level: number | null;
    closedAt: number | null;
    /** Word ids, or bare hanzi when the pack file gives no ids. */
    wordRefs: string[];
    query: string | null;
    corpusVersion: string | null;
}

export interface GrammarPattern {
    id: string;
    hanzi: string | null;
    hsk: number | null;
}

/**
 * Counts computed once at load. Tool descriptions and the discover instructions
 * are rendered from these, never from a literal typed into prose — a number in a
 * description that is not derived will drift the moment the build changes.
 */
export interface CorpusStats {
    words: number;
    withGloss: number;
    withSentence: number;
    bands: { hsk2026: number; hsk2021: number; hsk2_0: number };
    withFreq: number;
    sentences: number;
    packs: number;
    /** One entry per `kind` present, with a couple of real slugs as examples. */
    packKinds: { kind: string; count: number; examples: string[] }[];
    audio: {
        wordsFemaleRecorded: number;
        wordsMaleRecorded: number;
        wordsHosted: number;
        sentencesRecorded: number;
        sentencesHosted: number;
    };
}

export interface Corpus {
    /** Corpus release, e.g. `2026.09`. Stamped into every footer and every cursor. */
    version: string;
    words: WordRecord[];
    byId: Map<string, WordRecord>;
    bySimplified: Map<string, WordRecord[]>;
    byTraditional: Map<string, WordRecord[]>;
    /** Key: numbered pinyin lowercased with spaces, apostrophes and ü-spellings normalised. */
    byNumbered: Map<string, WordRecord[]>;
    sentences: SentenceRecord[];
    sentencesById: Map<string, SentenceRecord>;
    /** Exact sentence text, so mandarin_audio can answer for sentences as well as words. */
    sentencesByHanzi: Map<string, SentenceRecord>;
    patterns: GrammarPattern[];
    packs: PackRecord[];
    packsBySlug: Map<string, PackRecord>;
    /** Slugs of `kind: "theme"` packs — the published topic list for `topic`. */
    topics: string[];
    /** True only when some clip is actually hosted. No tool may return a URL while this is false. */
    audioHosting: boolean;
    stats: CorpusStats;
}

/* ── field readers ───────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

function pick(row: Row, ...keys: string[]): unknown {
    for (const key of keys) {
        if (key.includes('.')) {
            const [outer, inner] = key.split('.');
            const nested = outer === undefined ? undefined : row[outer];
            if (nested && typeof nested === 'object' && inner !== undefined) {
                const v = (nested as Row)[inner];
                if (v !== undefined && v !== null) return v;
            }
            continue;
        }
        const v = row[key];
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

function asString(v: unknown): string | null {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
    return null;
}

function asNumber(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const m = v.match(/\d+/);
        if (m) return Number(m[0]);
    }
    return null;
}

/**
 * CC-CEDICT carries classifiers inside the gloss as `CL:個|个[ge4]`. Split them
 * out so `measure_words` is a real deck field and the gloss reads as English.
 */
function splitClassifiers(glosses: readonly string[]): { gloss: string[]; measureWords: string[] } {
    const gloss: string[] = [];
    const measureWords: string[] = [];
    for (const raw of glosses) {
        const entry = raw.trim();
        if (entry.startsWith('CL:')) {
            for (const cl of entry.slice(3).split(',')) {
                const form = cl.split('[')[0]?.trim();
                if (form !== undefined && form.length > 0 && !measureWords.includes(form)) {
                    measureWords.push(form);
                }
            }
            continue;
        }
        gloss.push(entry);
    }
    return { gloss, measureWords };
}

function asStringArray(v: unknown): string[] {
    if (Array.isArray(v)) {
        return v
            .map((entry) =>
                entry && typeof entry === 'object' && !Array.isArray(entry)
                    ? asString(pick(entry as Row, 'text', 'gloss', 'en'))
                    : asString(entry)
            )
            .filter((s): s is string => s !== null);
    }
    const s = asString(v);
    if (s === null) return [];
    return s.includes('/') ? s.split('/').filter(Boolean) : [s];
}

/** Lookup key for numbered pinyin: `Ni3 Hao3` / `ni3'hao3` / `nü3` all collapse to one key. */
export function numberedKey(pinyin: string): string {
    return pinyin
        .toLowerCase()
        .replace(/ü/g, 'u:')
        .replace(/v/g, 'u:')
        .replace(/[\s'·]/g, '');
}

function readJson(path: string): unknown {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (cause) {
        throw new DataMissingError(`${path} could not be read: ${(cause as Error).message}`);
    }
    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new DataMissingError(`${path} is not valid JSON: ${(cause as Error).message}`);
    }
}

function rowsOf(doc: unknown, ...keys: string[]): Row[] {
    if (Array.isArray(doc)) return doc.filter((r): r is Row => typeof r === 'object' && r !== null);
    if (doc && typeof doc === 'object') {
        for (const key of keys) {
            const v = (doc as Row)[key];
            if (Array.isArray(v)) return v.filter((r): r is Row => typeof r === 'object' && r !== null);
        }
    }
    return [];
}

/**
 * `{available, hosted}` object, a bare URL string, or a bare boolean — all three
 * shapes have appeared. Only `hosted` (or a real https URL) counts as servable.
 */
function readVoice(node: unknown): VoiceAudio {
    if (typeof node === 'string') return node.startsWith('https://') ? 'hosted' : 'unknown';
    if (typeof node === 'boolean') return node ? 'recorded' : 'none';
    if (node && typeof node === 'object') {
        const row = node as Row;
        if (row['hosted'] === true) return 'hosted';
        if (row['available'] === true) return 'recorded';
        if (row['available'] === false) return 'none';
    }
    return 'unknown';
}

/* ── loading ─────────────────────────────────────────────────────────────── */

function loadWords(dir: string): { version: string | null; words: WordRecord[]; audioHosting: boolean } {
    const path = join(dir, 'hsk_bands.json');
    if (!existsSync(path)) {
        throw new DataMissingError(`${path} is missing.`);
    }
    const doc = readJson(path);
    const version =
        (!Array.isArray(doc) && doc && typeof doc === 'object'
            ? asString(pick(doc as Row, 'version', 'corpus_version', 'corpusVersion'))
            : null) ?? null;

    const words: WordRecord[] = [];
    let audioHosting = false;
    for (const row of rowsOf(doc, 'words', 'entries', 'rows')) {
        const simplified = asString(pick(row, 'simplified', 'Simplified', 'hanzi', 'word'));
        if (simplified === null) continue;
        const pinyinNumbered = asString(
            pick(row, 'pinyin.numbered', 'pinyin_numbered', 'pinyinNumbered', 'numbered')
        );
        const audioNode = pick(row, 'audio');
        const audio: AudioState =
            audioNode && typeof audioNode === 'object'
                ? {
                      female: readVoice((audioNode as Row)['female']),
                      male: readVoice((audioNode as Row)['male']),
                  }
                : { female: 'unknown', male: 'unknown' };
        if (audio.female === 'hosted' || audio.male === 'hosted') audioHosting = true;
        words.push({
            id:
                asString(pick(row, 'id')) ??
                `dex:w:${simplified}:${pinyinNumbered === null ? '-' : numberedKey(pinyinNumbered)}`,
            simplified,
            traditional:
                asString(pick(row, 'traditional', 'Traditional', 'trad')) ?? simplified,
            pinyin:
                asString(pick(row, 'pinyin.marked', 'pinyin_marked', 'pinyin', 'Pinyin')) ??
                pinyinNumbered ??
                '',
            pinyinNumbered,
            pos: asStringArray(pick(row, 'pos', 'POS')),
            ...splitClassifiers(
                asStringArray(pick(row, 'definitions', 'gloss', 'english', 'en', 'glosses'))
            ),
            hsk2026: asNumber(pick(row, 'hsk.band2026', 'band2026', 'hsk_2026', 'hsk2026')),
            hsk2021: asNumber(pick(row, 'hsk.band2021', 'band2021', 'hsk_2021', 'hsk2021')),
            hsk2: asNumber(pick(row, 'hsk.band2_0', 'hsk2Level', 'hsk_2_0', 'hsk2')),
            freq: asNumber(pick(row, 'freq', 'frequency_rank', 'frequencyRank')),
            zipf: asNumber(pick(row, 'zipf', 'zipfScore')),
            sentenceIds: asStringArray(pick(row, 'sentences', 'sentence_ids')),
            packs: [],
            audio,
        });
    }
    if (words.length === 0) {
        throw new DataMissingError(`${path} contains no word rows.`);
    }
    return { version, words, audioHosting };
}

/** `sentences.jsonl` (one row per line) is read first; `sentences.json` is the fallback. */
function sentenceRows(dir: string): Row[] {
    const jsonl = join(dir, 'sentences.jsonl');
    if (existsSync(jsonl)) {
        const rows: Row[] = [];
        for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as Row);
        }
        return rows;
    }
    const path = join(dir, 'sentences.json');
    return existsSync(path) ? rowsOf(readJson(path), 'sentences', 'rows') : [];
}

function loadSentences(dir: string): SentenceRecord[] {
    const out: SentenceRecord[] = [];
    for (const row of sentenceRows(dir)) {
        const hanzi = asString(pick(row, 'hanzi', 'chinese', 'text', 'simplified'));
        if (hanzi === null) continue;
        const id = asString(pick(row, 'id', 'sentence_id')) ?? `dex:s:${out.length}`;
        const counts = pick(row, 'newWordCount', 'new_word_count');
        const links: { wordId: string; slot: string }[] = [];
        const headwords = pick(row, 'headwords');
        if (Array.isArray(headwords)) {
            for (const h of headwords) {
                if (!h || typeof h !== 'object') continue;
                const wordId = asString(pick(h as Row, 'wordId', 'word_id', 'id'));
                if (wordId === null) continue;
                links.push({ wordId, slot: asString(pick(h as Row, 'slot')) ?? 'atLevel' });
            }
        }
        out.push({
            id,
            hanzi,
            pinyin: asString(pick(row, 'pinyin', 'pinyin_marked')) ?? '',
            pinyinNumbered: asString(pick(row, 'pinyin_numbered', 'pinyinNumbered')),
            english: asString(pick(row, 'english', 'en', 'translation')) ?? '',
            difficulty: asNumber(pick(row, 'difficulty', 'grade', 'zsg')),
            words: asStringArray(pick(row, 'words', 'word_forms', 'tokens')),
            pattern: asString(pick(row, 'pattern', 'grammar_pattern')),
            newWordCount:
                counts && typeof counts === 'object' && !Array.isArray(counts)
                    ? Object.fromEntries(
                          Object.entries(counts as Row)
                              .map(([k, v]) => [k, asNumber(v)])
                              .filter((e): e is [string, number] => e[1] !== null)
                      )
                    : null,
            headwords: links,
            audio: readVoice(pick(row, 'audio')),
        });
    }
    return out;
}

/**
 * `mandarin_packs({kind})` is an enum of six, so anything the builder invents
 * has to land inside it. `pos` packs (adjectives, measure words, …) are
 * form-based; everything unrecognised is a theme.
 */
const KINDS = ['band', 'frequency', 'theme', 'form', 'grammar', 'media'] as const;
const KIND_ALIASES: Record<string, (typeof KINDS)[number]> = {
    pos: 'form',
    delta: 'band',
    radical: 'form',
    freq: 'frequency',
    topic: 'theme',
    song: 'media',
    sentence: 'media',
};

function normaliseKind(raw: string | null): string {
    if (raw === null) return 'theme';
    if ((KINDS as readonly string[]).includes(raw)) return raw;
    return KIND_ALIASES[raw] ?? 'theme';
}

function loadPacks(dir: string): PackRecord[] {
    const packDir = join(dir, 'packs');
    if (!existsSync(packDir)) {
        throw new DataMissingError(`${packDir} is missing.`);
    }
    // index.json is the catalogue manifest, not a pack.
    const files = readdirSync(packDir)
        .filter((f) => f.endsWith('.json') && f !== 'index.json')
        .sort();
    if (files.length === 0) {
        throw new DataMissingError(`${packDir} contains no pack files.`);
    }
    const packs: PackRecord[] = [];
    for (const file of files) {
        const doc = readJson(join(packDir, file));
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
        const row = doc as Row;
        const slug = asString(pick(row, 'slug', 'id')) ?? file.replace(/\.(pack\.)?json$/, '');
        const level = pick(row, 'level');
        const closure = pick(row, 'bandClosure', 'band_closure');
        const selection = pick(row, 'selection');
        const wordRefs: string[] = [];
        const wordRows = pick(row, 'words', 'items');
        if (Array.isArray(wordRows)) {
            for (const w of wordRows) {
                if (typeof w === 'string') wordRefs.push(w);
                else if (w && typeof w === 'object') {
                    const ref = asString(pick(w as Row, 'id', 'hanzi', 'simplified'));
                    if (ref !== null) wordRefs.push(ref);
                }
            }
        }
        if (wordRefs.length === 0) continue;
        packs.push({
            id: asString(pick(row, 'id')) ?? `dex:p:${slug}`,
            slug,
            kind: normaliseKind(asString(pick(row, 'kind'))),
            title: asString(pick(row, 'title')) ?? slug,
            oneLiner: asString(pick(row, 'one_liner', 'oneLiner', 'description')) ?? '',
            size: asNumber(pick(row, 'size')) ?? wordRefs.length,
            level:
                level && typeof level === 'object' ? asNumber(pick(level as Row, 'band')) : asNumber(level),
            closedAt:
                closure && typeof closure === 'object'
                    ? asNumber(pick(closure as Row, 'closed_at', 'claimedMaxBand', 'observedMaxBand'))
                    : null,
            wordRefs,
            query:
                selection && typeof selection === 'object' ? asString(pick(selection as Row, 'query')) : null,
            corpusVersion: asString(pick(row, 'corpusVersion', 'corpus_version')),
        });
    }
    if (packs.length === 0) {
        throw new DataMissingError(`${packDir} contains no readable pack files.`);
    }
    return packs;
}

function loadPatterns(dir: string, sentences: SentenceRecord[]): GrammarPattern[] {
    const path = join(dir, 'grammar_patterns.json');
    const byId = new Map<string, GrammarPattern>();
    if (existsSync(path)) {
        const doc = readJson(path);
        if (Array.isArray(doc)) {
            for (const entry of doc) {
                if (typeof entry === 'string') {
                    byId.set(entry, { id: entry, hanzi: null, hsk: null });
                } else if (entry && typeof entry === 'object') {
                    const id = asString(pick(entry as Row, 'id', 'pattern', 'slug'));
                    if (id === null) continue;
                    byId.set(id, {
                        id,
                        hanzi: asString(pick(entry as Row, 'hanzi', 'form', 'marker')),
                        hsk: asNumber(pick(entry as Row, 'hsk', 'level')),
                    });
                }
            }
        }
    }
    // Anything attested in the sentence corpus is a real pattern id even if the
    // pattern table has not shipped yet.
    for (const s of sentences) {
        if (s.pattern !== null && !byId.has(s.pattern)) {
            byId.set(s.pattern, { id: s.pattern, hanzi: null, hsk: null });
        }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Canonical order: frequency rank asc (unranked last), then band, then id. */
function canonicalOrder(a: WordRecord, b: WordRecord): number {
    const fa = a.freq ?? Number.MAX_SAFE_INTEGER;
    const fb = b.freq ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    const ba = a.hsk2026 ?? a.hsk2021 ?? 99;
    const bb = b.hsk2026 ?? b.hsk2021 ?? 99;
    if (ba !== bb) return ba - bb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [value]);
    else bucket.push(value);
}

/**
 * Read every data file once and build the indices.
 * Throws {@link DataMissingError} with an operator-readable message; the caller
 * turns that into a one-line exit, never a stack trace.
 */
export function loadCorpus(dir: string): Corpus {
    if (!existsSync(dir)) {
        throw new DataMissingError(`${dir} does not exist.`);
    }
    const { version, words, audioHosting } = loadWords(dir);
    words.sort(canonicalOrder);

    const byId = new Map<string, WordRecord>();
    const bySimplified = new Map<string, WordRecord[]>();
    const byTraditional = new Map<string, WordRecord[]>();
    const byNumbered = new Map<string, WordRecord[]>();
    for (const w of words) {
        if (!byId.has(w.id)) byId.set(w.id, w);
        // The HSK list writes variant forms as `爸爸|爸`. Index every alternative
        // so a lookup of 爸爸 resolves instead of falling through to segmentation.
        for (const form of w.simplified.split('|')) push(bySimplified, form, w);
        if (w.traditional !== w.simplified) {
            for (const form of w.traditional.split('|')) push(byTraditional, form, w);
        }
        if (w.pinyinNumbered !== null) push(byNumbered, numberedKey(w.pinyinNumbered), w);
    }

    const sentences = loadSentences(dir);
    const sentencesById = new Map(sentences.map((s) => [s.id, s]));
    const sentencesByHanzi = new Map(sentences.map((s) => [s.hanzi, s]));

    // The canon carries no sentence ids; the link lives on the sentence side as
    // `headwords[].wordId`. Invert it once here so lookup is a map read.
    const SLOT_RANK: Record<string, number> = { atLevel: 0, easy: 1, stretch: 2 };
    const linked = new Map<string, { id: string; rank: number }[]>();
    for (const sentence of sentences) {
        for (const link of sentence.headwords) {
            push(linked, link.wordId, { id: sentence.id, rank: SLOT_RANK[link.slot] ?? 1 });
        }
    }
    for (const [wordId, entries] of linked) {
        entries.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
        const word = byId.get(wordId);
        if (word !== undefined && word.sentenceIds.length === 0) {
            word.sentenceIds = entries.map((e) => e.id);
        }
    }
    // Fill in the ZSG grade where the build did not: the highest 2026 band in the sentence.
    for (const s of sentences) {
        if (s.difficulty !== null) continue;
        let grade: number | null = null;
        for (const form of s.words) {
            const band = bySimplified.get(form)?.[0]?.hsk2026 ?? null;
            if (band !== null) grade = grade === null ? band : Math.max(grade, band);
        }
        s.difficulty = grade;
    }

    const packs = loadPacks(dir);
    const packsBySlug = new Map(packs.map((p) => [p.slug, p]));
    for (const pack of packs) {
        for (const ref of pack.wordRefs) {
            const word = byId.get(ref) ?? bySimplified.get(ref)?.[0];
            if (word !== undefined && !word.packs.includes(pack.slug)) word.packs.push(pack.slug);
        }
    }

    return {
        // The canon is a bare array in the current build, so the release stamp
        // comes from the packs, which all carry it.
        version: version ?? packVersion(dir, packs) ?? '0.0.0-dev',
        words,
        byId,
        bySimplified,
        byTraditional,
        byNumbered,
        sentences,
        sentencesById,
        sentencesByHanzi,
        patterns: loadPatterns(dir, sentences),
        packs,
        packsBySlug,
        topics: packs.filter((p) => p.kind === 'theme').map((p) => p.slug).sort(),
        audioHosting,
        stats: computeStats(words, sentences, packs),
    };
}

function computeStats(
    words: readonly WordRecord[],
    sentences: readonly SentenceRecord[],
    packs: readonly PackRecord[]
): CorpusStats {
    // Examples lead with the largest pack of each kind: more use to an agent than
    // whichever slug sorts first, and still fully derived and deterministic.
    const kinds = new Map<string, PackRecord[]>();
    for (const pack of packs) {
        const bucket = kinds.get(pack.kind);
        if (bucket === undefined) kinds.set(pack.kind, [pack]);
        else bucket.push(pack);
    }
    const count = (test: (w: WordRecord) => boolean): number => words.filter(test).length;
    return {
        words: words.length,
        withGloss: count((w) => w.gloss.length > 0),
        withSentence: count((w) => w.sentenceIds.length > 0),
        bands: {
            hsk2026: count((w) => w.hsk2026 !== null),
            hsk2021: count((w) => w.hsk2021 !== null),
            hsk2_0: count((w) => w.hsk2 !== null),
        },
        withFreq: count((w) => w.freq !== null),
        sentences: sentences.length,
        packs: packs.length,
        packKinds: [...kinds.entries()]
            .map(([kind, group]) => ({
                kind,
                count: group.length,
                examples: [...group]
                    .sort((a, b) => b.size - a.size || (a.slug < b.slug ? -1 : 1))
                    .slice(0, 2)
                    .map((p) => p.slug),
            }))
            .sort((a, b) => b.count - a.count),
        audio: {
            wordsFemaleRecorded: count((w) => w.audio.female === 'recorded' || w.audio.female === 'hosted'),
            wordsMaleRecorded: count((w) => w.audio.male === 'recorded' || w.audio.male === 'hosted'),
            wordsHosted: count((w) => w.audio.female === 'hosted' || w.audio.male === 'hosted'),
            sentencesRecorded: sentences.filter((s) => s.audio === 'recorded' || s.audio === 'hosted').length,
            sentencesHosted: sentences.filter((s) => s.audio === 'hosted').length,
        },
    };
}

/** Release stamp: `packs/index.json`, else any pack's `corpusVersion`. */
function packVersion(dir: string, packs: readonly PackRecord[]): string | null {
    const indexPath = join(dir, 'packs', 'index.json');
    if (existsSync(indexPath)) {
        const doc = readJson(indexPath);
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
            const v = asString(pick(doc as Row, 'corpusVersion', 'corpus_version', 'version'));
            if (v !== null) return v;
        }
    }
    return packs.length > 0 ? packs[0]?.corpusVersion ?? null : null;
}

/** Resolve a pack's members to word records, in canonical order. */
export function packWords(corpus: Corpus, pack: PackRecord): WordRecord[] {
    const out: WordRecord[] = [];
    const seen = new Set<string>();
    for (const ref of pack.wordRefs) {
        const word = corpus.byId.get(ref) ?? corpus.bySimplified.get(ref)?.[0];
        if (word !== undefined && !seen.has(word.id)) {
            seen.add(word.id);
            out.push(word);
        }
    }
    return out.sort(canonicalOrder);
}

/** HSK band of a word under one of the three standards. */
export function bandOf(word: WordRecord, standard: 'hsk2026' | 'hsk2021' | 'hsk2_0'): number | null {
    if (standard === 'hsk2026') return word.hsk2026;
    if (standard === 'hsk2021') return word.hsk2021;
    return word.hsk2;
}

/** Levenshtein distance, bounded: returns `max + 1` as soon as it is exceeded. */
export function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row: number[] = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(
                (row[j - 1] ?? 0) + 1,
                (prev[j] ?? 0) + 1,
                (prev[j - 1] ?? 0) + cost
            );
            row.push(v);
            if (v < best) best = v;
        }
        if (best > max) return max + 1;
        prev = row;
    }
    return prev[b.length] ?? max + 1;
}
