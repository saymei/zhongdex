# AGENTS.md — orientation for coding agents

You are in `saymei/zhongdex`. Read this before editing. It is ~200 lines and
covers everything you need; you should not have to grep the tree to orient.

## What this repo is

An openly-licensed Mandarin corpus and the code that builds it. One build reads
pinned sources, emits a versioned word canon plus a set of computed card packs,
and serves them over an MCP server. Text canon and packs are real and built
today. **Audio is not published yet.**

Two licences, deliberately split:

- **Code** (`src/`, `scripts/`, `evals/`) — MIT.
- **Data** (`data/`, and everything built from it) — **CC BY-SA 4.0**, forced by
  CC-CEDICT and Wiktionary upstream. ShareAlike propagates: anything you build
  that contains a substantial portion of `data/` is also CC BY-SA 4.0. You
  cannot relicense it MIT. See `NOTICE` for the attribution each source
  requires and `data/LICENSE` for the terms.

## Commands

```
npm ci                  # install
npm run build           # build:canon then build:packs -> writes data/
npm run typecheck       # tsc --noEmit; must pass with zero errors
npm run eval:contract   # Tier 0 contract eval; no LLM, no network, < 10 s
npm run mcp             # run the MCP server locally
```

`npm run build` must run before `npm run eval:contract` on a clean checkout —
the eval reads `data/`, and `data/` is a build output, not a committed source.

CI (`.github/workflows/ci.yml`) runs exactly: `npm ci`, `npm run typecheck`,
`npm run build`, `npm run eval:contract`, on Node 22. If those four pass
locally, CI passes.

## Layout

```
scripts/hsk30.csv        pinned HSK 3.0 (2026) source list; 11,092 rows
src/build/canon.ts       builds the word canon into data/
src/build/pack-schema.ts pack-v1 types, digest function, per-pack validator
src/build/packs.ts       builds the computed packs into data/
src/mcp/server.ts        the MCP server
evals/contract.ts        Tier 0 contract eval
data/                    BUILD OUTPUT. CC BY-SA 4.0. Do not hand-edit.
```

## What the MCP server does

Server name `zhongdex`; tools prefixed `mandarin_`. The prefix split is
deliberate — the model selects on the tool name, so the tool name carries the
domain and the server name carries the brand.

| Tool | Job |
|---|---|
| `mandarin_lookup` | Words you already have → full flashcard records |
| `mandarin_find_words` | Select a word set by level, frequency, topic, or pack |
| `mandarin_find_sentences` | Select sentences by content, pattern, difficulty, or i+1 |
| `mandarin_audio` | Fetch or existence-check a recording |
| `mandarin_build_deck` | Turn a word set into an import-ready deck |
| `mandarin_packs` | List the computed packs |

Everything is read-only, keyless, and deterministic within a release. Nothing
writes, bills, or synthesises audio on demand.

## What to reach for first

- **Changing what words are in a pack?** `src/build/packs.ts`. Membership is
  always a deterministic query over the canon — never a hand-written or
  model-written list. If you cannot express the membership as a query over
  canon columns, the pack is deferred, not fabricated.
- **Changing the pack file format?** `src/build/pack-schema.ts` first, then
  `evals/contract.ts`, then the README data dictionary. All three or none.
- **Changing what the canon contains?** `src/build/canon.ts`, and expect the
  band-count assertion in `evals/contract.ts` to fail if you have changed the
  source list. That failure is the feature.
- **Adding a source?** `NOTICE` in the same commit, with the attribution text
  that source's licence requires. A source added without its notice is a
  licence violation shipped to every downstream user.

## Hard constraints

1. **No audio URLs while status is `pending`.** Every audio field in the canon
   currently reports `status: "pending"` and carries `null` for both voices.
   Emitting a URL for a clip that is not hosted produces a 404 inside somebody
   else's flashcard review. The contract eval fails the build if any record
   emits a URL while its status is pending. Do not "helpfully" fill these in.
2. **The build is reproducible.** No `Date.now()`, no `Math.random()`, no
   `localeCompare` (host ICU data varies), no network reads at build time. Two
   builds of the same source must be byte-identical, because every pack digest
   is a promise that a third party can re-derive the same list.
3. **Never silently coerce an out-of-range input.** Clamping `level: 99` to `6`
   and returning HTTP 200 makes an agent report HSK-99 data to a user. Error
   instead, and name the legal range.
4. **Errors name the next call.** An error an agent cannot act on is a dead
   end. `No pack "hsk7". Did you mean "hsk-2026-t7"? Next: mandarin_packs(...)`.
5. **Strict TypeScript, ESM, Node builtins only** in `evals/`. `noUncheckedIndexedAccess`
   is on, so index reads are `T | undefined` — handle it, do not `!` it away.
6. **Do not add dependencies casually.** Two runtime deps today. Every added
   dep is a supply-chain surface on a package other people install.

## What is out of scope

Do not add: an Anki-writing tool (compose with `anki-mcp`, do not compete), a
paid API tier, base64 audio in MCP responses (~19,000 tokens per clip against
~15 for a URL), or a seventh MCP tool without deleting one.

## Not a discovery surface

This file instructs coding agents working **inside a checkout** — contributors.
It is not how a consuming agent discovers the API. That is `server/discover`'s
`instructions` string and the six tool descriptions. Do not duplicate API
documentation here; it will drift, and nothing reads it.
