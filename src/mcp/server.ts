#!/usr/bin/env node
/**
 * Zhongdex MCP server — stdio entry point.
 *
 * v0.1 speaks stdio because that is the transport an operator can install and
 * test in one line. The tool layer (`tools.ts`) knows nothing about transports:
 * adding streamable HTTP later means writing a second entry point that calls
 * {@link createServer} and hands it a different transport, with no change to
 * any tool.
 *
 * Everything is served from the local build under `data/` (override with
 * ZHONGDEX_DATA_DIR). There is no network access at startup or at request time.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    CompleteRequestSchema,
    ErrorCode,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { DataMissingError, loadCorpus, type Corpus } from './data.js';
import { buildTools, callTool, completionValues, UnknownToolError } from './tools.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_NAME = 'zhongdex';
const SERVER_TITLE = 'Zhongdex — Mandarin corpus';
const SERVER_VERSION = '0.1.0';

/**
 * Everything this server returns is a monthly-rebuilt public corpus with no
 * user-specific data anywhere, so it can honestly cache publicly for a day —
 * which most servers cannot. Absent `ttlMs` a client assumes 0 and refetches
 * the tool list constantly.
 */
const CACHE = { ttlMs: 86_400_000, cacheScope: 'public' as const };

/**
 * The `server/discover` instructions string — the first and often only thing an
 * agent reads before deciding whether to call this server, which makes it the
 * one string where an overstatement does the most damage.
 *
 * Every number in it is derived from the corpus that was actually loaded, so it
 * cannot drift from what the build produced. Anything not in this release is
 * stated as absent, in the present tense, rather than folded in as if shipped.
 * Clients truncate at 2 KB; {@link main} asserts the built string fits.
 */
export function buildInstructions(corpus: Corpus): string {
    const n = (v: number): string => v.toLocaleString('en-US');
    const withSentences = corpus.words.filter((w) => w.sentenceIds.length > 0).length;
    const coverage = corpus.words.length === 0 ? 0 : (withSentences / corpus.words.length) * 100;

    const a = corpus.stats.audio;
    const absent: string[] = [];
    if (!corpus.audioHosting) {
        absent.push(
            `No hosted audio - ${n(a.wordsFemaleRecorded)} headwords and ${n(a.sentencesRecorded)} sentences have a female-voice recording in the archive (${n(a.wordsMaleRecorded)} male), none published, so no clip or URL is ever returned and decks carry no [sound:] refs`
        );
    }
    if (!corpus.words.some((w) => w.freq !== null)) absent.push('no frequency ranks');
    if (!corpus.words.some((w) => w.hsk2021 !== null || w.hsk2 !== null)) {
        absent.push('no 2021 or HSK 2.0 band labels, so band_standard has one usable value');
    }
    if (corpus.patterns.length === 0) absent.push('no grammar-pattern index');
    if (corpus.topics.length === 0) absent.push('no topic packs');

    const sentences =
        corpus.sentences.length === 0
            ? 'no example sentences yet'
            : `${n(corpus.sentences.length)} graded example sentences covering ${coverage.toFixed(1)}% of them`;

    const quality =
        corpus.sentences.length === 0
            ? ''
            : '\n\nSentence quality, measured on a 42-sentence read: ~75% clearly natural, ~15% awkward but parseable, ~8-10% clearly broken, concentrated on band 7 and single-character headwords. Check band-7 sentences before showing a learner.';

    return `Zhongdex is a free, keyless Mandarin Chinese corpus. Release ${corpus.version} holds ${n(corpus.words.length)} HSK 3.0 (2026) headwords with pinyin, part of speech and glosses, ${sentences}, and ${corpus.packs.length} computed vocabulary packs. Search it when a task involves Chinese vocabulary, pinyin, HSK levels, example sentences, or building Chinese flashcards and decks.

Typical jobs and the call that does them:
- "Make me an HSK 3 deck" -> mandarin_find_words, then mandarin_build_deck, which returns an array already shaped for the Anki MCP server's addNotes tool.
- "What does 你好 mean / give me a sentence with it" -> mandarin_lookup.
- "Sentences using 把 at HSK 4" / "where this is the only new word" -> mandarin_find_sentences.
- "What ready-made word lists do you have?" -> mandarin_packs.

Not in this release, so do not plan around it: ${absent.join('; ')}. Filters needing any of these return an empty result that names what to call instead.${quality}

Rules that save you a call:
- hsk:3 means exactly band 3; pass scope:'cumulative' for bands 1-3. HSK 3.0 (2026) took effect 1 July 2026 and is 40-60% smaller at levels 1-5 than the 2021 revision.
- Every tool is read-only, unauthenticated, unmetered and deterministic within a release. Nothing writes, bills, or synthesises audio on demand.
- Every response ends with a version and licence line. The data is CC BY-SA 4.0; reproduce it if you republish.`;
}

