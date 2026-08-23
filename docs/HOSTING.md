# Hosting runbook

**Status: nothing is deployed.** R2 is not enabled on the Cloudflare account — the
API answers `10042 · Please enable R2 through the Cloudflare Dashboard` — so no
bucket exists, no Worker has been uploaded, and no hostname resolves. This
document is written so that the whole thing can be stood up in one sitting the
hour R2 is switched on, in the order given, with the guard rails installed
*before* the first public URL rather than after the first invoice.

Read §1 and §2 before touching anything. §2 is not optional hardening; one
setting in it is the only difference between a bill that is flat at every
traffic volume and a bill that is unbounded.

---

## 0. What is being deployed

| Hostname | Serves | Worker? | Why |
|---|---|---|---|
| `audio.zhongdex.org` | ~637k static mp3 objects | **NO — never** | ~96% of request volume. A Worker runs *before* cache and bills on every cache HIT. |
| `api.zhongdex.org` | prebuilt per-word JSON, pack JSON, `/health` | yes (`worker/`) | Routing and actionable 404s. Can be unbound later without changing a single URL. |
| `dex.zhongdex.org` | `/mcp`, `/v1/speak` | yes (separate Worker, not in this repo) | The only routes that legitimately need compute. |

Everything on `audio.` and `api.` is keyless, read-only, and static. There is no
origin server and no database on the read path.

**Why a `zhongdex.org` apex and not `audio.saymei.app`:** Cloudflare subdomain
zones are Enterprise-only, so `audio.saymei.app` cannot be its own zone. Machine
traffic needs its own zone — Bot Fight Mode is domain-wide and cannot be skipped
per-route, and Cloudflare warns it may challenge API clients. Put machines on
`zhongdex.org` (Bot Fight Mode **off**), keep marketing on `saymei.app` (on), and
301 the `zhongdex.org` apex to `www.saymei.app/dex` so there is one human
property and no duplicate content.

---

## 1. Prerequisites

Each of these is a purchase or an account state, not a task. None can be
scripted, and two have lead time.

- [ ] **`zhongdex.org`, registered for 10 years, auto-renew ON.** ~$120 one-time
      at Cloudflare Registrar's at-cost pricing. This is the single point of
      failure in the entire system: every installed Yomitan configuration
      hard-codes the audio hostname, and if the domain lapses it breaks silently
      inside somebody else's study session. Ten years up front is cheaper than
      one month of the ads budget.
- [ ] **Workers Paid, $5/month, from day one.** Not for capacity — the free tier
      would cover year one. The CDN Service-Specific Terms condition serving a
      large share of large files on using a qualifying **Paid Service**, and
      nothing establishes that a bucket entirely inside the free tier counts as
      *using* the Developer Platform. $5/month buys that argument outright and
      protects the one asset that cannot be rebuilt: an audio hostname thousands
      of configs have hard-coded. The risk here is an **outage, not a bill** —
      and `dictionaryapi.dev`, the named cautionary case, died exactly this way.
- [ ] **R2 enabled** (Dashboard → R2 → Enable). Blocks everything below.
- [ ] **Default $10 pay-as-you-go budget alert enabled.** Free, and worth having,
      but understand what it is: *"Budget alerts are informational only. They do
      not pause or cap usage."* The thing that actually caps the bill is §4.

---

## 2. Deploy, in order

### 2.1 Bucket

```bash
npx wrangler r2 bucket create zhongdex-corpus
```

Then, in the dashboard, **R2 → zhongdex-corpus → Settings → Public access →
disable `r2.dev`.** The `r2.dev` URL gets no Cloudflare caching, is explicitly
rate-limited and bandwidth-throttled by design (a community report has a
free-tier bucket dropping to ~10 Mbps at peak), and — the real problem — it
leaves the bucket reachable *behind* every protection configured below.

### 2.2 Upload

Upload with the **S3-compatible API**, not the REST management API: the REST
management API is capped at **1,200 requests per 5 minutes per account**, which
would take ~44 hours for a 637k-object corpus.

Key layout — the object key *is* the URL path, with no rewrite and no route map:

