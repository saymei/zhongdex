/**
 * Renders the collected metrics into a standalone HTML dashboard.
 *
 *   npm run metrics -- --write     # collect a snapshot first
 *   npm run dashboard              # render metrics/dashboard.html from the snapshots
 *
 * Reads every metrics/<date>.json in the repo so the sparklines show real history rather
 * than a single point. Self-contained output: no external requests, works offline, and
 * respects the reader's colour scheme.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metric, Snapshot } from "./collect.ts";

const METRICS_DIR = "metrics";
const OUT = join(METRICS_DIR, "dashboard.html");

/** Targets from the program plan, so a number can be read against its expectation. */
const YEAR_ONE_TARGETS: Record<string, { base: number; note: string }> = {
  "github.stars": { base: 900, note: "300–900 over 18–24 months (Jitendex did 523)" },
  "github.forks": { base: 150, note: "40–150 if the fork template lands" },
  "npm.downloads_7d": { base: 500, note: "500/week base case" },
  "hf.downloads_30d": { base: 1500, note: "500–3,000 in year one" },
  "github.release_downloads": { base: 5000, note: "1,500–5,000 Anki deck downloads" },
};

async function loadSnapshots(): Promise<Snapshot[]> {
  let files: string[];
  try {
    files = (await readdir(METRICS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: Snapshot[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(METRICS_DIR, f), "utf8")) as Snapshot);
    } catch {
      // A corrupt snapshot should not take the dashboard down.
    }
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Inline sparkline. Returns empty string when there is not enough history to be honest about a trend. */
function sparkline(values: Array<number | null>): string {
  const pts = values.filter((v): v is number => v !== null);
  if (pts.length < 2) return "";
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 80;
  const h = 20;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function card(m: Metric, history: Array<number | null>, previous: number | null): string {
  const target = YEAR_ONE_TARGETS[m.key];

  if (m.value === null) {
    return `<div class="card pending">
      <div class="k">${esc(m.label)}</div>
      <div class="v">—</div>
      <div class="s">${esc(m.unavailable ?? "unavailable")}</div>
    </div>`;
  }

  const delta = previous === null ? null : m.value - previous;
  const deltaHtml =
    delta === null || delta === 0
      ? ""
      : `<span class="d ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : ""}${delta}</span>`;

  const pct = target ? Math.min(100, Math.round((m.value / target.base) * 100)) : null;
  const bar =
    pct === null
      ? ""
      : `<div class="bar" role="img" aria-label="${pct}% of year-one base case"><i style="width:${pct}%"></i></div>
         <div class="s">${pct}% of base case · ${esc(target!.note)}</div>`;

  return `<div class="card">
    <div class="k">${esc(m.label)}</div>
    <div class="v">${m.value.toLocaleString("en-US")}${deltaHtml}${sparkline(history)}</div>
    ${bar || `<div class="s">${esc(m.source)}</div>`}
  </div>`;
}

export function render(snapshots: Snapshot[]): string {
  const latest = snapshots.at(-1);
  const previous = snapshots.at(-2) ?? null;

  if (!latest) {
    return `<meta charset="utf-8"><title>Zhongdex Metrics</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6}</style>
<h1>Zhongdex Metrics</h1>
<p>No snapshots yet. Run <code>npm run metrics -- --write</code> to collect the first one.</p>`;
  }

  const prevMap = new Map((previous?.metrics ?? []).map((m) => [m.key, m.value]));
  const histories = new Map<string, Array<number | null>>();
  for (const m of latest.metrics) {
    histories.set(
      m.key,
      snapshots.map((s) => s.metrics.find((x) => x.key === m.key)?.value ?? null),
    );
  }

  const reporting = latest.metrics.filter((m) => m.value !== null).length;

  return `<meta charset="utf-8">
<title>Zhongdex Metrics</title>
<style>
:root{--bg:#F4F7F6;--card:#fff;--ink:#101718;--ink2:#3C4A4B;--ink3:#6A7A7A;--rule:#D9E2E0;--accent:#0B6E6B;--up:#2F6B3C;--down:#9E3D26}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0C1214;--card:#121A1C;--ink:#DEE7E5;--ink2:#AEBCBA;--ink3:#7E8E8C;--rule:#233033;--accent:#43BDB2;--up:#72BE84;--down:#E58666}}
:root[data-theme=dark]{--bg:#0C1214;--card:#121A1C;--ink:#DEE7E5;--ink2:#AEBCBA;--ink3:#7E8E8C;--rule:#233033;--accent:#43BDB2;--up:#72BE84;--down:#E58666}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.55}
.wrap{max-width:60rem;margin:0 auto;padding:clamp(1.5rem,4vw,3rem)}
h1{font-size:clamp(1.6rem,4vw,2.2rem);margin:0 0 .3rem;letter-spacing:-.02em}
.sub{color:var(--ink2);margin:0 0 2rem;font-size:.95rem}
.grid{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:6px;overflow:hidden;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.card{background:var(--card);padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.3rem;min-height:7rem}
.card.pending{opacity:.62}
.k{font-size:.78rem;color:var(--ink2);font-weight:600;letter-spacing:.01em}
.v{font-size:1.85rem;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.s{font-size:.72rem;color:var(--ink3)}
.d{font-size:.8rem;font-weight:600}.d.up{color:var(--up)}.d.down{color:var(--down)}
.spark{color:var(--accent);opacity:.8;margin-left:auto}
.bar{height:4px;background:var(--rule);border-radius:2px;overflow:hidden;margin-top:.2rem}
.bar i{display:block;height:100%;background:var(--accent)}
footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--ink3);font-size:.78rem}
code{font-family:ui-monospace,monospace;font-size:.9em}
</style>
<div class="wrap">
  <h1>Zhongdex Metrics</h1>
  <p class="sub">${esc(latest.collectedAt.slice(0, 16).replace("T", " "))} UTC · ${reporting}/${latest.metrics.length} sources reporting · ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} of history</p>
  <div class="grid">
    ${latest.metrics.map((m) => card(m, histories.get(m.key) ?? [], prevMap.get(m.key) ?? null)).join("\n    ")}
  </div>
  <footer>
    A dash means the source could not be measured &mdash; usually because we have not published there yet.
    That is deliberately distinct from a measured zero.
    Refresh with <code>npm run metrics -- --write &amp;&amp; npm run dashboard</code>.
  </footer>
</div>`;
}

async function main(): Promise<void> {
  const snapshots = await loadSnapshots();
  await writeFile(OUT, render(snapshots));
  console.log(`Wrote ${OUT} from ${snapshots.length} snapshot(s).`);
}

main().catch((err: unknown) => {
  console.error("[dashboard] render failed:", err);
  process.exit(1);
});
