/**
 * Zhongdex MCP — the error taxonomy, §5.2 of the revision.
 *
 * Four rules, in force everywhere:
 *   1. Anything a model can fix is a tool-execution error (`isError: true` inside a
 *      normal result), never a JSON-RPC error. JSON-RPC errors are reserved for
 *      unknown tool and malformed CallToolRequest.
 *   2. Partial success beats an error. A 20-word lookup with 2 misses returns
 *      18 records plus a miss block and `isError: false`.
 *   3. Every message names what failed, why, and the exact literal next call.
 *   4. Never coerce silently. Nothing in Zhongdex clamps a parameter into range.
 *
 * The strings below are the shipped interface. They are written to be pasted
 * back as a call, so keep the `Next: <call>` clause last and keep it literal.
 */

/** A tool-execution error: surfaced as `isError: true` for the model to self-correct. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolError';
    }
}

const list = (values: readonly string[]): string => values.join(', ');

/** E15 — there is no quota. Said in every envelope because agents plan around one. */
export const NO_QUOTA = 'no key · no quota · no rate limit';

/** E1 — not found, and not Chinese either. `nearest` is empty when nothing is within edit distance 2. */
export function e1NotChinese(
    term: string,
    missed: number,
    total: number,
    nearest: readonly string[]
): string {
    const others =
        total > missed
            ? ` — ${missed} of ${total} words missed; the other ${total - missed} are in the results above.`
            : ` — ${missed} of ${total} words missed.`;
    const near =
        nearest.length === 0
            ? 'No headword within edit distance 2.'
            : `Nearest headwords: ${list(nearest)}.`;
    return (
        `No entry for "${term}"${others} "${term}" is neither Han characters nor valid numbered pinyin. ` +
        `${near} Next: if this is English, call mandarin_find_words({query:"${term}", query_type:"english"}).`
    );
}

/** E2 — real hanzi, not a headword. `segments` are the known words it splits into. */
export function e2NotAHeadword(
    term: string,
    segments: readonly { hanzi: string; id: string }[],
    unknown: readonly string[]
): string {
    if (segments.length === 0) {
        return (
            `No entry for "${term}". It did not segment into any known word. ` +
            `Next: mandarin_find_words({query:"${term}", query_type:"hanzi"}).`
        );
    }
    const known = segments.map((s) => `${s.hanzi} (${s.id})`).join(' and ');
    const bad =
        unknown.length === 0
            ? ''
            : ` "${unknown.join('", "')}" is not a word.`;
    const next = segments.map((s) => `"${s.hanzi}"`).join(',');
    return `No entry for "${term}". Segmented into known words: ${known}.${bad} Next: mandarin_lookup({words:[${next}]}).`;
}

/** E3 — an ambiguous reading is never an error; both readings come back with this note. */
export function e3Polyphone(hanzi: string, readings: readonly string[]): string {
    const pins = readings.map((r) => `"${hanzi}:${r}"`).join(' or ');
    return `${hanzi} has ${readings.length} readings; both are returned below. Pass ${pins} to pin one.`;
}

/** E4 — one voice has no recording for this string. Cannot fire in 0.1: no clips are hosted. */
export function e4VoiceMissing(
    term: string,
    missingVoice: 'amy' | 'james',
    presentVoice: 'amy' | 'james',
    reason: string
): string {
    const param = missingVoice === 'james' ? 'female' : 'male';
    return (
        `${term} · ${missingVoice}: no recording. The ${presentVoice} URL is above. ${reason} ` +
        `Next: use the ${presentVoice} URL, or pass voice:"${param}" to stop requesting ${missingVoice}.`
    );
}

/** E5 — numbered pinyin missing a tone digit. */
export function e5BadPinyin(term: string, syllable: string, suggestion: string | null): string {
    const head =
        `"${term}" is not valid numbered pinyin: the syllable "${syllable}" carries no tone digit. ` +
        'Every syllable needs 1-5 (5 = neutral), separated by a space or an apostrophe.';
    if (suggestion === null) {
        return `${head} No headword matches those syllables under any tones. Next: pass the characters instead, e.g. mandarin_lookup({words:["你好"]}).`;
    }
    return `${head} Did you mean "${suggestion}"? Next: mandarin_lookup({words:["${suggestion}"]}).`;
}