```
v1/w/<voice>/<word>.mp3             audio.zhongdex.org/v1/w/amy/你好.mp3
v1/w/<voice>/<word>.slow.mp3        0.7x reading
v1/w/<voice>/<word>.<pinyin>.mp3    polyphone, e.g. .../v1/w/amy/行.hang2.mp3
v1/w/<word>.json                    api.zhongdex.org/v1/w/你好
v1/packs/index.json                 api.zhongdex.org/v1/packs
v1/packs/<slug>.json                api.zhongdex.org/v1/packs/hsk-2026-t1
```

Run `npm run plan:audio-migration` for the batch list, the measured maximum path
length, and the two blocking decisions the layout still needs (dominant reading
for bare polyphone paths; a normalisation rule for the 43 annotated headwords).

**Uploads must be incremental — skip objects whose hash is unchanged.** This is
the largest avoidable recurring cost in the program and it is not in anyone's
cost table by default. R2 writes (Class A, $4.50/million) are **12.5× the price
of reads**:

| Nightly build behaviour | Class A ops/month | Cost |
|---|---|---|
| Re-PUT all 637,127 objects | 19.1M | **$81.51/mo** — more than every other line combined |
| Re-PUT ~200k JSON files | 6.0M | **$22.50/mo** |
| Incremental, content-addressed | ~0 | **$0.00** |

### 2.3 Custom domain for audio — no Worker

**R2 → zhongdex-corpus → Settings → Custom Domains → `audio.zhongdex.org`.**

Do not create a Worker route on this hostname. Not now, not "temporarily". A
Worker executes before the cache lookup, so binding one bills a request on every
cache **hit** — $9.20/month at 24M requests, **$302/month at 1B**. The audio key
layout was made constructible specifically so no Worker is needed here.

### 2.4 The Worker

```bash
cd worker
# fill in account_id and uncomment the [[routes]] block in wrangler.toml first
npx wrangler deploy
```

Verify:

```bash
curl -s https://api.zhongdex.org/health
curl -s https://api.zhongdex.org/v1/packs | head -c 400
curl -si https://api.zhongdex.org/v1/w/%E4%BD%A0%E5%A5%BD | grep -i '^x-zhongdex-version'
```

---

## 3. Guard rails

These are load-bearing. Install all of them before the first public URL is
published anywhere.

### 3.1 Cache Rules — the one that matters most

**Rules → Cache Rules.** Two rules, and the Cache Key setting on the first one is
the single most important line in this document.

**Rule 1 — audio**

| Field | Value |
|---|---|
| When | `hostname eq "audio.zhongdex.org"` |
| Cache eligibility | **Eligible for cache** |
| Edge TTL | **Ignore origin, use 1 year** (31536000) |
| Browser TTL | 1 year |
| **Cache Key → Query String** | **IGNORE QUERY STRING** |

**Rule 2 — JSON**

| Field | Value |
|---|---|
| When | `hostname eq "api.zhongdex.org" and starts_with(http.request.uri.path, "/v1/")` |
| Cache eligibility | **Eligible for cache** (Cache Everything) |
| Edge TTL | 1 year |
| Browser TTL | 1 hour |
| **Cache Key → Query String** | **IGNORE QUERY STRING** |

Rule 2 is not redundant: Cloudflare's default cached-extension set includes
`mp3` but **not `.json`**, so without an explicit rule every prebuilt-JSON lookup
is an R2 origin read — free at 1M/month, **$32.40/month at 100M**.

> **Why "ignore query string" is the whole ballgame.** With it, `?x=1`, `?x=2` …
> `?x=∞` all collide onto one cache entry and the number of billable origin
> reads is bounded by the **object count (637,127)**, not the request count.
> Without it, every distinct query string is a distinct cache entry and a forced
> origin read: **100M forced reads = $32.40 · 1B = $356.40 · 2.6B (1,000 req/s
> sustained) = $932.40 · 26B = $9,356.40.** It is the only genuinely unbounded
> vector in the system. Everything else in this document is worth tens of
> dollars; this one is worth thousands.
>
> The Worker enforces the same invariant in code: `worker/index.ts` never reads
> `url.search`, so no client can ever come to depend on a query parameter and
> make this setting look like a bug.

**Rule 3 — cache negative responses.** In the same Cache Rules, set **Edge TTL →
Status code 404 → 10 minutes** for both hostnames. R2 bills a Class-B operation
on a 404 (community-observed; the pricing page disclaims only 401), and 404s are
not cached by default, so random-key scanning is otherwise billable at full rate.

