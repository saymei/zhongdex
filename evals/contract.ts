#!/usr/bin/env node
/**
 * Tier 0 — the contract eval.
 *
 * No LLM. No network. No dependencies beyond Node builtins. Runs on every PR
 * and finishes in about a second, because a check that is slow or flaky stops
 * being run and then stops being true.
 *
 * It asserts the promises Zhongdex makes to anyone who downloads the data:
 *
 *   C1  every canon record has a stable, well-formed, non-colliding id
 *   C2  the band counts match the pinned source split, exactly
 *   C3  no record anywhere emits an audio URL, and nothing claims to be hosted
 *   C4  the pack set loads and is structurally sound
 *   C5  no pack references a word id that is absent from the canon
 *   C6  every pack digest recomputes from its own word list
 *   C7  every pack claiming a level is genuinely band-closed at that level
 *   C8  the pack catalogue and stats agree with the pack files on disk
 *
 * The digest and the band closure are recomputed here from first principles
 * rather than imported from src/build. An eval that reuses the implementation
 * it is checking proves only that the implementation is self-consistent.
 *
 * Usage:  npm run eval:contract   (run `npm run build` first on a fresh clone)
 * Exit:   0 = every check passed · 1 = failures, listed · 2 = could not run
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* The contract constants                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The HSK 3.0 (2026) split of the pinned source list (scripts/hsk30.csv).
 * Hard-coded on purpose: if an upstream refresh moves these, CI fails loudly
 * instead of the corpus silently changing shape under everyone downstream.
 */
const EXPECTED_BAND_COUNTS: ReadonlyArray<readonly [band: number, count: number]> = [
  [1, 500],
  [2, 772],
  [3, 973],
  [4, 1000],
  [5, 1071],
  [6, 1140],
  [7, 5636],
];

/** Band 7 is the combined 7-9 band of the syllabus; it is reported as such. */
const BAND_LABELS = new Map<number, string>([[7, "7-9"]]);

const EXPECTED_CANON_SIZE = EXPECTED_BAND_COUNTS.reduce((n, entry) => n + entry[1], 0);

/**
 * Ids are human-readable and namespaced, never UUIDs: `<ns>:<type>:<key…>`.
 * The documented namespace root is `dex` (plan §4.3, §12.1). One dataset must
 * carry exactly one root — a consumer that has to know which of two prefixes a
 * given id uses does not have stable ids.
 */
const DOCUMENTED_NAMESPACE = "dex";
const WORD_ID_SHAPE = /^[a-z][a-z0-9]*:w:[^\s:]+(?::[^\s:]+)+$/;
const PACK_ID_SHAPE = /^[a-z][a-z0-9]*:p:[^\s:]+$/;

/** How many offending examples to print per failed check before summarising. */
const MAX_EXAMPLES = 5;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANON_PATH = join(ROOT, "data", "hsk_bands.json");
const PACK_DIR = join(ROOT, "data", "packs");
const PACK_INDEX_PATH = join(PACK_DIR, "index.json");
const PACK_STATS_PATH = join(ROOT, "data", "pack-stats.json");

/* -------------------------------------------------------------------------- */
/* Failure collection                                                          */
/* -------------------------------------------------------------------------- */

interface Failure {
  readonly check: string;
  readonly detail: string;
}

const failures: Failure[] = [];
const passed: string[] = [];

function fail(check: string, detail: string): void {
  failures.push({ check, detail });
}

/** Report up to MAX_EXAMPLES offenders, then a count of the rest. */
function failMany(check: string, headline: string, offenders: readonly string[]): void {
  if (offenders.length === 0) return;
  fail(check, `${headline} (${String(offenders.length)})`);
  for (const offender of offenders.slice(0, MAX_EXAMPLES)) {
    failures.push({ check, detail: `    ${offender}` });
  }
  if (offenders.length > MAX_EXAMPLES) {
    failures.push({
      check,
      detail: `    … and ${String(offenders.length - MAX_EXAMPLES)} more`,
    });
  }
}

