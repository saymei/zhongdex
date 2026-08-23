# Zhongdex

**A free, openly-licensed Mandarin word-and-sentence corpus, published as a
dataset, an MCP server, and — in time — Yomitan dictionaries and Anki decks.**

The thing being built, in one sentence: *every HSK 3.0 (2026) word, with pinyin,
glosses, three difficulty-graded example sentences, and real audio in both a
male and a female voice — free, no key, and it works in Yomitan, Anki, Pleco,
and your agent.*

That sentence describes the finished project. **This is v0.1.** Read the next
section before you build anything on top of it.

---

## Status: what is actually here, and what is not

Zhongdex's whole positioning is that it does not fake numbers. So:

### Real, built, and usable today

| | |
|---|---|
| **The word canon** | Built from a pinned HSK 3.0 (2026) source list — **11,092 headwords**, split 500 / 772 / 973 / 1,000 / 1,071 / 1,140 / 5,636 across bands 1–6 and the combined 7–9 band. Simplified, traditional, tone-marked and numbered pinyin, part of speech, glosses, and the upstream row id on every record, plus **all three HSK band columns** (2026, 2021, 2.0) and frequency rank / Zipf where the enrichment pass could match the headword. |
| **The packs** | **28 computed card packs** over that canon, 63,972 word slots: 12 HSK band and cumulative packs, 5 frequency "Core" tiers, 10 part-of-speech packs, and the 2021→2026 delta. Nothing is deferred in this build. Every pack's membership is a deterministic query, every pack carries a `digest` you can recompute, and every pack claiming a level is verified band-closed at that level. No pack's word list was written by a human or a model. |
| **The build** | `npm run build`. Reproducible: no clock, no randomness, no network. Two builds of the same source are byte-identical — verified, not asserted. |
| **The MCP server** | Runs locally over stdio. Six read-only tools. |
| **The contract eval** | `npm run eval:contract`. Nine checks, no LLM, no network, ~130 ms, and it fails the build on any of the guarantees above. |

### Not shipped. Do not plan around these.

> ### ⚠ Audio is not hosted yet.
>
> Every audio field in every record reports `status: "pending"` and carries
> `null` for both voices. **No audio URL is emitted anywhere in this release**,
> and the contract eval fails the build if one ever is.
>
> The recordings exist — roughly 444,000 clips in SayMei's archive — but they
> are not published, not hosted, and not addressable. A URL for a clip nobody
> can fetch is a 404 inside somebody else's flashcard review, which is worse
> than an honest null. So there are no URLs.
>
> If you are here for the audio, star the repo and come back. It is the top of
> the roadmap, and it is not in this release.