### 3.2 Smart Tiered Cache — ON

**Caching → Tiered Cache → Smart Tiered Cache: On.** Available on Free.

Without it a cold corpus can miss once per edge location: 637,127 objects ×
~330 edges = 210M Class-B operations = **$72.09**, once per TTL cycle. With it,
upper-tier data centres shield the origin and that collapses to roughly one
origin read per object.

### 3.3 Bot Fight Mode — OFF on this zone

**Security → Bots → Bot Fight Mode: Off** for `zhongdex.org`. It is domain-wide,
cannot be bypassed with Skip actions, and Cloudflare warns it may challenge API
clients — which is every single consumer of this service. Leave it **on** for
`saymei.app`. This is the entire reason for the separate zone.

### 3.4 WAF — five custom rules, no regex

Free gives 5 custom rules, and `matches` (regex) is **Business and Enterprise
only**. Everything below uses `len()`, `starts_with()`, `ends_with()`, which
carry no plan restriction.

**Rule 1 — path allowlist** (Block)

```
(http.host in {"audio.zhongdex.org" "api.zhongdex.org"})
and (not starts_with(http.request.uri.path, "/v1/"))
and (http.request.uri.path ne "/health")
and (http.request.uri.path ne "/robots.txt")
```

**Rule 2 — path length** (Block)

```
(starts_with(http.request.uri.path, "/v1/w/") and len(http.request.uri.path) > 96)
```

96 is measured, not guessed: the longest key the corpus can mint is **57
characters** (`scheme.pathLength.maxObserved` in `data/audio-migration-plan.json`,
recomputed on every planner run). Anything longer is a scan. Blocking at the
edge costs nothing and R2 never sees the Class-B operation.

**Rule 3 — read-only** (Block)

```
(http.host in {"audio.zhongdex.org" "api.zhongdex.org"})
and (not http.request.method in {"GET" "HEAD" "OPTIONS"})
```

**Rule 4 — extension guard on the audio host** (Block)

```
(http.host eq "audio.zhongdex.org")
and (not ends_with(http.request.uri.path, ".mp3"))
```

**Rule 5 — RESERVED KILLSWITCH. Leave it disabled and empty of intent.**

```
(http.host in {"audio.zhongdex.org" "api.zhongdex.org"})
```
Action **Block**, **Enabled: off**. This rule exists so that the cron Worker in
§4 — and a human at 2am — has a single pre-provisioned switch to flip. Creating a
rule under pressure is how people typo a filter and take the whole zone down.
Note its **ruleset id and rule id** now; §4 needs both.

### 3.5 Rate limiting — one rule, all Free allows

**Security → WAF → Rate limiting rules.** Free gives exactly **1 rule, IP-only
counting, 10-second period only**. So:

- Path: all
- **300 requests per 10 seconds per IP**, action Managed Challenge or Block.

That is the maximum expressiveness Free offers and it consumes the single
available rule. Do not spend it on something narrower.

---

## 4. The hourly killswitch Worker

**This, not Cloudflare, is what converts a ~$1,000 theoretical ceiling into
~$50.** Budget alerts are informational and fire the day after. This polls R2's
own analytics hourly and flips WAF rule 5 to Block when Class-B operations cross
a threshold.

Deploy it as a **separate Worker** with its own API token. A bug in a killswitch
must not be able to take the read API down with it.

`killswitch/wrangler.toml`:

```toml
name = "zhongdex-killswitch"
main = "index.ts"
compatibility_date = "2026-08-22"
workers_dev = false

[triggers]
crons = ["0 * * * *"]

[vars]
CLASS_B_THRESHOLD = "5000000"   # 50% of the 10M/month free tier
```

Secrets (`npx wrangler secret put <NAME>`): `CF_API_TOKEN` (scoped to
*Account → Account Analytics: Read* and *Zone → Zone WAF: Edit*, nothing else),
`CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_RULESET_ID`, `CF_RULE_ID`, `ALERT_WEBHOOK`.

`killswitch/index.ts`:

