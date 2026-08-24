# Zhongdex

[![CI](https://github.com/saymei/zhongdex/actions/workflows/ci.yml/badge.svg)](https://github.com/saymei/zhongdex/actions/workflows/ci.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Data: CC BY-SA 4.0](https://img.shields.io/badge/data-CC%20BY--SA%204.0-blue.svg)](data/LICENSE)

Every word of the HSK 3.0 (2026) syllabus — pinyin, glosses, official bands, frequency
ranks and difficulty-graded example sentences — packaged for the tools people actually
study in.

Import it into **Yomitan** or **Anki**, read it as plain JSON, or hand it to an agent over
**MCP**. Free, keyless, unmetered, and rebuilt from pinned sources on every commit.

Zhongdex is built for two kinds of user: people who make flashcards and decks, and agents
that need Mandarin data without an API key.

## Highlights

- **11,092 headwords** — the complete HSK 3.0 (2026) list, split 500 / 772 / 973 / 1,000 /
  1,071 / 1,140 / 5,636 across bands 1–6 and the combined 7–9 band.
- **32,725 graded example sentences** over 99.82% of headwords, each with a computed
  difficulty grade, tone-marked and numbered pinyin, an English translation, and a
  `newWordCount` vector that makes true i+1 selection a filter rather than a guess.
- **Three syllabus columns on every record** — 2026, the 2021 revision (97.24%), and legacy
  HSK 2.0 — plus corpus frequency rank and Zipf score (99.43%). 99.55% of the canon carries
  this enrichment, and every record says how it was matched.
- **28 computed packs, 63,972 word slots.** Membership is a deterministic query, never an
  authored list, and every pack ships a SHA-256 digest you can recompute yourself.
- **Three Yomitan dictionaries** — terms, frequency and pronunciation.
- **Eight Anki decks**, one per band plus a complete deck, import-verified against Anki
  25.09.5.
- **A six-tool MCP server** over stdio: read-only, keyless, unmetered, and rendered to fit
  inside an agent's context rather than fill it.
- **A reproducible build.** No clock, no randomness, no network. Two builds of the same
  source are byte-identical, and a nine-check contract eval runs in CI on every push.
- **MIT code, CC BY-SA 4.0 data**, with per-gloss attribution that travels inside every
  record.

## Quickstart

Node 22 or newer.

```bash
git clone https://github.com/saymei/zhongdex.git
cd zhongdex
npm ci
```

The dataset is committed, so it is readable the moment the clone finishes. `npm run build`
re-derives the canon and the packs from the pinned sources in a few seconds, offline.

### The dataset

```bash
jq 'length' data/hsk_bands.json                                        # 11092
jq '[.[] | select(.hsk.band2026 == 1)] | length' data/hsk_bands.json   # 500
jq -r '.packs[] | "\(.slug)\t\(.size)"' data/packs/index.json          # the 28 packs
head -1 data/sentences.jsonl | jq .                                    # one graded sentence
```

| File | What it is |
|---|---|
| `data/hsk_bands.json` | The word canon — a JSON array of 11,092 word records |
| `data/hsk_bands.csv` | The same canon, flat, for spreadsheets and deck tools |
| `data/sentences.jsonl` | 32,725 graded sentences, one JSON record per line |
| `data/packs/*.json` | One file per pack, plus `index.json`, the catalogue |
| `data/canon-stats.json` | Build receipt: every input path, its SHA-256, rows in/out/dropped |
| `data/pack-stats.json` | Per-pack sizes, digests, band closure and coverage |
| `data/sentence-stats.json` | Grade distribution, selection rules, every drop reason and count |

Plain JSON, UTF-8, LF, stable across builds. Read them with anything.

### Yomitan

```bash
npm run export:yomitan     # writes dist/yomitan/
```

In Yomitan, open **Settings → Dictionaries** and import each `.zip`.

| Dictionary | Entries | What it adds |
|---|---|---|
| `Zhongdex-Terms.zip` | 17,522 | Glosses, both pinyin forms, and the official 2026 band |
| `Zhongdex-Frequency.zip` | 17,313 | Corpus frequency, as a rank-based frequency dictionary |
| `Zhongdex-Pronunciation.zip` | 17,418 | Tone-marked and numbered pinyin through Yomitan's phonetic channel |

Readings follow the CC-CEDICT for Yomitan convention, so the pronunciation entries attach
to that dictionary as well as to ours.

### Anki

```bash
npm run export:anki        # writes dist/anki/
```

Then **File → Import** in Anki. Eight decks, one note per word, on a purpose-built
`Zhongdex Word (HSK 3.0 2026)` note type with eight fields:

| Deck | Notes |
|---|---|
| `Zhongdex-HSK-2026-t1.apkg` | 500 |
| `Zhongdex-HSK-2026-t2.apkg` | 772 |
| `Zhongdex-HSK-2026-t3.apkg` | 973 |
| `Zhongdex-HSK-2026-t4.apkg` | 1,000 |
| `Zhongdex-HSK-2026-t5.apkg` | 1,071 |
| `Zhongdex-HSK-2026-t6.apkg` | 1,140 |
| `Zhongdex-HSK-2026-t7-9.apkg` | 5,636 |
| `Zhongdex-HSK-2026-Complete.apkg` | 11,092, as seven subdecks |

Every deck is handed to Anki's own importer before release: 22,184 notes across the eight
files, zero conflicts and zero duplicates on Anki 25.09.5.

### The MCP server

```bash
npm run build   # the server reads data/
claude mcp add zhongdex -- npx tsx /absolute/path/to/zhongdex/src/mcp/server.ts
```

Or, for any client that reads a JSON config — Claude Desktop, Cursor, VS Code, Zed:

```json
{
  "mcpServers": {
    "zhongdex": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/zhongdex"
    }
  }
}
```

Server name `zhongdex`; tools prefixed `mandarin_`. The split is deliberate — a model
selects on the *tool* name, so the tool name carries the domain and the server name carries
the brand.

| Tool | Job |
|---|---|
| `mandarin_lookup` | Words you already have → full records |
| `mandarin_find_words` | Select a word set by level, frequency, pack, or query |
| `mandarin_find_sentences` | Select sentences by content, pattern, or difficulty |
| `mandarin_audio` | Check the recording archive for a word, sentence, or pinyin syllable |
| `mandarin_build_deck` | Turn a word set into an import-ready deck |
| `mandarin_packs` | List the computed packs |

Responses are markdown, not JSON, and every tool renders under a 10,000-token ceiling —
above that Claude Code warns, and a tool that reliably warns gets switched off. A complete
record for 苹果 — gloss, both pinyin forms, all three syllabus bands, frequency, classifier,
traditional form and two graded sentences — comes back in 558 bytes. All six tools are
read-only, keyless and deterministic within a release. An out-of-range argument returns an
error naming the legal range; nothing is silently clamped.

### Build a deck without installing anything

For a custom word list, you do not need this checkout at all:

1. **Fork** this repository.
2. Edit `my-list.yaml` — start from packs, add your own words, exclude what you know,
   choose the card fields. It is one commented file and nothing else needs touching.
3. Commit. GitHub Actions compiles the deck and attaches `deck.csv` — plus `deck.tsv` or
   `deck.jsonl` if you ask for them — and a `RESOLVED.md` showing what every line matched.

A word that does not resolve stops the build and lists its near-misses. A deck that is
quietly missing what you asked for is worse than a build that told you.

## The data

### Word record — `data/hsk_bands.json`

```json
{
  "id": "dex:w:ping2guo3:苹果:n",
  "simplified": "苹果",
  "traditional": "蘋果",
  "pinyin": { "marked": "píngguǒ", "numbered": "ping2 guo3" },
  "pos": ["N"],
  "hsk": { "band2026": 3, "bandRange": "3", "band2021": 3, "band2_0": 1, "listId": "L3-0539" },
  "definitions": [
    { "text": "apple", "source": "cc-cedict", "sourceKey": "蘋果|苹果[ping2 guo3]", "license": "CC-BY-SA-4.0" }
  ],
  "sourceIds": ["hsk30:L3-0539", "cc-cedict:蘋果|苹果[ping2 guo3]"],
  "frequency": { "rank": 1744, "zipf": 5 },
  "audio": { "female": { "available": true, "hosted": false }, "male": { "available": false, "hosted": false }, "status": "available-unhosted" },
  "enrichedVia": "reading"
}
```

| Field | Notes |
|---|---|
| `id` | Stable and human-readable, never a UUID: `dex:w:<numbered pinyin>:<simplified>:<primary POS>`. Unique across the canon, and asserted so. |
| `simplified` / `traditional` | Equal where the forms do not differ. |
| `pinyin.marked` / `.numbered` | `nǐ hǎo` and `ni3 hao3`; 5 is neutral tone. |
| `pos` | Part-of-speech tags from the source list. A slash-joined tag such as `V/N` means the word is both. |
| `hsk.band2026` | The official 2026 band, 1–7. The differentiator. |
| `hsk.bandRange` | The source list's own label: `"1"`…`"6"`, and `"7-9"` for the combined band. |
| `hsk.band2021` | The 2021 revision's band, on 10,786 records. |
| `hsk.band2_0` | Legacy HSK 2.0 band, on the 4,442 words that were also on the old list. |
| `hsk.listId` | The row id in the pinned source list, so every band traces back to its upstream line. |
| `frequency.rank` / `.zipf` | Corpus frequency, 1 = most frequent, on 11,029 records. Mirrored flat as `frequencyRank` / `zipf` for CSV parity. |
| `definitions` | 30,899 CC-CEDICT glosses, each carrying its own `source`, `sourceKey` and `license`, so attribution cannot be separated from the text it covers. |
| `sourceIds` | Every upstream row this record was built from, namespaced. |
| `enrichedVia` | `"reading"` (11,011) matched on hanzi plus reading, `"form"` (31) on the written form. This is the field that tells you whether a `null` elsewhere is an absence or an unknown. |
| `audio` | Availability per voice, plus `status`. Clip hosting is on the roadmap; today this field reports what exists upstream and emits no URL. |

### Sentence record — `data/sentences.jsonl`

One JSON object per line, sorted by id. Up to three sentences per headword, chosen to span
easy / at-level / stretch; 11,068 headwords carry a full triad.

| Field | Notes |
|---|---|
| `hanzi` / `pinyin` / `pinyinNumbered` / `english` | The sentence, in four parallel forms. |
| `zsg` | Zhongdex Sentence Grade, 1–7: the highest band of any content token after segmentation. Computed from the canon, not copied from upstream and not written by a model. |
| `newWordCount` | Per band prefix 1..7, how many distinct token forms fall outside it. A value of 1 is an i+1 sentence. |
| `words` | The segmentation, so you can check the grade rather than trust it. |
| `beyondHskTokens` | How many tokens fall outside HSK 3.0 entirely — the ones that force a grade of 7. |
| `charLengthPercentile` | Where the sentence sits for length against every graded sentence in its own band. |
| `headwords` | Which canon words this sentence is filed under, with the band and the triad slot it fills. |

32,725 sentences were selected out of 137,541 graded candidates. The source rows carry
their own HSK level; it is never used as an input, only compared against the computed grade
as a check.

### Packs — `data/packs/`

A pack is a named word set: 12 band and cumulative packs, 5 frequency tiers, 10
part-of-speech packs, and the 2021→2026 delta. Packs hold canon word **ids** only, never
copies of word data, so a pack cannot drift from the canon.

```bash
jq '.digest, .selection.query, .size' data/packs/hsk-2026-t1.json
```

Every pack carries the literal query that produced it and a `digest` over its sorted id
list. Recompute the digest yourself — that is the point of publishing it. Ten packs claim a
level, and all ten are verified band-closed at that level on every build. `bandClosure` is
measured, not asserted: a pack that spans bands reports `"spans-bands"` and cannot
accidentally read as closed.

The delta pack is the interesting one. Its query is
`hsk_2026 != hsk_2021 && enriched_via != null`, and that second clause is the whole point.
A missing 2021 band counts as a change, which is only sound where `null` means "not on the
2021 list". On 50 records the enrichment snapshot found no match at all, so `null` there
means "not looked up". Those 50 are excluded, and the exclusion ships in the file with its
reason:

```bash
jq '.size, .exclusions' data/packs/hsk-2026-delta.json
```

## Build and verify

```bash
npm run typecheck        # tsc --noEmit
npm run build            # canon, then packs
npm run eval:contract    # Tier 0 contract eval
```

Those three plus `npm ci` are exactly what CI runs, on Node 22. Both build inputs are
vendored — the pinned HSK list at `scripts/hsk30.csv` and a CC-CEDICT dump at
`scripts/cedict.json` — so a clean clone builds unaided and `data/canon-stats.json` records
the SHA-256 of each input on every run.

The contract eval is nine checks, no LLM, no network, and it finishes in about 130 ms:

```
  PASS  C1 canon ids  11092 records, all ids well-formed and unique
  PASS  C1b id namespace  every id is in one namespace: "dex"
  PASS  C2 band counts  11092 words split 500 / 772 / 973 / 1000 / 1071 / 1140 / 5636
  PASS  C3 no audio URLs  0 URLs and 0 hosted claims across 11092 records and 28 packs
  PASS  C4 pack structure  28 packs, 63972 word slots
  PASS  C5 pack references  every pack word id resolves in the canon
  PASS  C6 pack digests  28 digests recomputed from words[]
  PASS  C7 band closure  10 level-claiming packs, all closed
  PASS  C8 catalogue  index.json and pack-stats.json agree with all 28 pack files
```

C2 is the one that earns its keep. It pins the band split exactly, so an upstream refresh
that would change the corpus fails CI rather than moving it underneath everyone downstream.
11,092 is what the pinned snapshot in `scripts/hsk30.csv` contains, and `data/canon-stats.json`
carries its SHA-256 so you can tell which snapshot you have.

Optional, for maintainers: `npm run enrich:fetch` and `npm run build:sentences` re-read
SayMei's production dictionary and need `ZHONGDEX_SAYMEI_ROOT` pointing at a SayMei
checkout. Everything else builds from committed snapshots with no configuration at all.

## Roadmap

No dates. Ordered by what unlocks the most.

- **Hosted audio in two voices** — Amy and James, natural and 0.7× speed, addressed by
  constructible URL and never bundled into the dataset. The canon already carries
  per-record availability, so hosting fills in a field the schema is waiting for.
- **A hosted API and a remote MCP endpoint** — static, keyless, no origin, so an agent can
  reach the corpus without a checkout.
- **Pleco export**, alongside the Yomitan and Anki builds.
- **A `radical` column**, the reserved canon field a high-yield-radicals pack needs.
- **Resolving the 50 unmatched records**, which is what lets the delta pack stop excluding
  them and closes enrichment coverage at 100%.
- **A published eval table** — pass rate, tokens per task, recovery rate — regenerated on
  every release.

Deliberately out of scope: an Anki-writing MCP server (compose with `anki-mcp` rather than
compete with it), a paid API tier, base64 audio in MCP responses, and bundled audio in the
dataset.

## Licensing

Two licences, split so copyleft never touches product code.

- **Code — MIT.** `src/`, `scripts/`, `evals/`. See [`LICENSE`](LICENSE). One exception:
  `scripts/cedict.json` is a verbatim CC-CEDICT dump redistributed under CC BY-SA 4.0.
- **Data — CC BY-SA 4.0.** Everything under `data/`, and every artifact built from it:
  packs, exports, dictionaries, decks, API and MCP responses. See
  [`data/LICENSE`](data/LICENSE).

Every gloss in the canon comes from CC-CEDICT, which is CC BY-SA 4.0, and ShareAlike
propagates through the merge — so BY-SA is the only licence this corpus can carry. Jitendex
is CC BY-SA 4.0 for the same reason.

If you redistribute the data: credit it, link the licence, say what you changed, keep the
per-record `sourceIds` and per-gloss `license` fields intact, and license your derivative
under CC BY-SA 4.0 or a compatible ShareAlike licence. MIT and Apache-2.0 are not on
Creative Commons' compatible list. Note that BY-SA's definition of "Share" covers an HTTP
API and an MCP server, not only a download.

[`NOTICE`](NOTICE) carries the exact attribution text each source requires and is always the
current per-source list — §1b is the one to reproduce for anything derived from the canon.
Trademarks are not licensed: say your work is *built from* Zhongdex data.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Coding agents working in a checkout should read
[`AGENTS.md`](AGENTS.md) first.

The short version: pack membership is always a deterministic query, never an authored list;
the build stays reproducible; and a schema change moves `evals/contract.ts` in the same
commit.
