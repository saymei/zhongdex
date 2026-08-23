# Contributing to Zhongdex

Thanks for looking. This is a small project with a narrow scope, and the
fastest way to get a change merged is to know what that scope is before you
start.

## Before anything else: the licence split

- Code you contribute (`src/`, `scripts/`, `evals/`) is **MIT**.
- Data — anything under `data/`, and anything built from it — is
  **CC BY-SA 4.0**, because CC-CEDICT and Wiktionary are, and ShareAlike
  propagates through the merge.

By opening a pull request you agree your contribution ships under the licence
that applies to the files you touched. If you are contributing data from
another source, say where it came from and under what licence in the PR
description; if we cannot verify a compatible licence, we cannot merge it.

## Getting set up

```
git clone https://github.com/saymei/zhongdex.git
cd zhongdex
npm ci
npm run build          # writes data/ — required before the eval will run
npm run typecheck
npm run eval:contract
```

Node 22. `data/` is a build output and is not committed; a clean checkout has
an empty `data/` until you build.

## The four commands CI runs

```
npm ci
npm run typecheck
npm run build
npm run eval:contract
```

Nothing else. If those pass locally on Node 22, CI passes. Run them before you
push — the contract eval is under ten seconds and catches most of what a
reviewer would otherwise catch by hand.

## What a good pull request looks like

- **One thing.** A schema change, a pack, a bug fix. Not three.
- **The eval moved with the code.** If you changed the shape of a record, the
  assertion that guards that shape changed in the same commit. A schema change
  that leaves `evals/contract.ts` untouched is almost always wrong.
- **New source, new NOTICE entry.** In the same commit, with the attribution
  text that source's licence actually requires. Not "TODO: add attribution".
- **No new dependency** unless you say in the PR why a Node builtin cannot do
  it. Two runtime dependencies today; we would like to keep it near there.

## Things that will be rejected, so you do not waste an afternoon

**Hand-written or model-written word lists.** Pack membership is always the
output of a deterministic query over the canon. This is not stylistic: measured
against HSK 3.0 (2026), 394 of the 759 word slots in SayMei's own authored
worksheet packs carry a band label that disagrees with the current syllabus.
Authored lists rot when a syllabus moves; computed lists re-derive on every
build. If you cannot express your pack as a query over canon columns, the pack
gets deferred with a stated reason — that is the correct outcome, not a
failure.

**Audio URLs for audio that is not hosted.** Every audio field reports
`status: "pending"` and emits no URL, and the contract eval enforces it. A URL
that 404s inside somebody's flashcard review is worse than an honest null.

**Anything non-deterministic in the build.** No `Date.now()`, no
`Math.random()`, no `localeCompare` (its result depends on host ICU data), no
network reads at build time. Every pack digest is a promise that a stranger can
re-run the build and get the same list; a clock in the build path breaks that
promise silently.

**Silent coercion.** An out-of-range input errors and names the legal range. It
does not clamp and return success. An agent that receives clamped data reports
it to a human as if it were what they asked for.

**A seventh MCP tool.** Six is a budget, not an accident — the agent calling
this server is usually holding another server's forty tools at the same time.
A new tool needs an existing one deleted, and the PR needs to say which.

**Scope we have already ruled out**, with reasons in the program plan: an
Anki-writing tool (compose with `anki-mcp` rather than compete with it), a paid
API tier, base64 audio in MCP responses, and bundling audio into the dataset.

## Reporting a data error

Data errors are the most useful thing you can send us, and they need almost no
ceremony. Open an issue with:

- the record id (`dex:w:你好:ni3hao3`) or the pack slug,
- what is wrong,
- what it should be, and where you checked.

Wrong band assignments and wrong glosses are high priority. "This gloss is
terse" is not a bug — CC-CEDICT is terse, and rewriting glosses wholesale is
out of scope.

## Reporting a security issue

Do not open a public issue. Email the address on the SayMei site. The server is
keyless and read-only, so the interesting classes are resource exhaustion and
anything that makes the server emit a URL pointing somewhere we do not control.

## Release cadence

Monthly, dated, versioned CalVer. The cadence is a commitment, not an
aspiration: a dictionary pack or a deck that stops being rebuilt decays quietly
inside thousands of other people's collections. If you are proposing something
that adds recurring monthly work, say how much in the PR.
