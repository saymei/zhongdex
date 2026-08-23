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
 *   data/sentences.jsonl           optional. One SentenceRow per line.
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
 * There is no audio hosting in 0.1 and no audio index in the data. Nothing in
 * this module emits an audio URL; `audioHosting` is false and the tool layer
 * reports status "pending" instead of a URL that would 404.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class DataMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DataMissingError';
    }
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
}

export interface SentenceRecord {
    id: string;
    hanzi: string;
    pinyin: string;
    pinyinNumbered: string | null;
    english: string;
    /** ZSG grade 1-7: the highest HSK 3.0 band of any word in the sentence. */
    difficulty: number | null;
    /** Simplified word forms attested in the sentence. */
    words: string[];
    pattern: string | null;
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
    patterns: GrammarPattern[];
    packs: PackRecord[];
    packsBySlug: Map<string, PackRecord>;
    /** Slugs of `kind: "theme"` packs — the published topic list for `topic`. */
    topics: string[];
    /** False in 0.1: no clips are hosted, so no tool may return an audio URL. */
    audioHosting: boolean;
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
        const audio = pick(row, 'audio');
        if (audio && typeof audio === 'object') {
            if (asString(pick(audio as Row, 'female')) !== null || asString(pick(audio as Row, 'male')) !== null) {
                audioHosting = true;
            }
        }
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
        out.push({
            id,
            hanzi,
            pinyin: asString(pick(row, 'pinyin', 'pinyin_marked')) ?? '',
            pinyinNumbered: asString(pick(row, 'pinyin_numbered', 'pinyinNumbered')),
            english: asString(pick(row, 'english', 'en', 'translation')) ?? '',
            difficulty: asNumber(pick(row, 'difficulty', 'grade', 'zsg')),
            words: asStringArray(pick(row, 'words', 'word_forms', 'tokens')),
            pattern: asString(pick(row, 'pattern', 'grammar_pattern')),
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
        patterns: loadPatterns(dir, sentences),
        packs,
        packsBySlug,
        topics: packs.filter((p) => p.kind === 'theme').map((p) => p.slug).sort(),
        audioHosting,
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