/** E6 — out of range. Never clamped. */
export function e6OutOfRange(standard: string, passed: number): string {
    if (standard === 'hsk2026') {
        return (
            `hsk must be 1-7 when band_standard is "hsk2026"; you passed ${passed}. ` +
            'HSK 3.0 (2026) has 7 levels, t1-t7. The 2021 revision has 9 — call again with band_standard:"hsk2021" if that is what you meant.'
        );
    }
    if (standard === 'hsk2021') {
        return (
            `hsk must be 1-9 when band_standard is "hsk2021"; you passed ${passed}. ` +
            'The 2021 revision has 9 levels. HSK 3.0 (2026) has 7 — call again with band_standard:"hsk2026" if that is what you meant.'
        );
    }
    return (
        `hsk must be 1-6 when band_standard is "hsk2_0"; you passed ${passed}. ` +
        'HSK 2.0 has 6 levels. Call again with band_standard:"hsk2026" for the current 7-band syllabus.'
    );
}

/** E6 (numeric form) — any other bounded integer parameter. */
export function e6Bounded(param: string, min: number, max: number, passed: number, why: string): string {
    return `${param} must be ${min}-${max}; you passed ${passed}. ${why} Nothing is clamped: call again with a value in range.`;
}

/** E7 — invalid enum. The voice case names the two voices, because "amy" is the near-miss agents make. */
export function e7BadEnum(param: string, allowed: readonly string[], passed: string): string {
    if (param === 'voice' && (passed === 'amy' || passed === 'james')) {
        const which = passed === 'amy' ? 'female' : 'male';
        return (
            `voice must be one of: ${list(allowed)}. You passed "${passed}" — that is the name of the ` +
            `${which} voice, not a value. Pass voice:"${which}".`
        );
    }
    const near = nearest(passed, allowed, 3);
    const tail = near === null ? '' : ` Pass ${param}:"${near}".`;
    return `${param} must be one of: ${list(allowed)}. You passed "${passed}".${tail}`;
}

/** E8 — unknown parameter. Names the legal set, which is what `additionalProperties:false` alone does not. */
export function e8UnknownParameter(tool: string, passed: string, accepted: readonly string[]): string {
    const near = nearest(passed, accepted, 3);
    const tail = near === null ? '' : ` Did you mean "${near}"?`;
    return `Unknown parameter "${passed}". ${tool} accepts: ${list(accepted)}.${tail}`;
}

/** One relaxation the agent could make, and what it would yield. */
export interface Relaxation {
    /** Prose fragment: `Relaxing max_new_words to 1 gives 214 matches`. */
    describe: string;
    /** The literal call that applies it. Null when the relaxation yields nothing either. */
    nextCall: string | null;
}

/**
 * E9 — empty result, with the counts that tell the agent which filter to drop.
 * The relaxation counts are computed by re-running the query with each filter
 * loosened; this function only renders them.
 */
export function e9Empty(
    subject: string,
    filters: readonly string[],
    relaxations: readonly Relaxation[]
): string {
    const head = `0 ${subject} match. Filters: ${filters.join(' · ')}.`;
    const useful = relaxations.filter((r) => r.nextCall !== null);
    if (useful.length === 0) {
        const dead = relaxations.map((r) => r.describe).join('; ');
        return dead.length === 0
            ? `${head} Relaxing any single filter still gives 0. Drop two filters, or widen the level.`
            : `${head} ${dead}. Every single-filter relaxation is still empty — drop two filters, or widen the level.`;
    }
    const counts = useful.map((r) => r.describe).join('; ');
    return `${head} ${counts}. Next: ${useful[0]?.nextCall ?? ''}`;
}

/** E10 — a required combination was not met. */
export function e10MissingCombination(
    tool: string,
    oneOf: readonly string[],
    passed: readonly string[],
    example: string
): string {
    const got =
        passed.length === 0 ? 'You passed no filters.' : `You passed only ${list(passed)}.`;
    return `${tool} needs at least one of: ${list(oneOf)}. ${got} ${example}`;
}

