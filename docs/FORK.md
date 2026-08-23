# Build your own deck

You describe the deck you want in one file. GitHub builds it and hands you the
files. **You do not install anything and you do not run anything.**

---

## Three steps

### 1. Make your own copy

Click **Use this template → Create a new repository** at the top of
[github.com/saymei/zhongdex](https://github.com/saymei/zhongdex). (**Fork** works
too. "Use this template" gives you a clean history, which is usually what you
want.)

### 2. Edit `my-list.yaml`

It is the file at the top level of your new repository. Click it, click the
pencil icon, change what you want. Every setting is explained in the file
itself, and everything after the `REFERENCE` line is documentation you can read
and ignore.

The whole thing, in miniature:

```yaml
name: "My HSK 1 Starter Deck"

from:
  - hsk-2026-t1        # start from a ready-made pack

words:                 # add your own
  - 谢谢

filter:
  max_band: 1          # HSK level 1 only
```

### 3. Commit

Scroll down, click **Commit changes**. That is it.

Open the **Actions** tab. There is a run called *Build deck*. When the green
tick appears — usually under a minute — click into it and scroll to the bottom.
Your files are under **Artifacts**, in a zip called `deck`.

You can also start a build by hand from the Actions tab: **Build deck → Run
workflow**. Useful when you want a fresh copy without changing anything.

> **No GitHub account?** The same compiler runs behind a web form at
> `saymei.app/tools/chinese-flashcard-maker`. Paste a word list, get the same
> files, no repository.

---

## What you get

| File | What it is |
|---|---|
| `deck.csv` | A spreadsheet. Imports into Anki (**File → Import**), Pleco, Excel, anything. |
| `deck.tsv` | The same thing, tab-separated. Some importers prefer it. |
| `deck.jsonl` | One JSON object per line, if you want to script something. |
| `RESOLVED.md` | **Read this one.** Every word in the deck, with the pinyin, the English, the HSK band, the part of speech, and which pack it came from. |

`RESOLVED.md` also carries a **selection digest** — a fingerprint of the exact
word list. The same `my-list.yaml` against the same corpus version always
produces the same digest, so you (or anyone) can check a deck is what it claims
to be.

**There is no audio yet.** No clips are published, so no deck ships audio fields
and no deck ships audio URLs. A URL that 404s in the middle of somebody's review
session is worse than an honest gap. When audio goes live this page will say so.

Formats that need the deck exporter — `.apkg` and Pleco — are not built yet. Ask
for them in `output.formats` anyway: the build tells you which ones it skipped
and still gives you the CSV.

---

## If the build fails

A red X is information, not a dead end. Click the failed run and read the top of
the log; every error names the file, the setting, and what to do.

The four you are most likely to hit:

**"my-list.yaml is not valid YAML at line N."**
Almost always indentation. Nested lines are indented by exactly two spaces, and
a list item begins with `- ` (dash, space). Compare your file against the
original — GitHub shows a diff on the commit.

**"NOT FOUND 苹果汁"**
That word is not in the corpus. Zhongdex covers the HSK 3.0 (2026) list — 11,092
entries — and nothing outside it, yet. The error prints the closest matches it
found; usually one of them is the word you meant. Words are **never dropped
quietly**: a deck missing something you asked for, that does not tell you, is
worse than a build that stopped.

**"AMBIGUOUS hello matches several entries"**
You asked for a word in English (or in pinyin without tones) and several Chinese
words fit. Write the characters instead — the error lists the candidates.

**"This deck would have 11,092 words; the limit is 5,000."**
Narrow it: lower `filter.max_band`, name a `filter.pos`, or drop a pack from
`from:`. The 5,000 ceiling is not negotiable in the workflow — nobody reviews
more than that, and a build that big is a problem for you before it is a problem
for anyone else.

---

## Share it

If you publish your deck, a line in your README helps the next person find where
it came from:

```markdown
Built with [Zhongdex](https://github.com/saymei/zhongdex).
```

(Once `dex.zhongdex.org` is live there will be a badge to go with it. The
hosting is not deployed yet — see [HOSTING.md](HOSTING.md).)

**Licence:** the words, pinyin and definitions come from CC-CEDICT and are
**CC BY-SA 4.0**. Share-alike propagates: a deck built from this data is also
CC BY-SA 4.0, and you cannot relicense it. Keep the attribution in
`RESOLVED.md` and you are fine. See `NOTICE`.

---

## For contributors: the exporter hook

`.github/workflows/build-deck.yml` always runs a small fallback compiler that
produces `csv`/`tsv`/`jsonl`/`RESOLVED.md` from Node builtins alone. That is
what guarantees a fresh fork is never red on its first commit.

When a richer exporter exists, the workflow finds and runs it as well:

1. an npm script named **`build:deck`**, if `package.json` has one; otherwise
2. **`src/export/deck.ts`**, run with `tsx`.

The contract, both ways:

| Variable | Value |
|---|---|
| `ZHONGDEX_DECK_SPEC` | path to the parsed spec as JSON (`dist/my-list.json`) |
| `ZHONGDEX_DECK_YAML` | path to the original `my-list.yaml` |
| `ZHONGDEX_OUT` | directory to write into (`dist/deck`) |

The exporter step is `continue-on-error: true` on purpose: the fallback output is
already on disk, so an exporter bug degrades a fork to CSV instead of breaking
it. Everything in `dist/deck/**` is uploaded as the artifact.

**Why `npm run export:anki` is not wired in.** It exists and it writes real
`.apkg` files, but it is corpus-wide — one deck per HSK band, built from the
whole canon — not per-`my-list.yaml`. Running it here would hand a fork owner a
full-corpus deck under their own deck name, which is the wrong answer delivered
confidently. The shortest path to `.apkg` support is a `build:deck` script that
reuses `src/export/anki.ts`'s writer over the word-id list from
`ZHONGDEX_DECK_SPEC`; the workflow will pick it up the moment that script name
exists.

Two rules for anyone editing that workflow:

1. **It must not fail on a fresh fork.** No network service other than GitHub,
   no dependency that is not committed, and the corpus is read from `data/`
   (which is committed) rather than rebuilt.
2. **It must never silently drop a word.** Unresolved input fails the build with
   the near-misses listed.
