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
| **The word canon** | Built from a pinned HSK 3.0 (2026) source list — **11,092 headwords**, split 500 / 772 / 973 / 1,000 / 1,071 / 1,140 / 5,636 across bands 1–6 and the combined 7–9 band. Simplified, traditional, tone-marked and numbered pinyin, part of speech, band assignments, and glosses. |
| **The packs** | Computed card packs over that canon. Every pack's membership is a deterministic query, every pack carries a `digest` you can recompute, and every pack claiming a level is verified band-closed at that level. No pack's word list was written by a human or a model. |
| **The build** | `npm run build`. Reproducible: no clock, no randomness, no network. Two builds of the same source are byte-identical. |
| **The MCP server** | Runs locally over stdio. Six read-only tools. |
| **The contract eval** | `npm run eval:contract`. No LLM, no network, runs in about a second, and fails the build on any of the guarantees above. |

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

Also not shipped: **example sentences** (the canon is words only in v0.1), the
**Yomitan packs**, the **Anki decks**, the **Pleco export**, and the **hosted
API and remote MCP endpoint**. See [Roadmap](#roadmap).

---

## Install and use

Node 22 or newer.

```bash
git clone https://github.com/saymei/zhongdex.git
cd zhongdex
npm ci
npm run build          # writes data/
```

`data/` is a **build output**, not a committed source. A fresh clone has an
empty `data/` until you run the build. The build takes a few seconds and reads
only files already in the repo.

### The dataset files

After `npm run build`:

```
data/hsk_bands.json      the word canon
data/packs/*.json        one file per pack
data/packs/index.json    the pack catalogue
data/pack-stats.json     per-pack sizes, digests, closure and coverage,
                         plus every pack that was DEFERRED and why
```

Read them with anything. They are plain JSON, UTF-8, LF, and stable across
builds.

```bash
# every band-1 word
jq '[.words[] | select(.hsk.band2026 == 1)]' data/hsk_bands.json

# what packs exist
jq -r '.packs[] | "\(.slug)\t\(.size)\t\(.title)"' data/packs/index.json

# what was deferred, and what was missing
jq -r '.deferred[] | "\(.slug): \(.reason)"' data/pack-stats.json
```

`pack-stats.json` deserves a special mention: a pack whose query needs a canon
column that does not exist yet is **deferred with a stated reason**, not
fabricated to fill the slot. That list is part of the deliverable.

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

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable, human-readable, never a UUID: `dex:w:你好:ni3hao3`. Unique across the canon; the contract eval asserts no collisions. |
| `simplified` | `string` | Simplified headword. |
| `traditional` | `string` | Traditional headword. Equal to `simplified` where the forms do not differ. |
| `pinyin.marked` | `string` | Tone-marked: `nǐ hǎo`. |
| `pinyin.numbered` | `string` | Numbered, space-separated, 5 = neutral: `ni3 hao3`. |
| `pos` | `string[]` | Part-of-speech tags from the HSK source list (`N`, `V`, `Adj`, …). Slash-joined upstream tags such as `V/N` mean the word is both. |
| `hsk.band2026` | `number` | HSK 3.0 (2026) band, 1–7. The differentiator. |
| `hsk.bandRange` | `string?` | Present where the source list bands a range rather than a level — band 7 carries `"7-9"`. |
| `hsk.band2021` | `number \| null` | HSK 3.0 (2021 revision) band, where known. `null` means not established, not "zero". |
| `hsk.listId` | `string` | The row id in the pinned source list, so any assignment traces back to its upstream line. |
| `definitions` | `string[]` | English glosses. Terse, because CC-CEDICT is terse. |
| `audio.female` | `string \| null` | **`null` in v0.1.** |
| `audio.male` | `string \| null` | **`null` in v0.1.** |
| `audio.status` | `string` | **`"pending"` in v0.1** for every record. A record may not carry a URL while its status is `pending`; the contract eval enforces it. |

Fields the schema reserves but v0.1 does **not** populate: `frequencyRank`,
`zipf`, `radical`. They are absent rather than null-filled, and the packs that
would need them are deferred rather than approximated.

### Pack record — `data/packs/<slug>.json`

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"pack-v1"` | |
| `id` / `slug` | `string` | `dex:p:<slug>` and `<slug>`. Namespaced, kebab-case, **never reused** — a retired pack keeps its id. |
| `kind` | `"band" \| "frequency" \| "pos" \| "delta"` | |
| `itemType` | `"word"` | Sentence packs are a later tranche. |
| `title` / `oneLiner` / `description` / `rationale` | `string` | Prose. Hand-written build metadata in this tranche; no model writes any of it. |
| `level` | `{scheme, band, bandRange, cumulative}` | `band: null` means the pack makes **no level claim** — a pack that spans the corpus is not "band 1 with exceptions". |
| `size` | `number` | Must equal `words.length`. Asserted. |
| `words` | `string[]` | **Canon word ids only, ascending.** A pack never duplicates word data, so a pack can never drift from the canon. Every id must resolve; asserted. |
| `digest` | `string` | `sha256:` + SHA-256 over the sorted id list, newline-joined. **Recompute it yourself** — that is the point. Asserted on every build. |
| `selection` | `{query, order, deterministic, seedSource}` | The reproducibility contract: the literal query that produced `words[]`. |
| `bandClosure` | `{scheme, claimedMin/MaxBand, observedMin/MaxBand, overBand, underBand, offList, closed}` | **Measured, not asserted.** The result of scanning the selected words against the claimed window. A pack claiming a level must have `closed: true`. |
| `provenance` | `{words, columns, rule, curationSource, corpus, bands, definitions, audio, copy}` | `words` is `computed` or `computed+curated`; `copy` records who or what wrote the prose. |
| `audioCompleteness` | `{female, male, pending, status}` | **`status: "pending"` throughout v0.1.** Reported honestly rather than omitted. |
| `coverage` | `{bandLabelled, band2021Labelled, posLabelled, frequencyRanked, senseDisambiguated}` | Fractions, measured. `frequencyRanked` is `0` in v0.1 because the canon has no frequency column yet. |
| `version` / `corpusVersion` | `string` | CalVer. `version` bumps **only** when `words[]` changes. |
| `licence` | `{data, attribution}` | CC BY-SA 4.0 and the attribution line to reproduce. Travels inside every pack file so it cannot be separated from the data. |

---

## Licensing

Two licences, deliberately split, so copyleft never touches product code.

**Code — MIT.** `src/`, `scripts/`, `evals/`. See [`LICENSE`](LICENSE).

**Data — CC BY-SA 4.0.** Everything under `data/`, and every artifact built
from it: packs, exports, dictionary files, decks, API responses, MCP tool
responses. See [`data/LICENSE`](data/LICENSE) and [`NOTICE`](NOTICE).

This is not a stylistic choice. CC-CEDICT and Wiktionary are both CC BY-SA 4.0
and their glosses are merged into the canon; ShareAlike propagates through the
merge, and CC's §4 sui generis database rights make a database containing a
substantial portion of CC-CEDICT itself Adapted Material. BY-SA is the only
licence this corpus can carry. Jitendex is CC BY-SA 4.0 for the same reason.

### If you redistribute the data, you must

1. **Credit.** Reproduce this line, or one carrying the same facts:

   > Zhongdex by SayMei — https://zhongdex.org — CC BY-SA 4.0. Contains data
   > from CC-CEDICT (CC BY-SA 4.0), Wiktionary (CC BY-SA 4.0), and Tatoeba
   > (CC BY 2.0 FR).

2. **Link the licence** and **say what you changed.**

3. **Keep per-row attribution.** Where sentence records ship, Tatoeba-derived
   rows carry `source.sourceId`. That field *is* the attribution for those
   rows — do not strip it.

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
- [ ] **Frequency and radical columns** in the canon, which unblock the packs
      currently deferred in `pack-stats.json`.
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