/* ── prompts ─────────────────────────────────────────────────────────────── */

const PROMPTS = [
    {
        name: 'build-hsk-deck',
        title: 'Build an HSK deck',
        description: 'Select a band with mandarin_find_words, then build an import-ready deck.',
        arguments: [
            { name: 'level', description: 'HSK 3.0 (2026) band, 1-7.', required: true },
            { name: 'size', description: 'How many words. Max 100 per build.', required: false },
            { name: 'voice', description: 'both | female | male.', required: false },
        ],
    },
    {
        name: 'sentence-mine-this-text',
        title: 'Sentence-mine a passage',
        description: 'Pull the unknown words out of a passage and turn them into cards.',
        arguments: [
            { name: 'text', description: 'The Chinese passage.', required: true },
            { name: 'level', description: 'The learner HSK level, 1-7.', required: false },
        ],
    },
    {
        name: 'drill-these-tones',
        title: 'Drill tone pairs',
        description: 'Build a minimal-pair drill for one or more tone pairs.',
        arguments: [{ name: 'pairs', description: "Tone pairs, e.g. '2-3,3-3'.", required: true }],
    },
    {
        name: 'build-a-pack-deck',
        title: 'Build a deck from a pack',
        description: 'Turn a curated pack into a deck, minus what the learner already knows.',
        arguments: [
            { name: 'pack', description: 'A pack id from mandarin_packs.', required: true },
            { name: 'exclude', description: 'Comma-separated pack ids to subtract.', required: false },
            { name: 'voice', description: 'both | female | male.', required: false },
        ],
    },
] as const;

function promptText(name: string, args: Record<string, string>): string {
    const voice = args['voice'] ?? 'female';
    switch (name) {
        case 'build-hsk-deck':
            return (
                `Using zhongdex, call mandarin_find_words({hsk:${args['level'] ?? '3'}, limit:${args['size'] ?? '50'}}), then ` +
                `mandarin_build_deck with those ids, voice:"${voice}" and deck_name:"Zhongdex::HSK ${args['level'] ?? '3'}". ` +
                'Then store the media (none yet in 0.1) and add the notes with my Anki MCP server, media before notes.'
            );
        case 'sentence-mine-this-text':
            return (
                `Here is a Chinese passage:\n\n${args['text'] ?? ''}\n\n` +
                `Using zhongdex, look up every word in it with mandarin_lookup, keep the ones above HSK ${args['level'] ?? '3'}, ` +
                'and build a deck from those with mandarin_build_deck.'
            );
        case 'drill-these-tones':
            return (
                `Using zhongdex, call mandarin_audio({text:[${(args['pairs'] ?? '2-3')
                    .split(',')
                    .map((p) => `"${p.trim()}"`)
                    .join(', ')}], contrast:true}) and drill me on the contrasts it returns.`
            );
        case 'build-a-pack-deck':
            return (
                `Using zhongdex, call mandarin_build_deck({pack:"${args['pack'] ?? ''}"` +
                (args['exclude'] === undefined
                    ? ''
                    : `, exclude_packs:[${args['exclude']
                          .split(',')
                          .map((p) => `"${p.trim()}"`)
                          .join(', ')}]`) +
                `, voice:"${voice}"}), then import the result with my Anki MCP server.`
            );
        default:
            throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${name}".`);
    }
}

/* ── resources ───────────────────────────────────────────────────────────── */

/**
 * Resources are a human and docs surface here, not a data path — there is no
 * resource per word, because 197k entries makes `resources/list` unusable and
 * Claude Code renders resources as `@`-mention completions. The word template
 * exists for that picker; pipelines should use the tools.
 */
