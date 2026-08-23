/**
 * Zhongdex read API — a Cloudflare Worker over a static R2 bucket.
 *
 * NOTHING IS DEPLOYED. R2 is not enabled on the account (the API returns
 * code 10042, "Please enable R2 through the Cloudflare Dashboard"), so this
 * file has never run against a real bucket. It is written to be deployable the
 * hour R2 is switched on. See docs/HOSTING.md for the runbook.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * Keyless, read-only, no origin database, no writes, no synthesis, no clock
 * dependence. Every response is a prebuilt JSON object copied out of R2 with
 * a cache header on it. The Worker adds routing, an actionable 404, and CORS —
 * nothing else. If it were deleted tomorrow the objects would still be there.
 *
 * ── What it deliberately does NOT serve ────────────────────────────────────
 *
 * Audio. A Worker executes BEFORE the cache lookup, so a Worker bound to a
 * route bills a request on every cache HIT: ~$302/month at 1B requests
 * (REVISION1 §6.6). Audio is ~96% of request volume, so it must be served by
 * the R2 custom domain `audio.zhongdex.org` with no Worker in front of it,
 * which is exactly why the audio key layout was made constructible
 * (`v1/w/<voice>/<word>.mp3`, key == URL path, no rewrite needed).
 * `/v1/w/*.mp3` on this host therefore answers 404 and names the right host,
 * so a misroute is discovered in a second instead of on an invoice.
 *
 * The same argument applies to this JSON at scale. The route table in
 * docs/HOSTING.md keeps the Worker on `api.zhongdex.org` and gives the option
 * of publishing the JSON prefix on the R2 custom domain and unbinding the
 * Worker route once volume justifies it. Nothing in a client breaks when that
 * happens: the URLs and bodies are identical either way.
 *
 * ── The one invariant this file must never break ───────────────────────────
 *
 * THE QUERY STRING IS NOT READ. Not for versioning, not for a format switch,
 * not for debugging. Cache Rules are configured with Cache Key = Ignore Query
 * String — the single most important cost setting in the program, and the only
 * path from a bounded bill to an unbounded one. The moment any behaviour here
 * depends on a query parameter, that setting becomes a correctness bug and
 * someone will "fix" it by turning it off. `url.search` appears nowhere below.
 */

/* -------------------------------------------------------------------------- */
/* Minimal ambient types                                                       */
/*                                                                             */
/* Hand-declared rather than pulled from @cloudflare/workers-types: this repo   */
/* has two runtime dependencies and adding a 3 MB type package to typecheck one */
/* file is not a trade worth making. Only the surface actually used is here.    */
/* -------------------------------------------------------------------------- */

interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
}

interface R2GetOptions {
  onlyIf?: { etagDoesNotMatch?: string };
}

interface R2Bucket {
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
  head(key: string): Promise<R2Object | null>;
}

export interface Env {
  /** R2 binding. Configured in wrangler.toml; see docs/HOSTING.md. */
  readonly CORPUS: R2Bucket;
  /** Release string, e.g. "2026.09.1". Echoed in every response. */
  readonly DATA_VERSION?: string;
  /** Hostname serving audio. Only ever used to write a helpful 404. */
  readonly AUDIO_HOST?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_DATA_VERSION = "unset";
const DEFAULT_AUDIO_HOST = "audio.zhongdex.org";

/**
 * Browser TTL 1 hour, edge TTL 1 year. The edge number is the one that matters:
 * it is what bounds R2 Class-B operations to `distinct objects x refill factor`
 * instead of scaling with request count. A release purges by prefix rather than
 * waiting the TTL out — see docs/HOSTING.md, "Publishing a release".
 */
const CACHE_HIT = "public, max-age=3600, s-maxage=31536000";

/**
 * 404s are cached too, and this is a cost control, not an optimisation: R2
 * bills a Class-B operation on a miss, and 404s are not cached by default, so
 * random-key scanning is otherwise billable. Ten minutes is long enough to
 * flatten a scan and short enough that a newly published word appears promptly.
 */
const CACHE_MISS = "public, max-age=600, s-maxage=600";

const CACHE_NEVER = "no-store";

/**
 * Mirrors the WAF `len()` guard in docs/HOSTING.md. Defence in depth: the WAF
 * rejects these at the edge for free, and this rejects them if a rule is ever
 * dropped. The longest key the corpus can mint measures 57 characters
 * (data/audio-migration-plan.json, scheme.pathLength.maxObserved).
 */
const MAX_PATH_LENGTH = 96;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff",
};

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