```ts
export default {
  async scheduled(_event: unknown, env: Record<string, string>): Promise<void> {
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    // Verify this query against the current GraphQL schema on first run — the
    // analytics node names have changed before and a silently-empty result set
    // would disable the killswitch without disabling anything else.
    const query = `query ($account: String!, $since: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        r2OperationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $since, actionType: "ListBucket"}) {
          sum { requests }
        } } } }`;

    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, since } }),
    });
    const body = (await res.json()) as { data?: { viewer?: { accounts?: { r2OperationsAdaptiveGroups?: { sum?: { requests?: number } }[] }[] } } };
    const ops = body.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups?.[0]?.sum?.requests ?? 0;

    if (ops < Number(env.CLASS_B_THRESHOLD)) return;

    // Flip the reserved WAF rule to Block.
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/rulesets/${env.CF_RULESET_ID}/rules/${env.CF_RULE_ID}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, action: "block" }),
      },
    );

    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `zhongdex killswitch ARMED: ${ops} R2 Class-B ops month-to-date, threshold ${env.CLASS_B_THRESHOLD}. audio.zhongdex.org and api.zhongdex.org are now BLOCKED. Re-enable by disabling WAF rule ${env.CF_RULE_ID}.`,
      }),
    });
  },
};
```

**Threshold arithmetic.** Steady state is ~955,690 origin reads/month (637,127
objects × a 1.5 refill factor). 5,000,000 is 5× that and still inside the free
tier, so tripping it costs $0 and only ever means something is wrong. Detection
latency is one hour; at 1,000 req/s of scanning that hour is 3.6M operations =
**$1.30**. The exposure is the accumulation up to the threshold (free) plus
~$1.30, not the $932/month the same scan would cost unattended.

**Recovery:** disable WAF rule 5 in the dashboard. Nothing else needs undoing.

---

## 5. Why the bill is flat

The only dimension that scales with traffic — bytes — is priced at **zero** on
R2. The only dimension that scales with popularity — origin reads — is bounded
by the **object count (637,127)**, not the request count, because a 1-year edge
TTL plus Smart Tiered Cache means each object is fetched from origin roughly
once per TTL cycle no matter how often it is requested.

> 637,127 objects × 1.5 refill factor = **955,690 origin reads/month**, against
> R2's free tier of **10,000,000 Class-B operations/month**. Ten times inside
> the free tier. **Class B is $0.00 at one billion requests per month.** Even at
> a pessimistic 98% hit ratio at 1B requests, 18M misses cost $2.88.

| Total requests/month | 10k | 100k | 1M | 10M | 100M | 1B |
|---|---|---|---|---|---|---|
| R2 storage (61 GB billable) | $0.92 | $0.92 | $0.92 | $0.92 | $0.92 | $0.92 |
| R2 egress | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| R2 Class A (incremental build) | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| R2 Class B (origin reads) | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| Workers Paid base | $5.00 | $5.00 | $5.00 | $5.00 | $5.00 | $5.00 |
| Workers overage (10% hit the Worker, 2 CPU-ms) | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $30.40 |
| Hugging Face PRO | $9.00 | $9.00 | $9.00 | $9.00 | $9.00 | $9.00 |
| Domain (amortised) | $1.00 | $1.00 | $1.00 | $1.00 | $1.00 | $1.00 |
| **TOTAL** | **$15.92** | **$15.92** | **$15.92** | **$15.92** | **$15.92** | **$46.32** |

**Six orders of magnitude of traffic move the bill by $30.40.**

The popular case, spelled out: 10,000 Yomitan daily users × ~40 lookups/day =
12M lookups = **24M requests, 594 GB/month**. Bill: **$15.92** — identical to a
10,000-request month. The same 594 GB through Railway Express at $0.05/GB is
$29.70, i.e. the origin would cost roughly twice the entire Zhongdex bill just
to move the bytes.

### What each control is worth

| Vector | Cost if unguarded | Control | Worth |
|---|---|---|---|
| Cache-buster query strings | $932/mo at 1,000 req/s · $9,356/mo at 26B | Cache Key → Ignore Query String (§3.1) | up to ~$9,400/mo |
| 404 key scanning | $932/mo at 1,000 req/s | WAF path guards + 404 edge TTL (§3.1, §3.4) | ~$930/mo |
| No Smart Tiered Cache | $72.09 per TTL cycle | Smart Tiered Cache (§3.2) | $72 |
| Worker on a static route | $9.20/mo at 24M · $302/mo at 1B | No Worker on `audio.` (§2.3) | up to $302/mo |
| Nightly full re-upload | $81.51/mo | Incremental upload (§2.2) | $81/mo |
| Workers Paid runaway | $7,800 at 26B | The hourly cron (§4) | unbounded |
| Egress | — | — | **$0.00, forever** |