/** E11 — unknown grammar pattern. */
export function e11UnknownPattern(
    passed: string,
    near: readonly { id: string; hanzi: string | null; hsk: number | null }[],
    total: number
): string {
    if (total === 0) {
        return (
            `No pattern "${passed}". This release ships no grammar-pattern index, so the pattern filter ` +
            'matches nothing. Next: filter by the character instead, e.g. mandarin_find_sentences({contains:"把", hsk:4}).'
        );
    }
    if (near.length === 0) {
        return (
            `No pattern "${passed}", and nothing close to it. The full list of ${total} is the resource ` +
            'zhongdex://grammar-patterns. Next: read that resource, then call mandarin_find_sentences with an id from it.'
        );
    }
    const shown = near
        .map((p) => {
            const parts = [p.hanzi, p.hsk === null ? null : `HSK ${p.hsk}`].filter(
                (s): s is string => s !== null
            );
            return parts.length === 0 ? p.id : `${p.id} (${parts.join(', ')})`;
        })
        .join(' · ');
    return (
        `No pattern "${passed}". Nearest: ${shown}. The full list of ${total} is the resource ` +
        `zhongdex://grammar-patterns. Next: mandarin_find_sentences({pattern:"${near[0]?.id ?? ''}"}).`
    );
}

/** E12 — a cursor from a previous release. Cursors are stable within a release, not across. */
export function e12StaleCursor(cursor: string, from: string, current: string): string {
    return (
        `Cursor "${cursor}" is from release ${from}; this server is ${current} and the ordering changed. ` +
        'Restart without a cursor. Cursors are stable within a release.'
    );
}

/** E13 — over the batch cap. */
export function e13BatchCap(tool: string, cap: number, passed: number, why: string): string {
    const batches: string[] = [];
    for (let start = 1; start <= passed; start += cap) {
        batches.push(`${start}-${Math.min(start + cap - 1, passed)}`);
    }
    const plan =
        batches.length <= 4
            ? `Build ${batches.length}: words ${batches.join(', ')}.`
            : `Build ${batches.length}: words ${batches.slice(0, 3).join(', ')} … ${batches[batches.length - 1]}.`;
    return (
        `${tool} takes at most ${cap} words; you passed ${passed}. ${why} ${plan} ` +
        `If these came from mandarin_find_words, call it with limit:${cap} and page with the cursor.`
    );
}

/** The 15-name field vocabulary for `mandarin_build_deck({fields})`. */
export const DECK_FIELDS = [
    'hanzi',
    'traditional',
    'pinyin',
    'pinyin_numbered',
    'english',
    'pos',
    'measure_words',
    'hsk',
    'frequency',
    'audio',
    'sentence',
    'sentence_pinyin',
    'sentence_english',
    'sentence_audio',
    'id',
] as const;

/** E14 — unknown deck field. */
export function e14UnknownField(passed: string): string {
    const near = nearest(passed, DECK_FIELDS, 4);
    const tail = near === null ? '' : ` Did you mean "${near}"?`;
    return `Unknown field "${passed}" in fields[]. Valid: ${list(DECK_FIELDS)}.${tail}`;
}

/** E16 — the response was cut to stay under the 10,000-token client warning. */
export function e16Truncated(
    limitTokens: number,
    returned: number,
    asked: number,
    advice: string
): string {
    return `— Truncated at ${limitTokens.toLocaleString('en-US')} tokens: ${returned} of ${asked} words returned. ${advice}`;
}

/** E17 — unknown pack id. */
export function e17UnknownPack(
    passed: string,
    near: readonly { slug: string; size: number }[],
    total: number
): string {
    if (near.length === 0) {
        return `No pack "${passed}". Call mandarin_packs() for the full list of ${total}.`;
    }
    const shown = near.map((p) => `"${p.slug}" (${p.size.toLocaleString('en-US')} words)`).join(' or ');
    return `No pack "${passed}". Did you mean ${shown}? Call mandarin_packs({kind:"band"}) for the full list of ${total}.`;
}

/** Closest candidate within `max` edits, or null. Used by every "did you mean" clause. */
export function nearest(passed: string, candidates: readonly string[], max: number): string | null {
    let best: string | null = null;
    let bestScore = max + 1;
    for (const candidate of candidates) {
        const score = distance(passed.toLowerCase(), candidate.toLowerCase(), max);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

function distance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row: number[] = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
        }
        prev = row;
    }
    return prev[b.length] ?? max + 1;
}