Also not shipped: **example sentences** (the canon is words only in v0.1, so
`mandarin_find_sentences` has an empty corpus to search), the **Yomitan
packs**, the **Anki decks**, the **Pleco export**, and the **hosted API and
remote MCP endpoint**. See [Roadmap](#roadmap).

One number to be careful with: different vintages of the HSK 3.0 word list
circulate, with totals from ~10,057 to ~11,000+. **11,092 is what the pinned
snapshot in `scripts/hsk30.csv` actually contains**, and the contract eval
asserts that split exactly, so an upstream refresh fails CI rather than
silently changing the corpus under everyone downstream.

---

## Install and use

Node 22 or newer.

```bash
git clone https://github.com/saymei/zhongdex.git
cd zhongdex
npm ci
npm run build          # writes data/
```

`data/` is produced by the build; it is not hand-maintained. The build takes a
few seconds, is fully deterministic, and makes no network calls.

Both inputs are vendored in the repo — the pinned HSK word list at
`scripts/hsk30.csv` and a CC-CEDICT dump at `scripts/cedict.json` — and both
paths resolve relative to the repo root, so a clean clone builds unaided and CI
builds the same bytes. `data/canon-stats.json` records the SHA-256 of each
input on every build.

### The dataset files

After `npm run build`:

```
data/hsk_bands.json      the word canon — a JSON array of word records
data/hsk_bands.csv       the same canon, flat, for spreadsheets and deck tools
                         (columns: id, simplified, traditional, pinyin_marked,
                         pinyin_numbered, pos, hsk_band_2026, hsk_band_range,
                         hsk_band_2021, hsk_band_2_0, hsk_list_id,
                         definition_count, definitions, source_ids,
                         frequency_rank, zipf, audio_female_available,
                         audio_male_available, audio_status, enriched_via)
data/canon-stats.json    build receipt: input paths, SHA-256 of every input,
                         row counts in/out/dropped, and the band histogram
data/packs/*.json        one file per pack
data/packs/index.json    the pack catalogue
data/pack-stats.json     per-pack sizes, digests, closure and coverage,
                         plus every pack that was DEFERRED and why
```

Read them with anything. They are plain JSON, UTF-8, LF, and stable across
builds.

```bash
# the canon is a JSON array of word records
jq 'length' data/hsk_bands.json                      # 11092
jq '[.[] | select(.hsk.band2026 == 1)] | length' data/hsk_bands.json   # 500

# what packs exist
jq -r '.packs[] | "\(.slug)\t\(.size)\t\(.title)"' data/packs/index.json

# anything deferred, and why (empty in this build)
jq -r '.deferred[] | "\(.slug): \(.reason)"' data/pack-stats.json
```

`pack-stats.json` deserves a special mention: a pack whose query needs a canon
column that does not exist yet is **deferred with a stated reason**, not
fabricated to fill the slot, and that list is part of the deliverable. It is
empty in this build — every declared pack now has the columns it needs — but
the mechanism is what keeps it empty honestly.

### The MCP server

**Today the server runs locally over stdio.** The remote endpoint is on the
roadmap and is not live — there is nothing to point a URL at yet.

Add it to any MCP client that reads a JSON config (Claude Desktop, Cursor,
VS Code, Zed):

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

Or from a shell, for Claude Code:

```bash
claude mcp add zhongdex -- npx tsx /absolute/path/to/zhongdex/src/mcp/server.ts
```

Run `npm run build` first — the server reads `data/`.

Server name `zhongdex`; tools prefixed `mandarin_`. The split is deliberate: a
model selects on the *tool* name, so the tool name carries the domain and the
server name carries the brand.

| Tool | Job |
|---|---|
| `mandarin_lookup` | Words you already have → full records |
| `mandarin_find_words` | Select a word set by level, frequency, pack, or query |
| `mandarin_find_sentences` | Select sentences by content, pattern, or difficulty |
| `mandarin_audio` | Fetch or existence-check a recording |
| `mandarin_build_deck` | Turn a word set into an import-ready deck |
| `mandarin_packs` | List the computed packs |

All six are read-only, keyless, unmetered, and deterministic within a release.
Nothing writes, bills, or synthesises audio on demand. Tools whose output
depends on data this release does not carry — sentences, audio URLs — say so
in their response rather than inventing a value.

### The build and the checks

```bash
npm run typecheck        # tsc --noEmit
npm run build            # build:canon then build:packs
npm run eval:contract    # Tier 0 contract eval
```

Those three plus `npm ci` are exactly what CI runs, on Node 22. Nothing else.

---

## Data dictionary

### Word record — `data/hsk_bands.json`

A top-level JSON array of these:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable, human-readable, never a UUID: `dex:w:<numbered pinyin>:<simplified>:<primary POS>`, e.g. `dex:w:yi1:一:num`. Unique across the canon; the contract eval asserts no collisions and one namespace. |
| `simplified` | `string` | Simplified headword. |
| `traditional` | `string` | Traditional headword. Equal to `simplified` where the forms do not differ. |
| `pinyin.marked` | `string` | Tone-marked: `nǐ hǎo`. |
| `pinyin.numbered` | `string` | Numbered, space-separated, 5 = neutral: `ni3 hao3`. |
| `pos` | `string[]` | Part-of-speech tags from the HSK source list (`N`, `V`, `Adj`, …). Slash-joined upstream tags such as `V/N` mean the word is both. |
| `hsk.band2026` | `number` | HSK 3.0 (2026) band, 1–7. The differentiator. |
| `hsk.bandRange` | `string` | The source list's own label for the band. `"1"`…`"6"`, and `"7-9"` for the combined band. |
| `hsk.band2021` | `number \| null` | HSK 3.0 (2021 revision) band. Set on **10,786 of 11,092** records. `null` means "no 2021 band", which is *not* the same as "we did not look" — see `enrichedVia`. |
| `hsk.band2_0` | `number \| null` | HSK 2.0 (legacy) band, 1–6. Set on **4,442** records; `null` on the rest, which are simply not on the old list. |
| `hsk.listId` | `string` | The row id in the pinned source list (`L1-0427`), so any band assignment traces back to its upstream line. |
| `frequency.rank` | `number \| null` | Corpus frequency rank, 1 = most frequent. Set on **11,029 of 11,092** (99.4%). |
| `frequency.zipf` | `number \| null` | Zipf score for the same headword. |
| `frequencyRank` / `zipf` | `number \| null` | Flat mirrors of the two fields above, for CSV parity and for consumers that do not want to walk into a nested object. Always equal to their `frequency.*` counterparts. |
| `enrichedVia` | `"reading" \| "form" \| null` | **How this record was matched against the production corpus, and the field that tells you whether a `null` elsewhere means "absent" or "unknown".** `"reading"` (11,011) matched on hanzi + reading; `"form"` (31) matched on written form alone; **`null` (50) means no match was found at all** — for those 50 records every enriched column is `null` because nothing was looked up, not because the answer is "none". |
| `definitions` | `object[]` | Glosses, each `{text, source, sourceKey, license}`. The per-gloss `source` and `license` travel with the gloss so attribution cannot be separated from the text it covers. Terse, because CC-CEDICT is terse. |
| `sourceIds` | `string[]` | Every upstream row this record was built from, namespaced: `hsk30:L1-0427`, `cc-cedict:一|一[yi1]`. |
| `audio.female` / `audio.male` | `{available, hosted}` | **Availability, not a location.** `available` says a recording exists in SayMei's archive; `hosted` says it is fetchable. **`hosted` is `false` on every record in this release**, and there is no URL field. Female `available` is true on 11,040 records; male on **0** — the male voice has not been recorded for this word set. |
| `audio.status` | `string` | One of `available-unhosted` (11,040), `unknown` (50), `none` (2). Note `unknown` ≠ `none`: `unknown` is the 50 unmatched records, `none` is a genuine confirmed absence. |

Reserved but **not** populated in v0.1: `radical`. Absent rather than
null-filled.

> The contract eval asserts, unconditionally and regardless of status, that
> **no record and no pack emits an audio URL and nothing reports `hosted: true`**.
> It also pins the set of legal `audio.status` values, so renaming a status
> fails CI instead of quietly hollowing the check out.

### Pack record — `data/packs/<slug>.json`

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"pack-v1"` | |
| `id` / `slug` | `string` | `dex:p:<slug>` and `<slug>`. Namespaced, kebab-case, **never reused** — a retired pack keeps its id. |
| `kind` | `"band" \| "frequency" \| "pos" \| "delta"` | 12 band, 5 frequency, 10 pos, 1 delta. |
| `itemType` | `"word"` | Sentence packs are a later tranche. |
| `title` / `oneLiner` / `description` / `rationale` | `string` | Prose. Hand-written build metadata in this tranche; no model writes any of it. |
| `level` | `{scheme, band, bandRange, cumulative}` | `band: null` means the pack makes **no level claim** — a pack that spans the corpus is not "band 1 with exceptions". |
| `size` | `number` | Must equal `words.length`. Asserted. |
| `words` | `string[]` | **Canon word ids only, ascending.** A pack never duplicates word data, so a pack can never drift from the canon. Every id must resolve; asserted. |
| `digest` | `string` | `sha256:` + SHA-256 over the sorted id list, newline-joined. **Recompute it yourself** — that is the point. Asserted on every build. |
| `selection` | `{query, order, deterministic, seedSource}` | The reproducibility contract: the literal query that produced `words[]`. |
| `exclusions` | `{reason, count}[]` | Words the query matched but the pack deliberately dropped, each with a stated reason and a count. Usually empty. **This is where a pack admits what it is not claiming** — see the delta pack below. |
| `bandClosure` | `{scheme, claim, claimedMin/MaxBand, observedMin/MaxBand, overBand, underBand, offList, closed}` | **Measured, not asserted.** `claim` is `"band-closed"` or `"spans-bands"`; `closed` is a boolean under the first and `null` under the second, so a pack that spans bands cannot accidentally read as closed. A pack that names a `level.band` must claim `"band-closed"` and be it. |
| `provenance` | `{words, columns, rule, curationSource, corpus, bands, definitions, audio, copy}` | `words` is `computed` or `computed+curated`; `copy` records who or what wrote the prose. |
| `audioCompleteness` | `{female, male, femaleAvailableUnhosted, maleAvailableUnhosted, unknown, status}` | `female`/`male` are the fractions actually **playable**, and both are `0` in every pack because nothing is hosted. `*AvailableUnhosted` is the fraction that exists in the archive but cannot be fetched, and `unknown` is the fraction whose availability could not be determined. **`status` is `"pending"` in every pack**, and the contract eval requires it to stay that way until audio ships. |
| `coverage` | `{bandLabelled, band2021Labelled, posLabelled, defined, frequencyRanked, senseDisambiguated}` | Fractions, measured, not asserted. `senseDisambiguated` is `0` throughout v0.1 — the canon carries no sense index yet — and is reported as zero rather than omitted. |
| `version` / `corpusVersion` | `string` | CalVer. `version` bumps **only** when `words[]` changes. |
| `licence` | `{data, attribution}` | CC BY-SA 4.0 and the attribution line to reproduce. Travels inside every pack file so it cannot be separated from the data. |

### `hsk-2026-delta`, and why `enrichedVia` matters

The delta pack answers "what changed between the 2021 and 2026 syllabus". Its
query is `hsk_2026 != hsk_2021`, which means **a missing 2021 band counts as a
change** — most of the pack is in it because `hsk.band2021` is `null`, not
because a band demonstrably moved.

That is only sound if `null` reliably means "not on the 2021 list". It does
not, quite: 50 canon records never matched the enrichment snapshot at all
(`enrichedVia: null`), and on those records every enriched column is `null`
because **nothing was looked up**, not because the answer is "none". Counting
them as "new in 2026" would be asserting something nobody checked.

So the pack drops them. It ships **324 words**, and the 50 are recorded in its
`exclusions` array with the reason, rather than silently absent:

```bash
jq '.size, .exclusions' data/packs/hsk-2026-delta.json
# 324
# [{"reason":"2021 band is unknown, not absent: the record did not join the
#             enrichment snapshot (enrichedVia === null), so it cannot be
#             shown to be new in 2026","count":50}]
```

The general rule, which applies well beyond this one pack: **`enrichedVia` is
how you tell "absent" from "unknown"** anywhere in the canon. A `null` band or
a `null` frequency on a record with `enrichedVia: "reading"` or `"form"` is a
real absence. The same `null` on one of the 50 unmatched records is a gap in
our knowledge. Treat them differently, because the corpus does.

---

## Licensing

Two licences, deliberately split, so copyleft never touches product code.

**Code — MIT.** `src/`, `scripts/`, `evals/`. See [`LICENSE`](LICENSE). One
exception inside `scripts/`: `scripts/cedict.json` is a verbatim, unmodified
CC-CEDICT dump redistributed under CC BY-SA 4.0, not MIT — sitting next to the
build scripts does not change its licence. [`NOTICE`](NOTICE) §1a states its
terms and distinguishes that verbatim redistribution from the derived canon.

**Data — CC BY-SA 4.0.** Everything under `data/`, and every artifact built
from it: packs, exports, dictionary files, decks, API responses, MCP tool
responses. See [`data/LICENSE`](data/LICENSE) and [`NOTICE`](NOTICE).

This is not a stylistic choice. Every gloss in the v0.1 canon comes from
**CC-CEDICT**, which is CC BY-SA 4.0. ShareAlike propagates through the merge,
and CC's §4 sui generis database rights make a database containing a
substantial portion of CC-CEDICT itself Adapted Material. BY-SA is the only
licence this corpus can carry. Jitendex is CC BY-SA 4.0 for the same reason.
(Wiktionary senses and Tatoeba sentences are planned; both are copyleft or
attribution-required, so neither changes the outcome.)

### If you redistribute the data, you must

1. **Credit.** Reproduce this line, which matches what v0.1 actually contains:

   > Zhongdex by SayMei — https://zhongdex.org — CC BY-SA 4.0. Contains data
   > from CC-CEDICT (CC BY-SA 4.0) and the HSK 3.0 (2026) word list.

   Later releases add sources; [`NOTICE`](NOTICE) is always the current list,
   and each record carries its own `sourceIds` and per-gloss `license` so you
   never have to guess which source a given string came from.

2. **Link the licence** and **say what you changed.**

3. **Keep per-record attribution.** Do not strip `sourceIds` or the per-gloss
   `source` / `license` fields when you transform the data. When sentence
   records ship, Tatoeba-derived rows will carry their upstream id in the same
   way, and that field *is* the attribution for those rows.

4. **ShareAlike.** Your derivative must be CC BY-SA 4.0 or a compatible
   ShareAlike licence. **MIT and Apache-2.0 are not on Creative Commons'
   compatible list** — you cannot relicense this data under them.

5. Note that BY-SA defines "Share" as making material available such that the
   public may access it at a time individually chosen by them. That covers an
   **HTTP API and an MCP server**, not only a download.

Full per-source attribution text is in [`NOTICE`](NOTICE). Adding a source
without adding its notice in the same commit is a licence violation shipped to
every downstream user.

Trademarks are not licensed. Say your work is *built from* Zhongdex data; do
not present it as published by SayMei.

### One open licensing item, stated rather than buried

The vendored HSK word list at `scripts/hsk30.csv` carries no upstream header,
no licence text and no commit reference, so this repository **cannot currently
name its provenance with confidence**. The intent is to pin
[`drkameleon/complete-hsk-vocabulary`](https://github.com/drkameleon/complete-hsk-vocabulary)
(MIT) at a specific commit; that has not been done, and the vendored file's
format does not match that project's published one. Details and the required
follow-up are in [`NOTICE`](NOTICE) §4. If you are redistributing the band
data, that is the one input whose terms are not yet settled.

---

## Roadmap

Everything in this section is **not yet shipped**. It is listed so you can see
the shape of the project, not so you can depend on it. No dates.

- [ ] **Audio, hosted, in both voices.** Amy (female) and James (male), natural
      and 0.7× speed, referenced by constructible URL and never bundled. This
      is the single largest gap between v0.1 and the pitch at the top of this
      file, and it is the top priority.
- [ ] **Example sentences.** Three difficulty-graded sentences per headword,
      with a computed difficulty grade, band closure, and a `newWordCount`
      filter for true i+1 selection.
- [ ] **Yomitan packs** — terms, frequency, and pronunciation. The frequency
      and pronunciation packs would be the first of their kind for Mandarin;
      Yomitan's own recommended-dictionaries list has both slots empty today.
- [ ] **Anki decks**, per band, with audio bundled and a permissive card
      template.
- [ ] **Hosted API and remote MCP endpoint** — static, keyless, no origin.
- [ ] **Pleco export.**
- [ ] **A `radical` column**, the last reserved canon field with no data behind
      it, and the one a high-yield-radicals pack would need.
- [ ] **Resolving the 50 unmatched records** (`enrichedVia: null`), which is
      what would let the delta pack stop excluding them.
- [ ] **A published eval table** — pass rate, tokens per task, recovery rate —
      regenerated on every release.

**What we are deliberately not building:** an Anki-writing MCP server (compose
with `anki-mcp`, do not compete with it), a paid API tier, base64 audio in MCP
responses, or bundled audio in the dataset.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). If you are a coding agent working in
a checkout, read [`AGENTS.md`](AGENTS.md) first.

The short version: pack membership is always a deterministic query, never an
authored list; the build stays reproducible; no audio URL ships while audio is
pending; and a schema change moves `evals/contract.ts` in the same commit.