### The stated maximum

**With every guard rail armed the worst case is ~$50/month**, and the thing
enforcing that is the cron Worker in §4, not Cloudflare. Realistic year one is
**$15.92/month, $191/year.**

Named break-even points, for calibration:

- Workers first exceeds $50/month at **~143,000,000 Worker-backed calls/month**
  (solving `5 + 0.30(R−10) + 0.02(2R−30) = 50`). That is 3,300× the *lifetime*
  usage of the #1 server in the entire Smithery directory.
- R2 Class B first costs one cent at **~16 uncached full-corpus sweeps** in a
  month, and first exceeds $50/month at 148,900,000 origin misses.
- R2 storage first exceeds $50/month at 3,343 GB — 47× the corpus.

**Below ~150M requests/month, any bill above ~$50 is a misconfiguration, not
growth** — a cache rule that stopped firing, a Worker accidentally bound to a
static route, or a scan getting past the WAF. Fix the config; do not build a
pricing page.

---

## 6. Post-deploy verification — four pass/fail tests

Run all four before publishing a single URL. Test 1 is the one that voids the
entire cost model if it fails.

1. **Cache-buster.** Fetch one clip 50× with 50 distinct query strings. Confirm
   against **R2's own GraphQL Class-B metric** (not the cache-hit header) that
   origin reads did not increase by 50. If they did, §3.1 is not in effect and
   nothing else in this document is true.
   ```bash
   for i in $(seq 1 50); do curl -so /dev/null "https://audio.zhongdex.org/v1/w/amy/%E4%BD%A0%E5%A5%BD.slow.mp3?cb=$i"; done
   ```
2. **No Worker on the static path.** Fetch a cached clip 1,000× and confirm the
   Workers request counter did not move.
3. **WAF blocks scans.** Request 20 nonexistent paths of the wrong shape and
   confirm the WAF blocks them before R2 sees a Class-B operation.
4. **Transform rule ordering** (only if a Yomitan query→path rewrite is added
   later): confirm empirically that the rewrite fires **before** cache. If it
   fires after, every lookup becomes a distinct cache entry and §3.1 is silently
   defeated.

---

## 7. Publishing a release

1. `npm run build` — canon and packs.
2. Upload **incrementally**; skip unchanged objects (§2.2).
3. Bump `DATA_VERSION` in `worker/wrangler.toml` and `npx wrangler deploy`.
4. Purge the changed prefixes only (`Caching → Configuration → Purge by prefix`).
   Never "Purge Everything": it forces a full 637k-object refill.
5. Re-run verification test 1.

Archives — the audio tarballs and dataset dumps — **never go on Cloudflare.**
This is an architectural rule, not a preference. They live on Hugging Face
(<200 GB/file, "egress and CDN included at no extra cost") and GitHub Releases
(no stated bandwidth limit, 2 GB per asset, so chunk into ~30 parts). A
multi-gigabyte archive streamed from a Cloudflare custom domain is precisely the
"disproportionate large file" the CDN terms are aimed at, and two other
platforms will carry that bandwidth for free and have written down that they
will.

---

## 8. The do-nothing steady state

If work stops entirely: delete the Worker (nothing depends on it — audio and
prebuilt JSON are static R2 objects on a custom domain), drop Hugging Face PRO
to free, cancel Workers Paid.

Remaining: **$1.92/month = $23/year, indefinitely.** No origin, no server, no
on-call, no dependency that expires, no code that can rot.

The one thing that must not lapse is the domain renewal. Everything else in this
document can be rebuilt from the repo in an afternoon; a hostname that thousands
of Yomitan configurations have hard-coded cannot.

---

## 9. Escalation

- If egress ever exceeds **~50 TB/month**, write to Cloudflare first. It is free,
  and it turns a surprise email into a conversation you started.
- If a hostname is throttled or disabled, the archives on Hugging Face and GitHub
  Releases are unaffected — that separation is why they are there — and the
  domain is owned, so the origin can be repointed without breaking a single
  published URL.