function staticResources(corpus: Corpus): { uri: string; name: string; description: string }[] {
    const bands = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        uri: `zhongdex://hsk/${n}`,
        name: `hsk-${n}`,
        description: `HSK 3.0 (2026) band t${n}.`,
    }));
    return [
        { uri: 'zhongdex://dataset-card', name: 'dataset-card', description: 'What this release contains and how it was built.' },
        { uri: 'zhongdex://fields', name: 'fields', description: 'Field dictionary for every record type.' },
        { uri: 'zhongdex://grammar-patterns', name: 'grammar-patterns', description: `The ${corpus.patterns.length} grammar pattern ids.` },
        { uri: 'zhongdex://topics', name: 'topics', description: `The ${corpus.topics.length} published topics.` },
        { uri: 'zhongdex://packs', name: 'packs', description: `The ${corpus.packs.length} curated packs.` },
        ...bands,
        { uri: 'zhongdex://licence', name: 'licence', description: 'CC BY-SA 4.0, and how to attribute.' },
        { uri: 'zhongdex://changelog', name: 'changelog', description: 'What changed in this release.' },
    ];
}

function readResource(corpus: Corpus, uri: string): string {
    if (uri.startsWith('zhongdex://word/')) {
        const id = decodeURIComponent(uri.slice('zhongdex://word/'.length));
        const word = corpus.byId.get(id) ?? corpus.bySimplified.get(id)?.[0];
        if (word === undefined) {
            throw new McpError(ErrorCode.InvalidParams, `No word "${id}". Call mandarin_find_words to select ids.`);
        }
        return JSON.stringify(word, null, 1);
    }
    const band = uri.match(/^zhongdex:\/\/hsk\/([1-7])$/);
    if (band !== null) {
        const n = Number(band[1]);
        const rows = corpus.words.filter((w) => w.hsk2026 === n);
        return [`# HSK 3.0 (2026) band t${n} — ${rows.length} words`, ...rows.map((w) => `${w.simplified}\t${w.pinyin}\t${w.gloss[0] ?? ''}`)].join('\n');
    }
    switch (uri) {
        case 'zhongdex://dataset-card':
            return [
                `# Zhongdex ${corpus.version}`,
                '',
                `Words: ${corpus.words.length.toLocaleString('en-US')}. Sentences: ${corpus.sentences.length.toLocaleString('en-US')}. Packs: ${corpus.packs.length}.`,
                'Word membership in every pack is computed by a published deterministic query, never written by a model.',
                'Audio: not hosted in this release. No tool returns an audio URL; audio fields report status "pending".',
                'Licence: CC BY-SA 4.0 for the corpus. Read-only, keyless, unmetered.',
            ].join('\n');
        case 'zhongdex://fields':
            return [
                '# Field dictionary',
                'id                 dex:w:<simplified>:<numbered pinyin, spaces stripped>',
                'simplified         headword in simplified script',
                'traditional        headword in traditional script',
                'pinyin             tone-marked',
                'pinyinNumbered     numbered, space separated, e.g. "ni3 hao3"',
                'pos                part-of-speech codes as published',
                'gloss              English senses, first is primary',
                'hsk2026/2021/hsk2  band under each of the three standards, null when off-list',
                'freq / zipf        frequency rank and Zipf score, null when unranked',
                'packs              pack slugs this word belongs to',
            ].join('\n');
        case 'zhongdex://grammar-patterns':
            return corpus.patterns.length === 0
                ? 'No grammar-pattern index in this release.'
                : corpus.patterns.map((p) => `${p.id}\t${p.hanzi ?? ''}\t${p.hsk === null ? '' : `HSK ${p.hsk}`}`).join('\n');
        case 'zhongdex://topics':
            return corpus.topics.length === 0 ? 'No topic packs in this release.' : corpus.topics.join('\n');
        case 'zhongdex://packs':
            return corpus.packs
                .map((p) => `${p.slug}\t${p.kind}\t${p.size}\t${p.title}`)
                .join('\n');
        case 'zhongdex://licence':
            return [
                'Corpus: CC BY-SA 4.0.',
                'Attribution: SayMei Zhongdex — https://saymei.app/dex',
                'Reproduce the attribution line if you republish any part of it.',
            ].join('\n');
        case 'zhongdex://changelog':
            return `${corpus.version} — first public release. Audio hosting is not live yet.`;
        default:
            throw new McpError(ErrorCode.InvalidParams, `No resource "${uri}".`);
    }
}

