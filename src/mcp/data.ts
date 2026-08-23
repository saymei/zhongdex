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
 *   data/sentences.json            optional. `{version, sentences: SentenceRow[]}` or a bare array.
 *   data/grammar_patterns.json     optional. `{id, hanzi?, gloss?, hsk?}[]` or a bare id[].
 *
 * WordRow field names are read through a small alias list because the build
 * scripts are written by a sibling agent and the exact spelling is not frozen:
 *
 *   simplified        simplified | Simplified | hanzi | word
 *   traditional       traditional | Traditional | trad
 *   pinyin (marked)   pinyin | Pinyin | pinyin_marked | pinyin.marked
 *   pinyin (numbered) pinyin_numbered | pinyinNumbered | numbered | pinyin.numbered
 *   pos               pos | POS            (string or string[])
 *   band 2026         band2026 | hsk_2026 | hsk2026 | hsk.band2026
 *   band 2021         band2021 | hsk_2021 | hsk2021 | hsk.band2021
 *   HSK 2.0 level     hsk2Level | hsk_2_0 | hsk2 | hsk.hsk2
 *   gloss             gloss | english | en | glosses   (string or string[])
 *   frequency rank    freq | frequency_rank | frequencyRank
 *   zipf              zipf | zipfScore
 *   sentence ids      sentences | sentence_ids
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

function asStringArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map(asString).filter((s): s is string => s !== null);
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

function loadWords(dir: string): { version: string; words: WordRecord[] } {
    const path = join(dir, 'hsk_bands.json');
    if (!existsSync(path)) {
        throw new DataMissingError(`${path} is missing.`);
    }
    const doc = readJson(path);
    const version =
        (!Array.isArray(doc) && doc && typeof doc === 'object'
            ? asString(pick(doc as Row, 'version', 'corpus_version'))
            : null) ?? '0.0.0-dev';

    const words: WordRecord[] = [];
    for (const row of rowsOf(doc, 'words', 'entries', 'rows')) {
        const simplified = asString(pick(row, 'simplified', 'Simplified', 'hanzi', 'word'));
        if (simplified === null) continue;
        const pinyinNumbered = asString(
            pick(row, 'pinyin_numbered', 'pinyinNumbered', 'numbered', 'pinyin.numbered')
        );
        words.push({
            id: `dex:w:${simplified}:${pinyinNumbered === null ? '-' : numberedKey(pinyinNumbered)}`,
            simplified,
            traditional:
                asString(pick(row, 'traditional', 'Traditional', 'trad')) ?? simplified,
            pinyin:
                asString(pick(row, 'pinyin', 'Pinyin', 'pinyin_marked', 'pinyin.marked')) ??
                pinyinNumbered ??
                '',
            pinyinNumbered,
            pos: asStringArray(pick(row, 'pos', 'POS')),
            gloss: asStringArray(pick(row, 'gloss', 'english', 'en', 'glosses')),
            hsk2026: asNumber(pick(row, 'band2026', 'hsk_2026', 'hsk2026', 'hsk.band2026')),
            hsk2021: asNumber(pick(row, 'band2021', 'hsk_2021', 'hsk2021', 'hsk.band2021')),
            hsk2: asNumber(pick(row, 'hsk2Level', 'hsk_2_0', 'hsk2', 'hsk.hsk2')),
            freq: asNumber(pick(row, 'freq', 'frequency_rank', 'frequencyRank')),
            zipf: asNumber(pick(row, 'zipf', 'zipfScore')),
            sentenceIds: asStringArray(pick(row, 'sentences', 'sentence_ids')),
            packs: [],
        });
    }
    if (words.length === 0) {
        throw new DataMissingError(`${path} contains no word rows.`);
    }
    return { version, words };
}

function loadSentences(dir: string): SentenceRecord[] {
    const path = join(dir, 'sentences.json');
    if (!existsSync(path)) return [];
    const out: SentenceRecord[] = [];
    for (const row of rowsOf(readJson(path), 'sentences', 'rows')) {
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

function loadPacks(dir: string): PackRecord[] {
    const packDir = join(dir, 'packs');
    if (!existsSync(packDir)) {
        throw new DataMissingError(`${packDir} is missing.`);
    }
    const files = readdirSync(packDir).filter((f) => f.endsWith('.json')).sort();
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
        const closure = pick(row, 'band_closure');
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
        packs.push({
            id: asString(pick(row, 'id')) ?? `dex:p:${slug}`,
            slug,
            kind: asString(pick(row, 'kind')) ?? 'theme',
            title: asString(pick(row, 'title')) ?? slug,
            oneLiner: asString(pick(row, 'one_liner', 'oneLiner', 'description')) ?? '',
            size: asNumber(pick(row, 'size')) ?? wordRefs.length,
            level:
                level && typeof level === 'object' ? asNumber(pick(level as Row, 'band')) : asNumber(level),
            closedAt:
                closure && typeof closure === 'object' ? asNumber(pick(closure as Row, 'closed_at')) : null,
            wordRefs,
            query:
                selection && typeof selection === 'object' ? asString(pick(selection as Row, 'query')) : null,
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
    const { version, words } = loadWords(dir);
    words.sort(canonicalOrder);

    const byId = new Map<string, WordRecord>();
    const bySimplified = new Map<string, WordRecord[]>();
    const byTraditional = new Map<string, WordRecord[]>();
    const byNumbered = new Map<string, WordRecord[]>();
    for (const w of words) {
        if (!byId.has(w.id)) byId.set(w.id, w);
        push(bySimplified, w.simplified, w);
        if (w.traditional !== w.simplified) push(byTraditional, w.traditional, w);
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
        version,
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
        audioHosting: false,
    };
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
