/**
 * Zhongdex MCP — response rendering and the token-budget contract (§5.3).
 *
 * Responses are concise markdown, not JSON. The reason is arithmetic: the target
 * is 10,000 tokens per response because Claude Code warns above 10,000 and errors
 * above 25,000, and a tool that reliably warns gets switched off. Budgets:
 *
 *   mandarin_lookup          165 tok/word concise · 400 detailed   (20 words = 3,300)
 *   mandarin_find_words       11 tok/word                          (100 words = 1,100)
 *   mandarin_find_sentences   55 tok/sentence                      (50 = 2,750)
 *   mandarin_audio             3 tok/string check_only · 30 fetch  (100 = 3,000)
 *   mandarin_build_deck       62 tok/word                          (100 words = 6,200)
 *   mandarin_packs            38 tok/pack                          (54 = 2,050)
 *
 * `_meta["anthropic/maxResultSizeChars"]` is deliberately NOT set: raising your
 * own ceiling is the wrong move when you can fit under the default.
 */

import { NO_QUOTA } from './errors.js';
import type { Corpus, PackRecord, SentenceRecord, WordRecord } from './data.js';

/** The per-response ceiling every tool renders under. */
export const TOKEN_BUDGET = 10_000;

const LICENCE = 'CC BY-SA 4.0';

/**
 * Approximate tokens. CJK runs about one token per character; Latin text about
 * one per four. Used only to decide when to truncate, so an estimate is enough.
 */
export function estimateTokens(text: string): number {
    let cjk = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2ebef)) {
            cjk++;
        }
    }
    const rest = [...text].length - cjk;
    return cjk + Math.ceil(rest / 4);
}

/** Footer for a single-shot (non-paginated) envelope. */
export function envelopeFooter(corpus: Corpus): string {
    return `— zhongdex ${corpus.version} · ${LICENCE} · ${NO_QUOTA}`;
}

/**
 * Footer for a paginated list. `total` is always present so an agent knows the
 * size of the set before spending a call on paging.
 */
export function listFooter(
    corpus: Corpus,
    shown: number,
    total: number,
    unit: string,
    nextCursor: string | null,
    maxLimit: number
): string {
    const parts = [`${shown} of ${total.toLocaleString('en-US')} ${unit}`];
    if (nextCursor !== null) parts.push(`next_cursor "${nextCursor}"`);
    parts.push(`limit max ${maxLimit}`, `zhongdex ${corpus.version}`, LICENCE, 'no key, no quota');
    return `— ${parts.join(' · ')}`;
}

/* ── cursors ─────────────────────────────────────────────────────────────── */

/**
 * Cursors stay readable so a model can reason about position and a human can
 * debug a transcript. The `@release` suffix is what makes E12 computable — a
 * bare id cannot tell "you are past the end" from "this is last month's id".
 */
export function encodeCursor(corpus: Corpus, id: string): string {
    return `${id}@${corpus.version}`;
}

export function decodeCursor(cursor: string): { id: string; release: string | null } {
    const at = cursor.lastIndexOf('@');
    if (at === -1) return { id: cursor, release: null };
    return { id: cursor.slice(0, at), release: cursor.slice(at + 1) };
}

/* ── words ───────────────────────────────────────────────────────────────── */

/**
 * Detail rungs for `mandarin_lookup`, dropped in this order under budget
 * pressure (§5.3). Rungs for the per-character syllable map and for sentence
 * audio are no-ops in 0.1: neither is in the data.
 *
 *   0  full concise      1  stretch sentences dropped
 *   2  measure words / traditional / zipf dropped
 *   3  senses beyond the first two dropped
 *   4  sentence text dropped
 *
 * Never dropped at any rung: id, hanzi, tone-marked pinyin, primary gloss, the
 * audio line, the HSK band, the footer.
 */
export type DetailRung = 0 | 1 | 2 | 3 | 4;

export interface WordRenderOptions {
    sentences: number;
    script: 'simplified' | 'traditional' | 'both';
    detailed: boolean;
    rung: DetailRung;
}

function bandLine(word: WordRecord): string {
    const parts: string[] = [];
    if (word.hsk2026 !== null) parts.push(`HSK ${word.hsk2026} (2026)`);
    if (word.hsk2021 !== null) parts.push(`${word.hsk2021} (2021)`);
    if (word.hsk2 !== null) parts.push(`${word.hsk2} (2.0)`);
    return parts.length === 0 ? 'off-list' : parts.join(' · ');
}

function headword(word: WordRecord, script: WordRenderOptions['script']): string {
    if (script === 'traditional') return word.traditional;
    if (script === 'both' && word.traditional !== word.simplified) {
        return `${word.simplified} / ${word.traditional}`;
    }
    return word.simplified;
}

