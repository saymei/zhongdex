/**
 * `npm run build:packs` — compute the Zhongdex card packs from the canon.
 *
 * Input:  data/hsk_bands.json   (produced by `npm run build:canon`)
 * Output: data/packs/<slug>.json
 *         data/packs/index.json
 *         data/pack-stats.json
 *
 * Guarantees:
 *  - Deterministic. Sorted everywhere, no timestamps, no locale-dependent
 *    comparisons. Two consecutive runs are byte-identical.
 *  - Band closure is MEASURED and asserted, never assumed. A pack that claims
 *    a level and fails closure does not ship; it is recorded as deferred.
 *  - A pack whose query needs a column the canon does not have is deferred
 *    with the reason, not filled with invented data.
 *  - No network, no LLM. Node builtins only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PackDef } from "./pack-defs.js";
import { PACK_DEFS } from "./pack-defs.js";
import type {
  CanonCapability,
  CanonWord,
  DeferredPack,
  Pack,
  PackAudioCompleteness,
  PackBandClosure,
  PackCoverage,
  PackIndex,
  PackIndexEntry,
  PackStats,
} from "./pack-schema.js";
import {
  BAND_SCHEME,
  compareIds,
  computeDigest,
  CORPUS_VERSION,
  MIN_PACK_SIZE,
  PACK_SCHEMA_VERSION,
  PACK_VERSION,
  validatePack,
} from "./pack-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CANON_PATH = join(ROOT, "data", "hsk_bands.json");
const PACK_DIR = join(ROOT, "data", "packs");
const INDEX_PATH = join(PACK_DIR, "index.json");
const STATS_PATH = join(ROOT, "data", "pack-stats.json");

const LICENCE = {
  data: "CC-BY-SA-4.0",
  attribution: "SayMei Zhongdex — https://saymei.app/dex",
} as const;

/* -------------------------------------------------------------------------- */
/* Canon loading                                                               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadCanonRaw(): Record<string, unknown>[] {
  if (!existsSync(CANON_PATH)) {
    process.stdout.write(`canon missing at ${CANON_PATH} — running build:canon\n`);
    const result = spawnSync("npm", ["run", "build:canon"], { cwd: ROOT, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(
        `data/hsk_bands.json is missing and \`npm run build:canon\` failed ` +
          `(exit ${String(result.status)}). Build the canon first.`,
      );
    }
  }
  if (!existsSync(CANON_PATH)) {
    throw new Error(`\`npm run build:canon\` ran but did not produce ${CANON_PATH}.`);
  }

  const parsed: unknown = JSON.parse(readFileSync(CANON_PATH, "utf8"));
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["words"])
      ? parsed["words"]
      : null;
  if (!Array.isArray(rows)) {
    throw new Error(
      `${CANON_PATH} is neither an array of words nor an object with a "words" array.`,
    );
  }
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new Error("canon contains a non-object record");
    out.push(row);
  }
  if (out.length === 0) throw new Error("canon is empty");
  return out;
}

function readString(row: Record<string, unknown>, key: string, where: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`${where}: "${key}" is not a string`);
  return value;
}

/** Accepts an array of strings, or a bare string, which is treated as one entry. */
function readStringArray(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readNumberOrNull(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCanon(rows: readonly Record<string, unknown>[]): CanonWord[] {
  const words: CanonWord[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const id = readString(row, "id", "canon record");
    if (seen.has(id)) throw new Error(`canon contains duplicate word id "${id}"`);
    seen.add(id);

    const hskRaw = row["hsk"];
    if (!isRecord(hskRaw)) throw new Error(`canon record ${id}: "hsk" is not an object`);
    const band2026 = readNumberOrNull(hskRaw, "band2026");
    if (band2026 === null) throw new Error(`canon record ${id}: hsk.band2026 is not a number`);

    const pinyinRaw = row["pinyin"];
    const pinyin = isRecord(pinyinRaw)
      ? {
          marked: typeof pinyinRaw["marked"] === "string" ? pinyinRaw["marked"] : "",
          numbered: typeof pinyinRaw["numbered"] === "string" ? pinyinRaw["numbered"] : "",
        }
      : { marked: "", numbered: "" };

    const audioRaw = row["audio"];
    const audio = isRecord(audioRaw)
      ? {
          female: typeof audioRaw["female"] === "string" ? audioRaw["female"] : null,
          male: typeof audioRaw["male"] === "string" ? audioRaw["male"] : null,
          status: typeof audioRaw["status"] === "string" ? audioRaw["status"] : "pending",
        }
      : { female: null, male: null, status: "pending" };

    const bandRange = hskRaw["bandRange"];

    words.push({
      id,
      simplified: typeof row["simplified"] === "string" ? row["simplified"] : "",
      traditional: typeof row["traditional"] === "string" ? row["traditional"] : "",
      pinyin,
      pos: readStringArray(row, "pos"),
      hsk: {
        band2026,
        ...(typeof bandRange === "string" ? { bandRange } : {}),
        band2021: readNumberOrNull(hskRaw, "band2021"),
        listId: typeof hskRaw["listId"] === "string" ? hskRaw["listId"] : "",
      },
      definitions: Array.isArray(row["definitions"]) ? row["definitions"] : [],
      audio,
      frequencyRank: readNumberOrNull(row, "frequencyRank"),
      zipf: readNumberOrNull(row, "zipf"),
      radical: typeof row["radical"] === "string" ? row["radical"] : null,
    });
  }

  words.sort((a, b) => compareIds(a.id, b.id));
  return words;
}

/* -------------------------------------------------------------------------- */
/* Capability probe                                                            */
/* -------------------------------------------------------------------------- */

/** What the loaded canon can actually answer. Drives deferral. */
function probeCapabilities(
  words: readonly CanonWord[],
  raw: readonly Record<string, unknown>[],
): Set<CanonCapability> {
  const caps = new Set<CanonCapability>();

  if (words.every((w) => Number.isFinite(w.hsk.band2026))) caps.add("hsk.band2026");
  if (words.some((w) => w.hsk.band2021 !== null)) caps.add("hsk.band2021");
  if (words.some((w) => w.pos.length > 0)) caps.add("pos");
  if (words.some((w) => typeof w.frequencyRank === "number")) caps.add("frequencyRank");
  if (words.some((w) => typeof w.zipf === "number")) caps.add("zipf");
  if (words.some((w) => typeof w.radical === "string" && w.radical.length > 0)) caps.add("radical");
  if (words.some((w) => w.audio.female !== null || w.audio.male !== null)) caps.add("audio");

  // HSK 2.0 has no field in the documented canon shape; probe the raw rows so a
  // canon that later adds it lights the pack up with no code change here.
  const has2_0 = raw.some((row) => {
    const hsk = row["hsk"];
    if (!isRecord(hsk)) return false;
    for (const key of ["band2_0", "band20", "hsk2_0", "band_2_0"]) {
      const v = hsk[key];
      if (typeof v === "number" && Number.isFinite(v)) return true;
    }
    return false;
  });
  if (has2_0) caps.add("hsk.band2_0");

  return caps;
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function measureClosure(def: PackDef, words: readonly CanonWord[]): PackBandClosure {
  let over = 0;
  let under = 0;
  let offList = 0;
  let observedMin: number | null = null;
  let observedMax: number | null = null;

  for (const w of words) {
    const band = w.hsk.band2026;
    if (!Number.isFinite(band)) {
      offList += 1;
      continue;
    }
    observedMin = observedMin === null ? band : Math.min(observedMin, band);
    observedMax = observedMax === null ? band : Math.max(observedMax, band);
    if (def.closure !== null) {
      if (band > def.closure.max) over += 1;
      if (band < def.closure.min) under += 1;
    }
  }

  return {
    scheme: BAND_SCHEME,
    claimedMinBand: def.closure?.min ?? null,
    claimedMaxBand: def.closure?.max ?? null,
    observedMinBand: observedMin,
    observedMaxBand: observedMax,
    overBand: over,
    underBand: under,
    offList,
    closed: def.closure !== null && over === 0 && under === 0 && offList === 0,
  };
}

function measureAudio(words: readonly CanonWord[]): PackAudioCompleteness {
  const n = words.length;
  let female = 0;
  let male = 0;
  let pending = 0;
  for (const w of words) {
    if (w.audio.female !== null) female += 1;
    if (w.audio.male !== null) male += 1;
    if (w.audio.status === "pending") pending += 1;
  }
  const f = n === 0 ? 0 : round4(female / n);
  const m = n === 0 ? 0 : round4(male / n);
  const status: PackAudioCompleteness["status"] =
    f === 1 && m === 1 ? "complete" : f === 0 && m === 0 ? "pending" : "partial";
  return { female: f, male: m, pending: n === 0 ? 0 : round4(pending / n), status };
}

function measureCoverage(words: readonly CanonWord[]): PackCoverage {
  const n = words.length;
  const frac = (count: number): number => (n === 0 ? 0 : round4(count / n));
  return {
    bandLabelled: frac(words.filter((w) => Number.isFinite(w.hsk.band2026)).length),
    band2021Labelled: frac(words.filter((w) => w.hsk.band2021 !== null).length),
    posLabelled: frac(words.filter((w) => w.pos.length > 0).length),
    defined: frac(words.filter((w) => w.definitions.length > 0).length),
    frequencyRanked: frac(words.filter((w) => typeof w.frequencyRank === "number").length),
    // No sense index exists in the v1 canon; claiming otherwise would be a lie.
    senseDisambiguated: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

function buildPack(def: PackDef, selected: readonly CanonWord[]): Pack {
  const ids = selected.map((w) => w.id).sort(compareIds);
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    id: `dex:p:${def.slug}`,
    slug: def.slug,
    kind: def.kind,
    itemType: "word",
    title: def.title,
    oneLiner: def.oneLiner,
    description: def.description,
    rationale: def.rationale,
    level: {
      scheme: BAND_SCHEME,
      band: def.bandClaim,
      bandRange: def.bandRange,
      cumulative: def.cumulative,
    },
    size: ids.length,
    tags: def.tags,
    source: def.source,
    selection: {
      query: def.query,
      order: "word id asc",
      deterministic: true,
      seedSource: null,
    },
    bandClosure: measureClosure(def, selected),
    provenance: {
      words: def.source,
      columns: def.columns,
      rule: def.rule,
      curationSource: null,
      corpus: `zhongdex canon ${CORPUS_VERSION} (data/hsk_bands.json)`,
      bands: "HSK 3.0 (2026) official word list, effective 1 July 2026",
      definitions: "carried by the canon; not duplicated into this pack",
      audio: "pending — no clips published for this corpus version yet",
      copy: "hand-written build metadata; no model-written text in tranche 1",
    },
    licence: LICENCE,
    audioCompleteness: measureAudio(selected),
    coverage: measureCoverage(selected),
    version: PACK_VERSION,
    corpusVersion: CORPUS_VERSION,
    digest: computeDigest(ids),
    words: ids,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main(): void {
  const raw = loadCanonRaw();
  const canon = parseCanon(raw);
  const caps = probeCapabilities(canon, raw);

  process.stdout.write(
    `canon: ${String(canon.length)} words · capabilities: ${[...caps].sort().join(", ")}\n`,
  );

  const shipped: Pack[] = [];
  const deferred: DeferredPack[] = [];

  const seenSlugs = new Set<string>();
  for (const def of PACK_DEFS) {
    if (seenSlugs.has(def.slug)) throw new Error(`duplicate pack slug "${def.slug}"`);
    seenSlugs.add(def.slug);

    const missing = def.requires.filter((cap) => !caps.has(cap));
    if (missing.length > 0) {
      deferred.push({
        id: `dex:p:${def.slug}`,
        slug: def.slug,
        title: def.title,
        kind: def.kind,
        reason: `canon does not provide the column(s) this query needs: ${missing.join(", ")}`,
        missing: [...missing],
      });
      continue;
    }

    const selected = canon.filter((w) => def.select(w));
    if (selected.length < MIN_PACK_SIZE) {
      deferred.push({
        id: `dex:p:${def.slug}`,
        slug: def.slug,
        title: def.title,
        kind: def.kind,
        reason: `query selected ${String(selected.length)} words, below the minimum pack size of ${String(MIN_PACK_SIZE)}`,
        missing: [],
      });
      continue;
    }

    const pack = buildPack(def, selected);
    const errors = validatePack(pack);
    if (errors.length > 0) {
      deferred.push({
        id: pack.id,
        slug: pack.slug,
        title: pack.title,
        kind: pack.kind,
        reason: `failed the pack gate: ${errors.join("; ")}`,
        missing: [],
      });
      continue;
    }
    shipped.push(pack);
  }

  shipped.sort((a, b) => compareIds(a.slug, b.slug));
  deferred.sort((a, b) => compareIds(a.slug, b.slug));

  // Rewrite the pack directory from scratch so a removed pack cannot linger.
  mkdirSync(PACK_DIR, { recursive: true });
  for (const entry of readdirSync(PACK_DIR)) {
    if (entry.endsWith(".json")) rmSync(join(PACK_DIR, entry));
  }

  const indexEntries: PackIndexEntry[] = [];
  for (const pack of shipped) {
    // Filename is the slug, not the namespaced id: `dex:p:*` contains colons,
    // which are not portable filenames. Both forms are in index.json.
    const file = `${pack.slug}.json`;
    writeJson(join(PACK_DIR, file), pack);
    indexEntries.push({
      id: pack.id,
      slug: pack.slug,
      file,
      kind: pack.kind,
      title: pack.title,
      description: pack.description,
      level: pack.level,
      size: pack.size,
      tags: pack.tags,
      source: pack.source,
      digest: pack.digest,
    });
  }

  const index: PackIndex = {
    schemaVersion: PACK_SCHEMA_VERSION,
    corpusVersion: CORPUS_VERSION,
    version: PACK_VERSION,
    count: indexEntries.length,
    packs: indexEntries,
  };
  writeJson(INDEX_PATH, index);

  const totalSlots = shipped.reduce((sum, p) => sum + p.size, 0);
  const overallFemale =
    totalSlots === 0
      ? 0
      : round4(shipped.reduce((s, p) => s + p.audioCompleteness.female * p.size, 0) / totalSlots);
  const overallMale =
    totalSlots === 0
      ? 0
      : round4(shipped.reduce((s, p) => s + p.audioCompleteness.male * p.size, 0) / totalSlots);

  const stats: PackStats = {
    schemaVersion: PACK_SCHEMA_VERSION,
    corpusVersion: CORPUS_VERSION,
    version: PACK_VERSION,
    canonWords: canon.length,
    packCount: shipped.length,
    totalSlots,
    audio: {
      overallFemale,
      overallMale,
      note:
        "Every clip is still pending for this corpus version. The 100% word-audio " +
        "publish gate is reported but non-blocking until audio ships.",
    },
    packs: shipped.map((p) => ({
      id: p.id,
      slug: p.slug,
      size: p.size,
      digest: p.digest,
      bandClosed: p.bandClosure.closed,
      audioCompleteness: p.audioCompleteness,
    })),
    deferred,
  };
  writeJson(STATS_PATH, stats);

  process.stdout.write(
    `packs: ${String(shipped.length)} shipped · ${String(deferred.length)} deferred · ` +
      `${String(totalSlots)} word slots\n`,
  );
  for (const pack of shipped) {
    process.stdout.write(
      `  ${pack.slug.padEnd(22)} ${String(pack.size).padStart(6)}  ` +
        `${pack.bandClosure.closed ? "band-closed" : "no band claim"}\n`,
    );
  }
  for (const d of deferred) {
    process.stdout.write(`  DEFERRED ${d.slug.padEnd(13)} ${d.reason}\n`);
  }
}

main();
