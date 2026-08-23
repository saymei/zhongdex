/**
 * Zhongdex adoption metrics collector.
 *
 * Pulls every public number that indicates whether this project is working, writes a
 * dated snapshot, and prints a table. Designed to run unattended in CI on a daily cron
 * so the snapshots accumulate into a time series inside the repo.
 *
 * Every source is optional and failure is never fatal: a source that is unreachable, or
 * that does not exist yet because we have not published there, is recorded as `null` with
 * a reason. A zero and a "not published yet" are different facts and the dashboard must
 * not conflate them.
 *
 *   npm run metrics              # collect and print
 *   npm run metrics -- --write   # also write metrics/<date>.json and metrics/latest.json
 */

import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_OWNER = process.env.ZHONGDEX_REPO_OWNER ?? "saymei";
const REPO_NAME = process.env.ZHONGDEX_REPO_NAME ?? "zhongdex";
const NPM_PACKAGE = "zhongdex";
const HF_DATASET = process.env.ZHONGDEX_HF_DATASET ?? "saymei/zhongdex";
const METRICS_DIR = "metrics";

/** A single measurement. `value: null` means "could not measure", never "zero". */
export type Metric = {
  key: string;
  label: string;
  value: number | null;
  /** Why the value is null. Absent when the measurement succeeded. */
  unavailable?: string;
  /** Where the number came from, so a surprising figure can be traced. */
  source: string;
};

export type Snapshot = {
  schemaVersion: 1;
  collectedAt: string;
  metrics: Metric[];
};

type FetchResult<T> = { ok: true; data: T } | { ok: false; reason: string };

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<FetchResult<T>> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "zhongdex-metrics", accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { ok: false, reason: "not published yet (404)" };
    if (res.status === 403) return { ok: false, reason: "rate limited or forbidden (403)" };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.includes("timeout") ? "timed out" : msg };
  }
}

function ghHeaders(): Record<string, string> {
  // GitHub's traffic endpoints (clones, views) require push access. Without a token we
  // still get stars and forks; we just report the traffic metrics as unavailable.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function collectGithub(): Promise<Metric[]> {
  const base = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
  const source = `github.com/${REPO_OWNER}/${REPO_NAME}`;
  const out: Metric[] = [];

  const repo = await getJson<{ stargazers_count: number; forks_count: number; subscribers_count: number; open_issues_count: number }>(base, ghHeaders());
  if (repo.ok) {
    out.push({ key: "github.stars", label: "GitHub stars", value: repo.data.stargazers_count, source });
    out.push({ key: "github.forks", label: "GitHub forks", value: repo.data.forks_count, source });
    out.push({ key: "github.watchers", label: "GitHub watchers", value: repo.data.subscribers_count, source });
    out.push({ key: "github.open_issues", label: "Open issues + PRs", value: repo.data.open_issues_count, source });
  } else {
    for (const [key, label] of [
      ["github.stars", "GitHub stars"],
      ["github.forks", "GitHub forks"],
      ["github.watchers", "GitHub watchers"],
      ["github.open_issues", "Open issues + PRs"],
    ] as const) {
      out.push({ key, label, value: null, unavailable: repo.reason, source });
    }
  }

  // Traffic: 14-day rolling windows. Needs a token with push access.
  const clones = await getJson<{ count: number; uniques: number }>(`${base}/traffic/clones`, ghHeaders());
  out.push(
    clones.ok
      ? { key: "github.clones_14d", label: "Clones (14d)", value: clones.data.count, source }
      : { key: "github.clones_14d", label: "Clones (14d)", value: null, unavailable: clones.reason, source },
  );
  const views = await getJson<{ count: number; uniques: number }>(`${base}/traffic/views`, ghHeaders());
  out.push(
    views.ok
      ? { key: "github.views_14d", label: "Repo views (14d)", value: views.data.count, source }
      : { key: "github.views_14d", label: "Repo views (14d)", value: null, unavailable: views.reason, source },
  );

  // Release asset downloads — the Anki decks ship this way, so this is the deck-download number.
  const releases = await getJson<Array<{ assets: Array<{ download_count: number }> }>>(`${base}/releases?per_page=100`, ghHeaders());
  out.push(
    releases.ok
      ? {
          key: "github.release_downloads",
          label: "Release asset downloads",
          value: releases.data.reduce((sum, r) => sum + r.assets.reduce((s, a) => s + a.download_count, 0), 0),
          source,
        }
      : { key: "github.release_downloads", label: "Release asset downloads", value: null, unavailable: releases.reason, source },
  );

  return out;
}