export function renderWord(
    corpus: Corpus,
    word: WordRecord,
    options: WordRenderOptions
): string {
    const lines: string[] = [];
    const pinyin = [word.pinyin, word.pinyinNumbered].filter((s): s is string => !!s).join(' · ');
    lines.push(`## ${headword(word, options.script)} · ${pinyin}`);

    const senseCap = options.rung >= 3 ? 2 : word.gloss.length;
    const gloss = word.gloss.length === 0 ? '(no gloss in this release)' : word.gloss.slice(0, senseCap).join('; ');
    const facts: string[] = [gloss];
    if (word.pos.length > 0) facts.push(word.pos.join('/'));
    facts.push(bandLine(word));
    if (word.freq !== null) facts.push(`freq ${word.freq}`);
    if (options.rung < 2) {
        if (word.zipf !== null) facts.push(`zipf ${word.zipf}`);
        if (options.script === 'simplified' && word.traditional !== word.simplified) {
            facts.push(`trad ${word.traditional}`);
        }
    }
    lines.push(facts.join(' · '));

    const tail = [`id ${word.id}`, audioStatus(corpus)];
    if (options.detailed && word.packs.length > 0) tail.push(`packs ${word.packs.join(', ')}`);
    lines.push(tail.join(' · '));

    if (options.rung < 4 && options.sentences > 0) {
        const cap = options.rung >= 1 ? Math.min(1, options.sentences) : options.sentences;
        const picked = word.sentenceIds
            .map((id) => corpus.sentencesById.get(id))
            .filter((s): s is SentenceRecord => s !== undefined)
            .slice(0, cap);
        for (const s of picked) lines.push(`- ${renderSentenceInline(s, options.detailed)}`);
    }
    return lines.join('\n');
}

function renderSentenceInline(sentence: SentenceRecord, detailed: boolean): string {
    const parts = [sentence.hanzi];
    if (sentence.pinyin !== '') parts.push(sentence.pinyin);
    if (detailed && sentence.pinyinNumbered !== null) parts.push(sentence.pinyinNumbered);
    const grade = sentence.difficulty === null ? '' : ` [d${sentence.difficulty}]`;
    return `${parts.join(' ')} — ${sentence.english}${grade}`;
}

/** One line per word, ~11 tokens: the `mandarin_find_words` row. */
export function renderWordLine(word: WordRecord): string {
    const gloss = word.gloss.length === 0 ? '—' : word.gloss[0];
    const band = word.hsk2026 === null ? '' : ` t${word.hsk2026}`;
    return `${word.id} ${word.simplified} ${word.pinyin} ${gloss}${band}`;
}

/** ~55 tokens: the `mandarin_find_sentences` row. */
export function renderSentence(corpus: Corpus, sentence: SentenceRecord): string {
    const head = `${sentence.id} · d${sentence.difficulty ?? '?'}${sentence.pattern === null ? '' : ` · ${sentence.pattern}`}`;
    const pinyin = [sentence.pinyin, sentence.pinyinNumbered]
        .filter((s): s is string => !!s)
        .join(' / ');
    return `${head}\n${sentence.hanzi}\n${pinyin}\n${sentence.english}\n${audioStatus(corpus)}`;
}

/** ~38 tokens: the `mandarin_packs` row. */
export function renderPack(corpus: Corpus, pack: PackRecord): string {
    const facts = [pack.kind, `${pack.size.toLocaleString('en-US')} words`];
    if (pack.closedAt !== null) facts.push(`band-closed at t${pack.closedAt}`);
    facts.push(audioCoverage(corpus));
    return `${pack.slug} · ${pack.title} · ${facts.join(' · ')}\n  ${pack.oneLiner}`;
}

/* ── audio ───────────────────────────────────────────────────────────────── */

/**
 * There is no audio hosting yet, so no tool emits a URL. Saying "pending" is the
 * only honest option: a constructed URL would 404 and the agent would report a
 * broken card as a working one.
 */
export function audioStatus(corpus: Corpus): string {
    return corpus.audioHosting ? 'audio: see urls above' : 'audio: pending (not hosted in this release)';
}

function audioCoverage(corpus: Corpus): string {
    return corpus.audioHosting ? 'audio available' : 'audio pending';
}

/* ── assembly ────────────────────────────────────────────────────────────── */

/**
 * Join blocks under the token budget, dropping detail before dropping records.
 * `render(rung)` must be pure so it can be called repeatedly.
 */
export function fitToBudget(
    count: number,
    render: (rung: DetailRung, upTo: number) => string,
    onTruncate: (returned: number, asked: number) => string,
    budget = TOKEN_BUDGET
): string {
    for (const rung of [0, 1, 2, 3, 4] as const) {
        const body = render(rung, count);
        if (estimateTokens(body) <= budget) return body;
    }
    // Still over at the leanest rung: drop records and say so.
    let lo = 1;
    let hi = count;
    let best = 1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (estimateTokens(render(4, mid)) <= budget) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return `${render(4, best)}\n${onTruncate(best, count)}`;
}
