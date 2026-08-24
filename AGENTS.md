# AGENTS.md — orientation for coding agents

You are in `saymei/zhongdex`. Read this before editing. It covers everything you need; you
should not have to grep the tree to orient.

## What this repo is

An openly-licensed Mandarin corpus and the code that builds it. One build reads pinned
sources and emits a versioned word canon, a graded sentence corpus and a set of computed
card packs; separate exporters turn those into Yomitan dictionaries and Anki decks, and an
MCP server serves them to agents.

What is built today: 11,092 HSK 3.0 (2026) headwords, 32,725 graded sentences over 99.82%
of them, 28 computed packs (63,972 word slots, none deferred), 3 Yomitan dictionaries, 8
Anki decks, and 6 MCP tools. Audio hosting is the next tranche — see the README roadmap —
so no artifact emits an audio URL yet.

Two licences, deliberately split:

- **Code** (`src/`, `scripts/`, `evals/`) — MIT.
- **Data** (`data/`, and everything built from it) — **CC BY-SA 4.0**, forced by
  CC-CEDICT upstream (every gloss in the canon is CC-CEDICT). ShareAlike propagates:
  anything you build that contains a substantial portion of `data/` is also CC BY-SA 4.0.
  You cannot relicense it MIT. See `NOTICE` for the attribution each source requires —
  sections are marked IN THIS BUILD or NOT IN THIS BUILD, so do not credit a source the
  build does not read — and `data/LICENSE` for the terms.

## Commands

```
npm ci                  # install
npm run build           # build:canon then build:packs -> writes data/
npm run typecheck       # tsc --noEmit; must pass with zero errors
npm run eval:contract   # Tier 0 contract eval; no LLM, no network, ~130 ms
npm run mcp             # run the MCP server locally
npm run export:yomitan  # dist/yomitan/*.zip
npm run export:anki     # dist/anki/*.apkg
```

`data/` is committed, so a fresh clone can read the corpus, run the eval and start the MCP
server without building. `npm run build` re-derives the canon and the packs from
`scripts/`; it is offline, deterministic, and takes seconds.

Two maintainer-only refreshes read SayMei's production dictionary and need
`ZHONGDEX_SAYMEI_ROOT` set to a SayMei checkout — there is no default, and they fail with
instructions if it is missing:

```
ZHONGDEX_SAYMEI_ROOT=/path/to/SayMei-Web npm run enrich:fetch      # data/enrichment.json
ZHONGDEX_SAYMEI_ROOT=/path/to/SayMei-Web npm run build:sentences   # data/sentences.jsonl
```

Never add that variable to the normal build path. CI must be able to install with `npm ci`
and build with no Postgres driver available at all.

CI (`.github/workflows/ci.yml`) runs exactly: `npm ci`, `npm run typecheck`,
`npm run build`, `npm run eval:contract`, on Node 22. If those four pass locally, CI passes.

## Layout

```
scripts/hsk30.csv         pinned HSK 3.0 (2026) source list; 11,092 rows
scripts/cedict.json       vendored CC-CEDICT dump, VERBATIM. Never edit it:
                          it is a redistribution, and its sha256 is recorded
                          in data/canon-stats.json on every build.
src/build/canon.ts        builds the word canon into data/
src/build/db.ts           read-only production access; enrich:fetch only
src/build/grade.ts        the Zhongdex Sentence Grade and the segmenter
src/build/sentences.ts    builds the graded sentence corpus
src/build/pack-schema.ts  pack-v1 types, digest function, per-pack validator
src/build/packs.ts        builds the computed packs into data/
src/export/yomitan.ts     Yomitan terms / frequency / pronunciation dictionaries
src/export/anki.ts        .apkg decks, via node:sqlite
src/mcp/server.ts         the MCP server
evals/contract.ts         Tier 0 contract eval — nine checks
data/                     BUILD OUTPUT, committed. CC BY-SA 4.0. Do not hand-edit.
dist/                     export output, gitignored
```