function pass(check: string, note: string): void {
  passed.push(`${check}  ${note}`);
}

/** Unrecoverable: the eval cannot run at all. Exit 2, not 1. */
function abort(message: string): never {
  process.stderr.write(`\ncontract eval could not run\n\n  ${message}\n\n`);
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Typed JSON access (noUncheckedIndexedAccess is on; nothing is assumed)      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function getString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function getNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getArray(source: Record<string, unknown>, key: string): unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    abort(`${label} could not be read at ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    abort(`${label} at ${path} is not valid JSON: ${String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

function requireBuild(): void {
  const missing: string[] = [];
  if (!existsSync(CANON_PATH)) missing.push("data/hsk_bands.json");
  if (!existsSync(PACK_DIR)) missing.push("data/packs/");
  if (missing.length > 0) {
    abort(
      `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.\n` +
        `  data/ is produced by the build. Both build inputs are vendored, so\n` +
        `  this needs no network and no configuration. Run:\n\n` +
        `      npm run build`,
    );
  }
}

/** The canon ships either as a bare array or as { words: [...] }. Accept both. */
function loadCanon(): Record<string, unknown>[] {
  const parsed = readJson(CANON_PATH, "the canon");
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed["words"]
      : null;
  if (!Array.isArray(rows)) {
    abort(`the canon at ${CANON_PATH} is neither an array nor an object with a "words" array.`);
  }
  const out: Record<string, unknown>[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) abort(`canon row ${String(index)} is not an object.`);
    out.push(row);
  }
  if (out.length === 0) abort("the canon is empty.");
  return out;
}

interface LoadedPack {
  readonly file: string;
  readonly body: Record<string, unknown>;
}

function loadPacks(): LoadedPack[] {
  const entries = readdirSync(PACK_DIR)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort();
  if (entries.length === 0) {
    abort(`no pack files in ${PACK_DIR}. Run \`npm run build\`.`);
  }
  const out: LoadedPack[] = [];
  for (const file of entries) {
    const parsed = readJson(join(PACK_DIR, file), `pack ${file}`);
    if (!isRecord(parsed)) abort(`pack ${file} is not a JSON object.`);
    out.push({ file, body: parsed });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Independent recomputation                                                   */
/* -------------------------------------------------------------------------- */

/** Code-unit order. Never localeCompare — its result depends on host ICU data. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** sha256 over the sorted, newline-joined word-id list. Recomputed, not imported. */
function computeDigest(wordIds: readonly string[]): string {
  const sorted = [...wordIds].sort(compareIds);
  return `sha256:${createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex")}`;
}

const AUDIO_EXTENSION = /\.(?:mp3|m4a|mp4|ogg|opus|wav|aac|flac|webm)(?:[?#].*)?$/i;

/**
 * A string that would send a consumer to fetch a clip. Any absolute URL with a
 * media extension counts, as does anything on an audio host. No record in this
 * release has any business emitting either, whatever its status.
 */
function looksLikeAudioUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  if (AUDIO_EXTENSION.test(value)) return true;
  return /^https?:\/\/audio\./i.test(value);
}

/** Walk any JSON value and report every audio-looking URL with its path. */
function findAudioUrls(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (looksLikeAudioUrl(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      findAudioUrls(item, `${path}[${String(index)}]`, out);
    }
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      findAudioUrls(value[key], `${path}.${key}`, out);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* C1 — canon ids                                                              */
/* -------------------------------------------------------------------------- */

function checkCanonIds(canon: readonly Record<string, unknown>[]): Map<string, number> {
  const check = "C1 canon ids";
  const bandOf = new Map<string, number>();

  const malformed: string[] = [];
  const collisions: string[] = [];
  const seen = new Set<string>();

  for (const [index, row] of canon.entries()) {
    const id = getString(row, "id");
    if (id === null || id.length === 0) {
      malformed.push(`row ${String(index)}: missing or non-string "id"`);
      continue;
    }
    if (!WORD_ID_SHAPE.test(id)) {
      malformed.push(`${JSON.stringify(id)}: not a namespaced word id (<ns>:w:<key>:<key>…)`);
    }
    if (seen.has(id)) {
      collisions.push(id);
      continue;
    }
    seen.add(id);

    const hsk = getRecord(row, "hsk");
    const band = hsk === null ? null : getNumber(hsk, "band2026");
    if (band === null) {
      malformed.push(`${id}: hsk.band2026 is missing or not a number`);
      continue;
    }
    bandOf.set(id, band);
  }

  failMany(check, "canon records with a malformed id or band", malformed);
  failMany(check, "colliding canon word ids", collisions);

  if (malformed.length === 0 && collisions.length === 0) {
    pass(check, `${String(canon.length)} records, all ids well-formed and unique`);
  }
  return bandOf;
}

/* -------------------------------------------------------------------------- */
/* C1b — one namespace                                                         */
/* -------------------------------------------------------------------------- */

/** The root of `zdx:w:ai4:爱:v` is `zdx`. */
function namespaceRoot(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(0, colon);
}

function checkIdNamespace(
  canon: readonly Record<string, unknown>[],
  packs: readonly LoadedPack[],
): void {
  const check = "C1b id namespace";
  const canonRoots = new Set<string>();
  const packRoots = new Set<string>();

  for (const row of canon) {
    const id = getString(row, "id");
    if (id !== null && id.length > 0) canonRoots.add(namespaceRoot(id));
  }
  for (const { body } of packs) {
    const id = getString(body, "id");
    if (id !== null && id.length > 0) packRoots.add(namespaceRoot(id));
    const words = getArray(body, "words");
    for (const word of words ?? []) {
      if (typeof word === "string" && word.length > 0) packRoots.add(namespaceRoot(word));
    }
  }

  const problems: string[] = [];
  const allRoots = new Set([...canonRoots, ...packRoots]);

  if (allRoots.size > 1) {
    problems.push(
      `the dataset uses ${String(allRoots.size)} id namespaces: ${[...allRoots].sort().join(", ")} — ` +
        `canon words use ${[...canonRoots].sort().join(", ")}, packs use ${[...packRoots].sort().join(", ")}`,
    );
  }
  for (const root of [...allRoots].sort()) {
    if (root !== DOCUMENTED_NAMESPACE) {
      problems.push(
        `namespace "${root}" is not the documented root "${DOCUMENTED_NAMESPACE}" ` +
          `(plan §4.3 / §12.1 specify dex:w:… and dex:p:…)`,
      );
    }
  }

  failMany(check, "id namespace does not match the published contract", problems);
  if (problems.length === 0) {
    pass(check, `every id is in one namespace: "${DOCUMENTED_NAMESPACE}"`);
  }
}

/* -------------------------------------------------------------------------- */
/* C2 — band counts                                                            */
/* -------------------------------------------------------------------------- */

function checkBandCounts(canon: readonly Record<string, unknown>[]): void {
  const check = "C2 band counts";
  const observed = new Map<number, number>();

  for (const row of canon) {
    const hsk = getRecord(row, "hsk");
    const band = hsk === null ? null : getNumber(hsk, "band2026");
    if (band === null) continue;
    observed.set(band, (observed.get(band) ?? 0) + 1);
  }

  const mismatches: string[] = [];
  for (const [band, expected] of EXPECTED_BAND_COUNTS) {
    const label = BAND_LABELS.get(band) ?? String(band);
    const actual = observed.get(band) ?? 0;
    if (actual !== expected) {
      mismatches.push(`band ${label}: expected ${String(expected)}, found ${String(actual)}`);
    }
  }
  const expectedBands = new Set(EXPECTED_BAND_COUNTS.map((entry) => entry[0]));
  for (const [band, count] of [...observed].sort((a, b) => a[0] - b[0])) {
    if (!expectedBands.has(band)) {
      mismatches.push(`band ${String(band)}: unexpected band, ${String(count)} records`);
    }
  }
  if (canon.length !== EXPECTED_CANON_SIZE) {
    mismatches.push(
      `canon size: expected ${String(EXPECTED_CANON_SIZE)}, found ${String(canon.length)}`,
    );
  }

  failMany(check, "band counts disagree with the pinned source split", mismatches);
  if (mismatches.length === 0) {
    pass(
      check,
      `${String(EXPECTED_CANON_SIZE)} words split ${EXPECTED_BAND_COUNTS.map((e) => String(e[1])).join(" / ")}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* C3 — no audio URLs anywhere in this release                                 */
/* -------------------------------------------------------------------------- */

/**
 * Audio statuses the canon is allowed to carry. This list is not decoration:
 * an earlier version of C3 short-circuited on `status !== "pending"`, and when
 * the canon was enriched and the statuses were renamed, the check silently
 * inspected nothing and still reported PASS. Losing a check without losing the
 * green tick is worse than a failure. So the status vocabulary is now pinned —
 * rename one and this check goes red, forcing a conscious update here.
 */
const KNOWN_AUDIO_STATUSES: ReadonlySet<string> = new Set([
  "available-unhosted",
  "none",
  "unknown",
  "pending",
]);

/**
 * The invariant is unconditional and does not consult any status: NOTHING in
 * this release may hand a consumer an audio URL, and nothing may claim to be
 * hosted. A URL for a clip that is not served is a 404 inside somebody else's
 * flashcard review.
 */
function checkNoAudioUrls(
  canon: readonly Record<string, unknown>[],
  packs: readonly LoadedPack[],
): void {
  const check = "C3 no audio URLs";
  const urlViolations: string[] = [];
  const hostedViolations: string[] = [];
  const statusProblems: string[] = [];
  const statusCounts = new Map<string, number>();

  for (const [index, row] of canon.entries()) {
    const id = getString(row, "id") ?? `row ${String(index)}`;

    /* Unconditional: the whole record, every field, no status gate. */
    findAudioUrls(row, id, urlViolations);

    const audio = getRecord(row, "audio");
    if (audio === null) {
      statusProblems.push(`${id}: no "audio" object`);
      continue;
    }
    const status = getString(audio, "status");
    if (status === null || status.length === 0) {
      statusProblems.push(`${id}: audio.status is missing`);
    } else {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      if (!KNOWN_AUDIO_STATUSES.has(status)) {
        statusProblems.push(
          `${id}: unrecognised audio.status "${status}" — add it to KNOWN_AUDIO_STATUSES ` +
            `in evals/contract.ts and confirm C3 still means what it says`,
        );
      }
    }

    /* No clip is served in this release, so nothing may claim to be hosted. */
    for (const voice of ["female", "male"] as const) {
      const entry = audio[voice];
      if (isRecord(entry)) {
        if (entry["hosted"] === true) {
          hostedViolations.push(`${id}: audio.${voice}.hosted is true, but no audio is hosted yet`);
        }
      } else if (typeof entry === "string" && entry.length > 0) {
        hostedViolations.push(
          `${id}: audio.${voice} is the bare string ${JSON.stringify(entry)}; ` +
            `an availability object is expected, never a location`,
        );
      }
    }
  }

  for (const pack of packs) {
    findAudioUrls(pack.body, pack.file, urlViolations);

    const completeness = getRecord(pack.body, "audioCompleteness");
    if (completeness === null) {
      statusProblems.push(`${pack.file}: no "audioCompleteness" object`);
      continue;
    }
    const status = getString(completeness, "status");
    if (status === null || status.length === 0) {
      statusProblems.push(`${pack.file}: audioCompleteness.status is missing`);
    } else if (status !== "pending") {
      statusProblems.push(
        `${pack.file}: audioCompleteness.status is "${status}"; no audio is hosted in this ` +
          `release, so every pack must still report "pending"`,
      );
    }
  }

  failMany(check, "audio URLs emitted by the dataset", urlViolations);
  failMany(check, "records claiming hosted audio", hostedViolations);
  failMany(check, "audio status problems", statusProblems);

  if (urlViolations.length === 0 && hostedViolations.length === 0 && statusProblems.length === 0) {
    const summary = [...statusCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(", ");
    pass(
      check,
      `0 URLs and 0 hosted claims across ${String(canon.length)} records ` +
        `and ${String(packs.length)} packs (statuses: ${summary})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* C4-C7 — packs                                                               */
/* -------------------------------------------------------------------------- */

interface PackFacts {
  readonly slug: string;
  readonly id: string;
  readonly size: number;
  readonly digest: string;
}

function checkPacks(packs: readonly LoadedPack[], bandOf: ReadonlyMap<string, number>): PackFacts[] {
  const structural = "C4 pack structure";
  const references = "C5 pack references";
  const digests = "C6 pack digests";
  const closure = "C7 band closure";

  const structuralProblems: string[] = [];
  const danglingRefs: string[] = [];
  const digestProblems: string[] = [];
  const closureProblems: string[] = [];

  const facts: PackFacts[] = [];
  const seenSlugs = new Set<string>();
  const seenIds = new Set<string>();
  let levelClaiming = 0;
  let totalSlots = 0;

  for (const { file, body } of packs) {
    const slug = getString(body, "slug") ?? file.replace(/\.json$/, "");
    const id = getString(body, "id");

    if (id === null || !PACK_ID_SHAPE.test(id)) {
      structuralProblems.push(`${file}: id is not a namespaced pack id <ns>:p:<slug> (got ${String(id)})`);
    } else if (!id.endsWith(`:p:${slug}`)) {
      structuralProblems.push(`${file}: id "${id}" does not match slug "${slug}"`);
    }
    if (seenSlugs.has(slug)) structuralProblems.push(`${file}: duplicate slug "${slug}"`);
    seenSlugs.add(slug);
    if (id !== null) {
      if (seenIds.has(id)) structuralProblems.push(`${file}: duplicate pack id "${id}"`);
      seenIds.add(id);
    }

    const rawWords = getArray(body, "words");
    if (rawWords === null) {
      structuralProblems.push(`${file}: "words" is missing or not an array`);
      continue;
    }
    const wordIds: string[] = [];
    for (const [index, entry] of rawWords.entries()) {
      if (typeof entry !== "string" || entry.length === 0) {
        structuralProblems.push(`${slug}: words[${String(index)}] is not a non-empty string`);
        continue;
      }
      wordIds.push(entry);
    }
    if (wordIds.length === 0) {
      structuralProblems.push(`${slug}: words[] is empty`);
      continue;
    }
    totalSlots += wordIds.length;

    const size = getNumber(body, "size");
    if (size === null) {
      structuralProblems.push(`${slug}: "size" is missing or not a number`);
    } else if (size !== wordIds.length) {
      structuralProblems.push(
        `${slug}: size ${String(size)} disagrees with words[].length ${String(wordIds.length)}`,
      );
    }

    const duplicates = new Set<string>();
    const seenInPack = new Set<string>();
    for (const wordId of wordIds) {
      if (seenInPack.has(wordId)) duplicates.add(wordId);
      seenInPack.add(wordId);
    }
    for (const duplicate of duplicates) {
      structuralProblems.push(`${slug}: words[] contains duplicate id "${duplicate}"`);
    }

    /* C5 — every referenced id must resolve in the canon. */
    for (const wordId of wordIds) {
      if (!bandOf.has(wordId)) danglingRefs.push(`${slug} -> ${wordId}`);
    }

    /* C6 — the digest must recompute from words[]. */
    const declaredDigest = getString(body, "digest");
    const recomputed = computeDigest(wordIds);
    if (declaredDigest === null) {
      digestProblems.push(`${slug}: "digest" is missing`);
    } else if (declaredDigest !== recomputed) {
      digestProblems.push(
        `${slug}: declared ${declaredDigest} but words[] hash to ${recomputed}`,
      );
    }

    /* C7 — a pack claiming a level must be closed at that level. */
    const level = getRecord(body, "level");
    const claimedBand = level === null ? null : getNumber(level, "band");
    if (claimedBand !== null) {
      levelClaiming += 1;
      const bandClosure = getRecord(body, "bandClosure");
      if (bandClosure === null) {
        closureProblems.push(`${slug}: claims level band ${String(claimedBand)} but has no bandClosure`);
      } else {
        /*
         * The schema grew a `claim` discriminator ("band-closed" | "spans-bands"),
         * under which `closed` is null for a pack that does not claim closure.
         * A pack that names a level is claiming closure at it either way, so the
         * requirement is unchanged: say "band-closed", and be closed.
         */
        const claim = getString(bandClosure, "claim");
        if (claim !== null && claim !== "band-closed") {
          closureProblems.push(
            `${slug}: level.band is ${String(claimedBand)}, so bandClosure.claim must be ` +
              `"band-closed"; it is "${claim}". A pack that names a level may not span bands.`,
          );
        } else if (bandClosure["closed"] !== true) {
          closureProblems.push(
            `${slug}: claims level band ${String(claimedBand)} but bandClosure.closed is ` +
              `${JSON.stringify(bandClosure["closed"])}`,
          );
        }
        const min = getNumber(bandClosure, "claimedMinBand");
        const max = getNumber(bandClosure, "claimedMaxBand");
        if (min === null || max === null) {
          closureProblems.push(`${slug}: claims a level but declares no closure window`);
        } else {
          /* Recompute closure from the canon rather than trusting the flag. */
          const outside: string[] = [];
          let offList = 0;
          for (const wordId of wordIds) {
            const band = bandOf.get(wordId);
            if (band === undefined) {
              offList += 1;
              continue;
            }
            if (band < min || band > max) outside.push(`${wordId}@band${String(band)}`);
          }
          if (outside.length > 0) {
            closureProblems.push(
              `${slug}: claims bands ${String(min)}-${String(max)} but ` +
                `${String(outside.length)} words fall outside, e.g. ${outside.slice(0, 3).join(", ")}`,
            );
          }
          if (offList > 0) {
            closureProblems.push(
              `${slug}: ${String(offList)} words are not in the canon and cannot be band-checked`,
            );
          }
          const observedOver = getNumber(bandClosure, "overBand");
          if (observedOver !== null && observedOver > 0) {
            closureProblems.push(
              `${slug}: bandClosure reports ${String(observedOver)} over-band words on a level-claiming pack`,
            );
          }
        }
      }
    }

    if (declaredDigest !== null) {
      facts.push({
        slug,
        id: id ?? `${DOCUMENTED_NAMESPACE}:p:${slug}`,
        size: wordIds.length,
        digest: declaredDigest,
      });
    }
  }

  failMany(structural, "structurally invalid packs", structuralProblems);
  failMany(references, "pack word ids absent from the canon", danglingRefs);
  failMany(digests, "pack digests that do not reproduce", digestProblems);
  failMany(closure, "level-claiming packs that are not band-closed", closureProblems);

  if (structuralProblems.length === 0) {
    pass(structural, `${String(packs.length)} packs, ${String(totalSlots)} word slots`);
  }
  if (danglingRefs.length === 0) {
    pass(references, `every pack word id resolves in the canon`);
  }
  if (digestProblems.length === 0) {
    pass(digests, `${String(facts.length)} digests recomputed from words[]`);
  }
  if (closureProblems.length === 0) {
    pass(closure, `${String(levelClaiming)} level-claiming packs, all closed`);
  }

  return facts;
}

/* -------------------------------------------------------------------------- */
/* C8 — catalogue agreement                                                    */
/* -------------------------------------------------------------------------- */

function checkCatalogue(facts: readonly PackFacts[]): void {
  const check = "C8 catalogue";
  const problems: string[] = [];
  const bySlug = new Map(facts.map((fact) => [fact.slug, fact]));

  const verifyListing = (label: string, path: string, key: string): void => {
    if (!existsSync(path)) {
      problems.push(`${label} is missing at ${path}`);
      return;
    }
    const parsed = readJson(path, label);
    if (!isRecord(parsed)) {
      problems.push(`${label} is not a JSON object`);
      return;
    }
    const listed = getArray(parsed, key);
    if (listed === null) {
      problems.push(`${label} has no "${key}" array`);
      return;
    }
    const listedSlugs = new Set<string>();
    for (const [index, entry] of listed.entries()) {
      if (!isRecord(entry)) {
        problems.push(`${label}.${key}[${String(index)}] is not an object`);
        continue;
      }
      const slug = getString(entry, "slug");
      if (slug === null) {
        problems.push(`${label}.${key}[${String(index)}] has no slug`);
        continue;
      }
      listedSlugs.add(slug);
      const fact = bySlug.get(slug);
      if (fact === undefined) {
        problems.push(`${label} lists "${slug}", which has no pack file`);
        continue;
      }
      const digest = getString(entry, "digest");
      if (digest !== null && digest !== fact.digest) {
        problems.push(`${label} digest for "${slug}" disagrees with the pack file`);
      }
      const size = getNumber(entry, "size");
      if (size !== null && size !== fact.size) {
        problems.push(
          `${label} size for "${slug}" is ${String(size)}, pack file has ${String(fact.size)}`,
        );
      }
    }
    for (const fact of facts) {
      if (!listedSlugs.has(fact.slug)) problems.push(`${label} omits pack "${fact.slug}"`);
    }
  };

  verifyListing("data/packs/index.json", PACK_INDEX_PATH, "packs");
  verifyListing("data/pack-stats.json", PACK_STATS_PATH, "packs");

  failMany(check, "catalogue disagrees with the pack files on disk", problems);
  if (problems.length === 0) {
    pass(check, `index.json and pack-stats.json agree with all ${String(facts.length)} pack files`);
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

function main(): void {
  const started = Date.now();

  requireBuild();
  const canon = loadCanon();
  const packs = loadPacks();

  const bandOf = checkCanonIds(canon);
  checkIdNamespace(canon, packs);
  checkBandCounts(canon);
  checkNoAudioUrls(canon, packs);
  const facts = checkPacks(packs, bandOf);
  checkCatalogue(facts);

  const elapsedMs = Date.now() - started;
  const out = process.stdout;

  out.write("\nZhongdex Tier 0 — contract eval\n\n");
  for (const line of passed) out.write(`  PASS  ${line}\n`);

  if (failures.length === 0) {
    out.write(`\n  ${String(passed.length)} checks passed in ${String(elapsedMs)} ms\n\n`);
    return;
  }

  out.write("\n");
  let lastCheck = "";
  for (const failure of failures) {
    if (failure.check !== lastCheck && !failure.detail.startsWith("    ")) {
      lastCheck = failure.check;
    }
    if (failure.detail.startsWith("    ")) out.write(`      ${failure.detail.trim()}\n`);
    else out.write(`  FAIL  ${failure.check}  ${failure.detail}\n`);
  }
  const failedChecks = new Set(failures.map((failure) => failure.check));
  out.write(
    `\n  ${String(failedChecks.size)} check(s) failed, ${String(passed.length)} passed ` +
      `(${String(elapsedMs)} ms)\n\n`,
  );
  process.exit(1);
}

main();
