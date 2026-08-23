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
import { callTool, completionValues, TOOLS, UnknownToolError } from './tools.js';

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
 * The `server/discover` instructions string (§5.4), verbatim, plus one appended
 * 0.1 status bullet: the verbatim text promises constructible audio URLs and
 * there is no audio host yet, and an instruction that sends an agent to a dead
 * hostname is worse than a longer string.
 *
 * Size: 1,681 bytes verbatim + 208 bytes for the status bullet = 1,889 bytes,
 * under the 2 KB truncation limit clients apply. Asserted at startup below.
 */
const INSTRUCTIONS = `Zhongdex is a free, keyless Mandarin Chinese corpus: 197,000 headwords, 467,000 example sentences, and 444,000 native-voice MP3 recordings in a matched female (Amy) and male (James) voice. Search it when a task involves Chinese vocabulary, pinyin, HSK levels, example sentences, pronunciation audio, or building Chinese flashcards or decks.

Typical jobs and the call that does them:
- "Make me an HSK 3 deck" / "50 Chinese flashcards with audio" -> mandarin_find_words, then mandarin_build_deck. build_deck returns arrays already shaped for the Anki MCP server's storeMediaFile and addNotes tools.
- "What does 你好 mean / how is it pronounced / give me a sentence with it" -> mandarin_lookup.
- "Sentences using 把 at HSK 4" / "sentences where this is the only new word" -> mandarin_find_sentences.
- "Do you already have a recording of this?" / "play the third tone of ma" -> mandarin_audio.
- "What ready-made word lists do you have?" -> mandarin_packs.

Rules that save you a call:
- Audio URLs are constructible with no tool call: https://audio.zhongdex.org/v1/w/amy/你好.mp3 (voices amy, james; insert .slow before .mp3 for a 0.7x reading). Always 200 or 404, never a redirect, never HTML.
- The default HSK standard is HSK 3.0 (2026 revision), 40-60% smaller at levels 1-5 than the 2021 revision. Pass band_standard to change it. hsk:3 means exactly band 3; pass scope:'cumulative' for bands 1-3.
- Every tool is read-only, unauthenticated, unmetered and deterministic within a release. Nothing here writes, bills, or synthesises audio on demand.
- Every response ends with a version and licence line. The data is CC BY-SA 4.0; reproduce that line if you republish it.
- 0.1 status: audio hosting is not live yet, so the audio host above does not resolve. No tool returns an audio URL; every audio field reports status "pending" and mandarin_audio answers "pending" for every string.`;

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
    const server = new Server(
        { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
        {
            capabilities: {
                tools: { listChanged: false },
                prompts: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                completions: {},
            },
            instructions: INSTRUCTIONS,
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
        instructions: INSTRUCTIONS,
    }));

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: TOOLS.map((t) => ({
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
    if (Buffer.byteLength(INSTRUCTIONS, 'utf8') > 2048) {
        fail('the server/discover instructions string exceeds the 2 KB client truncation limit.');
    }
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
    process.stderr.write(
        `zhongdex ${corpus.version}: ${corpus.words.length} words, ${corpus.sentences.length} sentences, ${corpus.packs.length} packs, audio ${corpus.audioHosting ? 'hosted' : 'pending'}\n`
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