## What the MCP server does

Server name `zhongdex`; tools prefixed `mandarin_`. The prefix split is deliberate — the
model selects on the tool name, so the tool name carries the domain and the server name
carries the brand.

| Tool | Job |
|---|---|
| `mandarin_lookup` | Words you already have → full flashcard records |
| `mandarin_find_words` | Select a word set by level, frequency, topic, or pack |
| `mandarin_find_sentences` | Select sentences by content, pattern, difficulty, or i+1 |
| `mandarin_audio` | Check the recording archive for a word, sentence, or pinyin syllable |
| `mandarin_build_deck` | Turn a word set into an import-ready deck |
| `mandarin_packs` | List the computed packs |

Everything is read-only, keyless, and deterministic within a release. Nothing writes, bills,
or synthesises audio on demand. Responses are markdown rendered under a 10,000-token
ceiling; `src/mcp/format.ts` holds the per-tool budgets.

## What to reach for first

- **Changing what words are in a pack?** `src/build/packs.ts`. Membership is always a
  deterministic query over the canon — never a hand-written or model-written list. If you
  cannot express the membership as a query over canon columns, the pack is deferred with a
  stated reason, not fabricated.
- **Changing the pack file format?** `src/build/pack-schema.ts` first, then
  `evals/contract.ts`, then the README data dictionary. All three or none.
- **Changing what the canon contains?** `src/build/canon.ts`, and expect the band-count
  assertion in `evals/contract.ts` to fail if you have changed the source list. That failure
  is the feature.
- **Changing how a sentence is graded?** `src/build/grade.ts`. The grade is computed from
  the canon and the sentence text alone: no model, and the source's own `hskLevel` is
  compared against the result, never used as an input.
- **Adding a source?** `NOTICE` in the same commit, with the attribution text that source's
  licence requires. A source added without its notice is a licence violation shipped to
  every downstream user.

## Hard constraints

1. **No audio URLs until clips are hosted.** Every audio field reports availability and a
   `status`, and emits no location. The contract eval fails the build on any URL or any
   `hosted: true`. Hosting is a roadmap item with its own migration plan
   (`data/audio-migration-plan.json`); until it lands, a constructed URL would 404 inside
   somebody else's flashcard review. Do not fill these in.
2. **The build is reproducible.** No `Date.now()`, no `Math.random()`, no `localeCompare`
   (host ICU data varies), no network reads at build time. Two builds of the same source
   must be byte-identical, because every pack digest is a promise that a third party can
   re-derive the same list.
3. **Never silently coerce an out-of-range input.** Clamping `level: 99` to `6` and
   returning success makes an agent report HSK-99 data to a user. Error instead, and name
   the legal range.
4. **Errors name the next call.** An error an agent cannot act on is a dead end.
   `No pack "hsk7". Did you mean "hsk-2026-t7"? Next: mandarin_packs(...)`.
5. **Strict TypeScript, ESM, Node builtins only** in `evals/`. `noUncheckedIndexedAccess`
   is on, so index reads are `T | undefined` — handle it, do not `!` it away.
6. **Do not add dependencies casually.** Two runtime deps today. Every added dep is a
   supply-chain surface on a package other people install.
7. **No local filesystem paths in source.** A machine-specific default leaks a maintainer's
   layout into a public repo. Read a named environment variable and fail with instructions.

## What is out of scope

Do not add: an Anki-writing tool (compose with `anki-mcp`, do not compete), a paid API tier,
base64 audio in MCP responses (~19,000 tokens per clip against ~15 for a URL), or a seventh
MCP tool without deleting one.

## Not a discovery surface

This file instructs coding agents working **inside a checkout** — contributors. It is not
how a consuming agent discovers the API. That is `server/discover`'s `instructions` string
and the six tool descriptions. Do not duplicate API documentation here; it will drift, and
nothing reads it.