/* ── server ──────────────────────────────────────────────────────────────── */

/** `server/discover` is MUST-implement in revision 2026-07-28. */
const DiscoverRequestSchema = z.object({
    method: z.literal('server/discover'),
    params: z.optional(z.object({}).passthrough()),
});

/**
 * Build the MCP server over a loaded corpus. Transport-free: the caller
 * connects stdio today, streamable HTTP later.
 */
export function createServer(corpus: Corpus): Server {
    const instructions = buildInstructions(corpus);
    const tools = buildTools(corpus);
    const server = new Server(
        { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
        {
            capabilities: {
                tools: { listChanged: false },
                prompts: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                completions: {},
            },
            instructions,
        }
    );

    server.setRequestHandler(DiscoverRequestSchema, () => ({
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: corpus.version },
        capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            completions: {},
        },
        ...CACHE,
        instructions,
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.outputSchema === undefined ? {} : { outputSchema: t.outputSchema }),
            annotations: t.annotations,
        })),
        ...CACHE,
    }));

    server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
        try {
            return callTool(corpus, request.params.name, request.params.arguments) as CallToolResult;
        } catch (error) {
            if (error instanceof UnknownToolError) {
                throw new McpError(ErrorCode.MethodNotFound, error.message);
            }
            throw error;
        }
    });

    server.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: PROMPTS.map((p) => ({
            name: p.name,
            title: p.title,
            description: p.description,
            arguments: p.arguments.map((a) => ({ ...a })),
        })),
        ...CACHE,
    }));

    server.setRequestHandler(GetPromptRequestSchema, (request) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: promptText(request.params.name, request.params.arguments ?? {}) },
            },
        ],
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: staticResources(corpus).map((r) => ({ ...r, mimeType: 'text/plain' })),
        ...CACHE,
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
        resourceTemplates: [
            {
                uriTemplate: 'zhongdex://word/{id}',
                name: 'word',
                description: 'One headword record by id. Ids come from mandarin_find_words.',
                mimeType: 'application/json',
            },
        ],
        ...CACHE,
    }));

    server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
        contents: [
            {
                uri: request.params.uri,
                mimeType: request.params.uri.startsWith('zhongdex://word/') ? 'application/json' : 'text/plain',
                text: readResource(corpus, request.params.uri),
            },
        ],
        ...CACHE,
    }));

    server.setRequestHandler(CompleteRequestSchema, (request) => {
        const argument = request.params.argument;
        const values = completionValues(corpus, argument.name, argument.value);
        return {
            completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 },
        };
    });

    return server;
}

/* ── entry point ─────────────────────────────────────────────────────────── */

function dataDir(): string {
    const override = process.env['ZHONGDEX_DATA_DIR'];
    return override === undefined || override === '' ? resolve(PACKAGE_ROOT, 'data') : resolve(override);
}

function fail(message: string): never {
    process.stderr.write(`zhongdex: ${message}\n`);
    process.exit(1);
}

async function main(): Promise<void> {
    const dir = dataDir();
    let corpus: Corpus;
    try {
        corpus = loadCorpus(dir);
    } catch (error) {
        if (error instanceof DataMissingError) {
            fail(
                `${error.message}\n` +
                    `zhongdex: the built corpus is missing from ${dir}. Run \`npm run build\` first ` +
                    '(or set ZHONGDEX_DATA_DIR to a directory that already has it). No data is fetched at runtime.'
            );
        }
        fail(`could not load the corpus from ${dir}: ${(error as Error).message}`);
    }
    const bytes = Buffer.byteLength(buildInstructions(corpus), 'utf8');
    if (bytes > 2048) {
        fail(
            `the server/discover instructions string is ${bytes} bytes, over the 2 KB limit clients truncate at.`
        );
    }
    process.stderr.write(
        `zhongdex ${corpus.version}: ${corpus.words.length} words, ${corpus.sentences.length} sentences, ` +
            `${corpus.packs.length} packs, audio ${corpus.audioHosting ? 'hosted' : 'pending'}; instructions ${bytes} B\n`
    );
    await createServer(corpus).connect(new StdioServerTransport());
}

// Only the stdio entry point runs main(); an HTTP entry point imports
// createServer() from here and connects its own transport.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        fail((error as Error).message);
    });
}