function headers(version: string, cacheControl: string, extra?: Record<string, string>): Headers {
  const out = new Headers(JSON_HEADERS);
  out.set("cache-control", cacheControl);
  out.set("x-zhongdex-version", version);
  for (const [key, value] of Object.entries(extra ?? {})) out.set(key, value);
  return out;
}

/**
 * Every error names the fix and the next call. An error an agent cannot act on
 * is a dead end (AGENTS.md, hard constraint 4).
 */
function errorResponse(
  status: number,
  code: string,
  message: string,
  next: readonly string[],
  version: string,
  cacheControl: string,
): Response {
  const body = JSON.stringify({ error: { code, message, next }, dataVersion: version }, null, 2);
  return new Response(`${body}\n`, { status, headers: headers(version, cacheControl) });
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

type Route =
  | { readonly kind: "health" }
  | { readonly kind: "object"; readonly key: string; readonly what: string }
  | { readonly kind: "audio-misroute"; readonly path: string; readonly hint: string }
  | { readonly kind: "none" };

/** Percent-decode one path segment. Malformed input is a 400, never a guess. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Path -> R2 key. Pure, total, and query-string-blind by construction: it takes
 * a pathname, not a URL.
 *
 *   /health                  liveness
 *   /v1/w/<word>             prebuilt per-word record  -> v1/w/<word>.json
 *   /v1/w/<word>.json        the same object, explicit
 *   /v1/packs                the pack catalogue        -> v1/packs/index.json
 *   /v1/packs/<slug>         one pack                  -> v1/packs/<slug>.json
 */
export function route(pathname: string): Route {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (path === "/health" || path === "/v1/health") return { kind: "health" };

  if (path === "/v1/packs") return { kind: "object", key: "v1/packs/index.json", what: "the pack catalogue" };

  if (path.startsWith("/v1/packs/")) {
    const slug = decodeSegment(path.slice("/v1/packs/".length));
    if (slug === null || slug.length === 0 || slug.includes("/")) return { kind: "none" };
    const clean = slug.endsWith(".json") ? slug.slice(0, -".json".length) : slug;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(clean)) return { kind: "none" };
    return { kind: "object", key: `v1/packs/${clean}.json`, what: `pack "${clean}"` };
  }

  if (path.startsWith("/v1/w/")) {
    const raw = path.slice("/v1/w/".length);
    // Checked before the single-segment rule, because the likeliest misroute is
    // a full audio path (/v1/w/amy/你好.mp3) aimed at the API host.
    if (path.endsWith(".mp3")) {
      const hint = raw.includes("/") ? path : `/v1/w/amy/${raw}`;
      return { kind: "audio-misroute", path, hint };
    }
    if (raw.includes("/")) return { kind: "none" };
    const decoded = decodeSegment(raw);
    if (decoded === null || decoded.length === 0) return { kind: "none" };
    const word = decoded.endsWith(".json") ? decoded.slice(0, -".json".length) : decoded;
    if (word.length === 0) return { kind: "none" };
    return { kind: "object", key: `v1/w/${word}.json`, what: `word "${word}"` };
  }

  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

async function handle(request: Request, env: Env): Promise<Response> {
  const version = env.DATA_VERSION ?? DEFAULT_DATA_VERSION;
  const audioHost = env.AUDIO_HOST ?? DEFAULT_AUDIO_HOST;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(version, CACHE_NEVER, { "access-control-max-age": "86400" }) });
  }

  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(
      405,
      "method_not_allowed",
      `${method} is not supported. Zhongdex is read-only: nothing here writes, bills, or synthesises.`,
      ["GET /v1/w/<word>", "GET /v1/packs", "GET /health"],
      version,
      CACHE_NEVER,
    );
  }

  // Query string is intentionally never read. See the header comment.
  const pathname = new URL(request.url).pathname;

  if (pathname.length > MAX_PATH_LENGTH) {
    return errorResponse(
      414,
      "path_too_long",
      `Path is ${String(pathname.length)} characters; the limit is ${String(MAX_PATH_LENGTH)}. ` +
        `No Zhongdex key is longer than 57 characters, so this is a scan, not a lookup.`,
      ["GET /v1/packs"],
      version,
      CACHE_MISS,
    );
  }

  const target = route(pathname);

  if (target.kind === "health") {
    const body = JSON.stringify(
      { status: "ok", service: "zhongdex-api", dataVersion: version, readOnly: true, audioHost },
      null,
      2,
    );
    return new Response(`${body}\n`, { status: 200, headers: headers(version, CACHE_NEVER) });
  }

  if (target.kind === "audio-misroute") {
    return errorResponse(
      404,
      "audio_not_on_this_host",
      `Audio is not served from the API host. Clips are static objects on https://${audioHost} and the URL is ` +
        `constructible with no tool call: https://${audioHost}/v1/w/<voice>/<word>.mp3 (voices amy, james; ` +
        `insert .slow before .mp3 for a 0.7x reading).`,
      [`GET https://${audioHost}${target.hint}`, "GET /v1/w/<word>"],
      version,
      CACHE_MISS,
    );
  }

  if (target.kind === "none") {
    return errorResponse(
      404,
      "no_such_route",
      `No route for "${pathname}". This API has three: /v1/w/<word>, /v1/packs[/<slug>], /health.`,
      ["GET /v1/packs", "GET /health"],
      version,
      CACHE_MISS,
    );
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  const object = await env.CORPUS.get(
    target.key,
    ifNoneMatch === null ? undefined : { onlyIf: { etagDoesNotMatch: ifNoneMatch } },
  );

  if (object === null) {
    return errorResponse(
      404,
      "not_found",
      `No record for ${target.what}. Zhongdex covers the HSK 3.0 (2026) list only; a word outside it is a miss, ` +
        `not an error. Lists and pack membership are enumerable.`,
      ["GET /v1/packs", "GET /v1/packs/hsk-2026-t1"],
      version,
      CACHE_MISS,
    );
  }

  const out = headers(version, CACHE_HIT, { etag: object.httpEtag });
  object.writeHttpMetadata(out);
  // R2 stores the object's own content-type; ours is authoritative for the API.
  out.set("content-type", "application/json; charset=utf-8");
  out.set("cache-control", CACHE_HIT);

  // A conditional GET that matched returns an R2Object with no body.
  if (!("body" in object)) return new Response(null, { status: 304, headers: out });
  if (method === "HEAD") return new Response(null, { status: 200, headers: out });

  return new Response((object as R2ObjectBody).body, { status: 200, headers: out });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (cause) {
      // A generic 5xx is a contract violation (SLO: zero generic 5xx in a
      // monthly 200-call sample). Name what failed and what still works.
      const version = env.DATA_VERSION ?? DEFAULT_DATA_VERSION;
      const detail = cause instanceof Error ? cause.message : String(cause);
      return errorResponse(
        503,
        "storage_unavailable",
        `The object store did not answer (${detail}). Data is static and mirrored: the same corpus is on Hugging ` +
          `Face and GitHub Releases, and audio is on a separate host that does not depend on this Worker.`,
        ["GET /health", "retry in 30s"],
        version,
        CACHE_NEVER,
      );
    }
  },
};
