# Registry and directory submissions

A checklist, in execution order. Tick the boxes.

Two things decide the order and they are not intuition:

- **Glama is first because everything reuses its inputs.** It is the only
  surface in the ecosystem with a *published scoring formula*, and the six tool
  descriptions written against that rubric are the same strings every other
  listing shows. Write them once, verify the grade, then submit everywhere.
- **The official MCP registry is a feed, not a storefront.** Its own docs: it
  *"is intended to be consumed primarily by downstream aggregators"* and *"is not
  intended to be directly consumed by host applications."* Its search is naive
  substring matching — `mandarin`, `pinyin`, `vocabulary` and `language learning`
  all return **zero** rows. Publish to it and move on; do not treat a listing
  there as distribution.

Effort figures are hours of work, not calendar time.

---

## Phase 0 — Before any code. Start now; these have unbounded lead time.

Each is a purchase or a queue somebody else controls. None can be hurried later.

- [ ] **Buy a Claude Team organisation.** The Connectors submission portal lives
      inside organisation settings, which **do not exist on individual plans**,
      and only Owners can submit. This is a purchase, not a task.
- [ ] **Start OpenAI Platform Dashboard developer verification** (identity +
      business affiliation). Its own queue, required before any ChatGPT app
      submission.
- [ ] **Publish the DNS TXT record** for the `app.saymei` namespace, so
      `mcp-publisher` can DNS-verify it.
- [ ] **Reserve the names**: `zhongdex-mcp` on npm, `zhongdex` on PyPI, the
      GitHub org, and `zhongdex.com` / `.org` / `.dev`. (All verified free on
      2026-08-22 — that will not stay true.)
- [ ] **Register `zhongdex.org` for 10 years, auto-renew on.** See
      [HOSTING.md](HOSTING.md) §1. Every hostname below becomes permanent the
      moment the first user saves a config.

### Two gates that block submissions, not just delay them

- [ ] **The TTS endpoint is never an MCP tool.** Anthropic's review criteria list
      *"Generate images, video, or audio via AI models"* under **unsupported use
      cases**. `POST /v1/speak` must not be exposed as a tool, and
      `mandarin_audio` must be specified as **retrieval-only** — it answers "do
      you already have this recording?" and returns a URL or a clean miss, and
      may never synthesise. Before any Claude or ChatGPT submission, the public
      docs must already describe the audio as a **pre-recorded, licensed archive
      of static files**, with generation happening offline in a batch pipeline. A
      reviewer skimming an ElevenLabs-sourced audio server will pattern-match to
      the ban unless that framing is public first. Keeping synthesis off the MCP
      surface makes the distinction structural rather than rhetorical.
- [ ] **Nothing in a tool description may favour or disparage another service.**
      An OpenAI requirement, and it constrains how the anki-mcp pairing is worded
      *inside a description*. Put it in the prompt text and the tool output,
      never in the description string.

---

## Phase 1 — Weeks 1–2. Write the strings once.

### 1. Glama quality grade · 4 h · **do this before any other submission**

The only published formula in the ecosystem:

- **70% Tool Definition Quality** — Purpose Clarity 25, Usage Guidelines 20,
  Behavioral Transparency 20, Parameter Semantics 15, Conciseness 10, Contextual
  Completeness 10.
- **30% Server Coherence** — Disambiguation, Naming Consistency, Tool Count
  Appropriateness, Completeness, in equal parts.
- **The roll-up is 60% mean TDQS + 40% MINIMUM TDQS.** One weak description caps
  the whole grade. Write all six to the same standard or the sixth drags the
  other five down.

- [ ] Write the six tool descriptions against the rubric above.
- [ ] Self-score every description on all six TDQS dimensions; fix the lowest one
      first, because the minimum is 40% of the grade.
- [ ] Verify the grade reaches **A (≥3.5)** before submitting anywhere else.
      Every other listing reuses these strings, and the badge renders inline in
      the 92,699-star awesome list.
- [ ] Assert the token budget in CI: full `tools/list` (6 tools + 4 prompts)
      **≤ 2,000 tokens**.