async function collectNpm(): Promise<Metric[]> {
  const source = `npmjs.com/package/${NPM_PACKAGE}`;
  const res = await getJson<{ downloads: number }>(`https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`);
  return [
    res.ok
      ? { key: "npm.downloads_7d", label: "npm downloads (7d)", value: res.data.downloads, source }
      : { key: "npm.downloads_7d", label: "npm downloads (7d)", value: null, unavailable: res.reason, source },
  ];
}

async function collectHuggingFace(): Promise<Metric[]> {
  const source = `huggingface.co/datasets/${HF_DATASET}`;
  const res = await getJson<{ downloads?: number; likes?: number }>(`https://huggingface.co/api/datasets/${HF_DATASET}`);
  if (!res.ok) {
    return [
      { key: "hf.downloads_30d", label: "HF downloads (30d)", value: null, unavailable: res.reason, source },
      { key: "hf.likes", label: "HF likes", value: null, unavailable: res.reason, source },
    ];
  }
  return [
    { key: "hf.downloads_30d", label: "HF downloads (30d)", value: res.data.downloads ?? 0, source },
    { key: "hf.likes", label: "HF likes", value: res.data.likes ?? 0, source },
  ];
}

export async function collect(): Promise<Snapshot> {
  const groups = await Promise.all([collectGithub(), collectNpm(), collectHuggingFace()]);
  return {
    schemaVersion: 1,
    // Collection time is genuinely variable data, so it belongs in the snapshot even
    // though the build artifacts elsewhere in this repo are deliberately timestamp-free.
    collectedAt: new Date().toISOString(),
    metrics: groups.flat(),
  };
}

function renderTable(snap: Snapshot, previous: Snapshot | null): string {
  const prev = new Map((previous?.metrics ?? []).map((m) => [m.key, m.value]));
  const width = Math.max(...snap.metrics.map((m) => m.label.length));
  const lines = snap.metrics.map((m) => {
    if (m.value === null) return `  ${m.label.padEnd(width)}   —  (${m.unavailable})`;
    const before = prev.get(m.key);
    const delta = typeof before === "number" ? m.value - before : null;
    const arrow = delta === null || delta === 0 ? "" : delta > 0 ? `  +${delta}` : `  ${delta}`;
    return `  ${m.label.padEnd(width)}   ${String(m.value).padStart(6)}${arrow}`;
  });
  return lines.join("\n");
}

async function loadPrevious(): Promise<Snapshot | null> {
  try {
    const files = (await readdir(METRICS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const last = files.at(-1);
    if (!last) return null;
    return JSON.parse(await readFile(join(METRICS_DIR, last), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const previous = await loadPrevious();
  const snap = await collect();

  console.log(`\nZhongdex metrics — ${snap.collectedAt.slice(0, 16).replace("T", " ")} UTC\n`);
  console.log(renderTable(snap, previous));

  const measured = snap.metrics.filter((m) => m.value !== null).length;
  console.log(`\n  ${measured}/${snap.metrics.length} sources reporting.`);
  if (measured < snap.metrics.length) {
    console.log("  Unreported sources are ones we have not published to yet, or that need a token.");
  }

  if (process.argv.includes("--write")) {
    await mkdir(METRICS_DIR, { recursive: true });
    const day = snap.collectedAt.slice(0, 10);
    await writeFile(join(METRICS_DIR, `${day}.json`), JSON.stringify(snap, null, 2) + "\n");
    await writeFile(join(METRICS_DIR, "latest.json"), JSON.stringify(snap, null, 2) + "\n");
    console.log(`  Wrote ${METRICS_DIR}/${day}.json and ${METRICS_DIR}/latest.json`);
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error("[metrics] collection failed:", err);
  process.exit(1);
});