Claiming the Glama listing itself is Phase 3; the *grade* is what has to be
right first.

---

## Phase 2 — Weeks 3–4. Prove it works before anyone is watching.

- [ ] Private beta of the remote endpoint.
- [ ] Synthetic probe running the full chain every 60 s: `server/discover` →
      `tools/list` → `mandarin_lookup("你好")` → HEAD the returned audio URL.
- [ ] Public `/status` page with the SLOs on it.
- [ ] Yomitan dictionaries shipped (they are the prerequisite for Phase 5).

**Ship both transports together.** Keyless remote is the headline — the install
is a URL, and it eliminates the entire OAuth 2.1 + DCR drop-off. But a
remote-only listing is invisible to the package-oriented half of the aggregator
layer and cannot enter the Docker catalogue at all. So publish `npx zhongdex-mcp`
(~150 lines, proxying to the remote endpoint, no configuration and no key)
alongside it. **One core, two transports, one version number, published
together.** ~1 day.

---

## Phase 3 — Launch day. All of it on ONE day.

Aggregators poll roughly hourly. Doing these on one day means every one of them
picks up a single coherent metadata set instead of six inconsistent snapshots.

- [ ] **Official MCP registry** · 2 h — publish with `mcp-publisher` under the
      DNS-verified `app.saymei` namespace. Ship versions often: every version is
      its own row and "Recently Updated" is a first-class view.
- [ ] **Smithery** · 3 h — the only surface with a **public usage counter that
      ranks** (`kuibinlin/hsk-mcp-server` sits at 4,831 uses on one GitHub star).
      `useCount` accrues only through Smithery's gateway, so front the listing
      with a `*.run.tools` URL. **Do not make that the canonical URL in your own
      documentation** — a third party's gateway in your docs is a dependency you
      do not control. Keyless is a scan advantage: auth-required servers can fail
      the metadata scan outright.
- [ ] **Glama** — claim the listing (the grade is already earned in Phase 1).
- [ ] **mcp.so** — submit.
- [ ] **PulseMCP** — claim.
- [ ] **One-click install links in the README** · 1 h — Cursor deeplink,
      `vscode://mcp/install`, Claude connector link. Minutes of work, and the
      actual install path for most users; it routes around the 30–50%
      install-failure rate reported for community stdio servers.
- [ ] **`.mcpb` bundle** attached to the GitHub Release.
- [ ] **Hugging Face mirror + Croissant metadata** · 4 h — **not a traffic
      channel.** The category leader, `no7z/hsk-sentences-audio`, has 1,543
      downloads. It is worth doing for two other reasons: a free Croissant
      endpoint into Google Dataset Search, and a durably-named artifact that
      future models train on. HF PRO at $9/mo covers the corpus (10 TB public
      storage against 71 GB) and its egress is free.

### Launch day + 7, not before

- [ ] **`punkpeye/awesome-mcp-servers` PR into 🎓 Education** · 1 h — 92,699
      stars. The Education section has **exactly five entries: zero Chinese, zero
      Anki, zero corpus servers.** Claim 🎖️ official + ☁️ cloud + 📇 TypeScript,
      with the Glama badge inline. Submit **seven days after launch**, once
      `useCount` and the grade are non-zero: an entry with a live badge and real
      usage reads as established; one without reads as a dead link.

---

## Phase 4 — Weeks 7–9. The concentrated dose.

### 5. The anki-mcp campaign · 8 h · three parts, in this order

`ankimcp/anki-mcp-server` does 5,965 npm downloads/month and is **accelerating**
(2,071 in the last 7 days). It is the most concentrated dose of the exact buyer
anywhere. 452 stars, 1 open issue, 3 watchers — a clean PR gets read.

- [ ] **(a) Publish the worked recipe first** at
      `saymei.app/dex/recipes/anki-mandarin-audio`: the full transcript of *"build
      me 20 HSK 3 cards with audio"* — every tool call, the resulting CSV, the
      `media[]` manifest in the real `storeMediaFile` shape, and a screenshot of
      the finished card in Anki. Indexable, `.md` twin, no signup. The PR in (b)
      is worthless without something to link to.
- [ ] **(b) PR to `ankimcp/anki-mcp-server`'s audio documentation** — add a
      Mandarin worked example to their existing "How to Add Audio to Anki Cards"
      page, **which already states the server cannot generate audio.** Frame it as
      filling their documented gap, not as promotion.
- [ ] **(c) `zhongdex-anki` example repo** — a 60-line script that takes a word
      list and produces a ready `.apkg`.

### 6. Yomitan `recommended-dictionaries.json` PR · 2 h

One PR against `yomidevs/yomitan` adding three entries to
`ext/data/recommended-dictionaries.json`:

| Key | Today | Entry |
|---|---|---|
| `zh.terms` | populated | Zhongdex terms |
| `zh.frequency` | **`[]` — empty** | Zhongdex Frequency |
| `zh.pronunciation` | **`[]` — empty** | Zhongdex Pronunciation |

The frequency and pronunciation slots are **unopposed**, which makes them the
easy merges: they would be the only Mandarin frequency and pronunciation
dictionaries in existence. `zh.terms` is contested and may not merge; do not let
it hold the other two.

- [ ] **Open the PR only after a working release exists.** A recommendation
      pointing at a repo with no downloadable asset is a maintainer's reason to
      close it.
- [ ] Post in the Yomitan community thread and r/ChineseLanguage first, framed as
      *"Yomitan's Mandarin slots are empty — here are the first frequency and
      pronunciation dictionaries, plus a two-voice audio source."*

### 8. Claude Connectors Directory · 8 h

- [ ] Confirm the Team/Enterprise organisation from Phase 0 exists and you are an
      Owner.
- [ ] Confirm the audio framing from Phase 0 is already public.
- [ ] Submit. **Good news the plan misses:** default listing is now automatic —
      servers are scanned and listed as a "community connector," with Anthropic
      escalating high-usage ones to verified review. **"No authentication" is
      explicitly supported**, which is the whole architecture here.
- [ ] If submitting an MCP App: 3–5 PNG screenshots, **≥1000 px wide**, cropped to
      the app response, prompt not visible, **no video and no GIF**.

- [ ] Reddit posts: r/ChineseLanguage, r/Anki, r/LocalLLaMA.

---

## Phase 5 — Weeks 10–13. Gated; only if Phase 3–4 produced numbers.

### 9. ChatGPT app / plugin directory · 12 h · **demoted from #1 to #9**

The highest-effort, highest-gate item in the list. Unauthenticated servers are
permitted, but:

- [ ] Developer verification complete (started in Phase 0 — check the queue).
- [ ] **Cannot initiate subscriptions or display subscription plans.**
- [ ] Must be suitable for ages 13–17.
- [ ] Descriptions must not favour or disparage other services.
- [ ] Five positive and three negative test cases passing, **on web and mobile**.

### 11. Docker MCP Catalog PR · 4 h

- [ ] Requires the npm package to exist first (Phase 2 ships it).

---

## Cut, deliberately

- **`yzfly/Awesome-MCP-ZH`** — 7,591 stars, and cut anyway. The audience is
  Chinese-*speaking* developers, who are not learning Mandarin. Stars are not
  reach when the reader is not the buyer.

---

## After launch: the only cadence that matters

- [ ] **A dated release at least monthly. Forever.** Every registry surface ranks
      on recency, and a "Recently Updated" row is free distribution.
- [ ] Weekly, on one dashboard: Smithery `useCount`, Glama grade, npm downloads,
      MCP-App "Open in SayMei" clicks.
- [ ] Monthly, **in the same table**: GitHub stars next to qualified signups, so
      the divergence between the two stays visible instead of comfortable.

**A calibration to keep on hand:** the #1 server in the entire Smithery directory
has 43,390 *lifetime* uses. Any projection above that is a fantasy, and the cost
model does not bend until ~143,000,000 calls/month.
