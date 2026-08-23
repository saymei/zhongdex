#!/usr/bin/env node
/**
 * Audio migration planner — DRY RUN, ALWAYS.
 *
 * This module plans the move of the existing word-clip archive into the
 * Zhongdex audio key layout. It **moves no bytes, opens no socket, and writes
 * nothing outside `data/audio-migration-plan.json`.** There is no `--apply`
 * flag and there is deliberately no code path that could grow one: nothing in
 * this file imports an HTTP client, an S3 client, or `child_process`.
 *
 * Usage:  npm run plan:audio-migration
 * Exit:   0 = plan written · 2 = could not run (canon missing)
 *
 * ── The key layout it plans, and why ───────────────────────────────────────
 *
 *   https://audio.zhongdex.org/v1/w/<voice>/<word>.mp3          natural speed
 *   https://audio.zhongdex.org/v1/w/<voice>/<word>.slow.mp3     0.7x reading
 *   https://audio.zhongdex.org/v1/w/<voice>/<word>.<pinyin>.mp3 polyphone
 *
 * The word is the key. REVISION1 §1.2 kills the sha256 path scheme
 * (`/v1/w/ab/<64-hex>.amy.mp3`) because it is a transcription trap: models
 * retype URLs out of tool output into card fields and `storeMediaFile`
 * arguments, and a 64-hex segment is exactly where that fails silently into a
 * 404. A constructible URL also means an agent that already knows the word
 * needs zero tool calls.
 *
 * One deliberate divergence from REVISION1 §1.2, which said content addressing
 * would survive "as the R2 storage key behind a Worker route map": **the R2
 * object key here IS the URL path, with no map and no Worker.** A Worker
 * executes before the cache lookup, so binding one to the audio route bills a
 * request on every cache HIT — ~$302/month at 1B requests (§6.6). Making the
 * key equal the path removes the Worker from the audio path entirely and takes
 * that line to $0. Immutability is preserved by the release-scoped rebuild, not
 * by the key.
 *
 * ── What it reads ──────────────────────────────────────────────────────────
 *
 *   data/hsk_bands.json  required. The canon. A sibling is adding audio
 *                        availability metadata to it; this planner reads
 *                        whatever `audio` object is present, reports the shape
 *                        it found, and switches its basis from "ledger" to
 *                        "canon-metadata" the moment real per-word data lands.
 *
 * Node builtins only. No network at any point.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CANON_PATH = join(ROOT, "data", "hsk_bands.json");
const PLAN_PATH = join(ROOT, "data", "audio-migration-plan.json");

/* -------------------------------------------------------------------------- */
/* Constants — every one of them cited                                         */
/* -------------------------------------------------------------------------- */

export const PLAN_SCHEMA = "zhongdex/audio-migration-plan/v1" as const;

/** The machine hostname. REVISION1 §6.6 correction 1: not a saymei.app subdomain. */
const AUDIO_HOST = "audio.zhongdex.org";

/** Path prefix. Kept short so the WAF `starts_with` guard stays cheap. */
const PATH_PREFIX = "/v1/w";

export type Voice = "amy" | "james";
export type Variant = "natural" | "slow";

const VOICES: readonly Voice[] = ["amy", "james"];
const VARIANTS: readonly Variant[] = ["natural", "slow"];

/**
 * One word clip, measured on the current archive (ZHONGDEX.md §7.2:
 * "one word clip is 67,125 bytes"). Used only where the canon carries no real
 * byte count; every estimate derived from it is labelled `estimated`.
 */
const MEASURED_WORD_CLIP_BYTES = 67_125;

/**
 * What exists today, from the reuse ledger (ZHONGDEX.md §3.1/§3.3):
 *   - Amy word clips: 186,791, ALL time-stretched to 0.7x. No natural-speed
 *     master survives — it was written to a tmpdir and deleted.
 *   - James word clips: zero, corpus-wide.
 * So exactly one of the four (voice x variant) cells is a migration; the other
 * three are generation or transcode gaps and are counted, not planned.
 */
const LEDGER_AVAILABILITY: ReadonlyArray<{
  readonly voice: Voice;
  /** Which canon voice slot speaks for this cell. */
  readonly canonVoice: "female" | "male";
  readonly variant: Variant;
  /** Does this speed exist upstream at all? A canon flag cannot answer this. */
  readonly variantExists: boolean;
  readonly source: string;
}> = [
  {
    voice: "amy",
    canonVoice: "female",
    variant: "slow",
    variantExists: true,
    source: "ZHONGDEX.md §3.1 — 186,791 Amy word clips, 100% time-stretched to 0.7x",
  },
  {
    voice: "amy",
    canonVoice: "female",
    variant: "natural",
    variantExists: false,
    source: "ZHONGDEX.md §3.3 G2b — no natural-speed word clip exists anywhere; the master was deleted",
  },
  {
    voice: "james",
    canonVoice: "male",
    variant: "natural",
    variantExists: false,
    source: "ZHONGDEX.md §3.3 G2 — James has zero word clips corpus-wide",
  },
  {
    voice: "james",
    canonVoice: "male",
    variant: "slow",
    variantExists: false,
    source: "derivative of G2; ffmpeg transcode once G2 renders, no TTS",
  },
];

/** Clips per upload batch. Small enough that a failed batch is cheap to redo. */
const BATCH_SIZE = 1_000;

/**
 * WAF path-length guard from REVISION1 §6.6 correction 2. Recorded in the plan
 * next to the *measured* maximum so the two never drift apart unnoticed.
 */
const WAF_MAX_PATH_LENGTH = 96;

/* -------------------------------------------------------------------------- */
/* Canon reading — tolerant, because a sibling owns this file's shape          */
/* -------------------------------------------------------------------------- */

interface CanonRow {
  readonly id: string;
  readonly simplified: string;
  readonly numbered: string;
  readonly band: number;
  readonly audio: Readonly<Record<string, unknown>> | null;
}

/**
 * Per-voice availability as read from one canon row. `null` means the canon
 * does not say — which is not the same as "no clip" and is never treated as one.
 */
interface RowAvailability {
  readonly female: boolean | null;
  readonly male: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Numbered pinyin with spaces stripped: "yi1 xia4 r5" -> "yi1xia4r5". */
function compactReading(numbered: string): string {
  return numbered.replace(/\s+/g, "");
}

function parseCanon(raw: string): CanonRow[] {
  const parsed: unknown = JSON.parse(raw);
  const list: unknown = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed["words"] : null;
  if (!Array.isArray(list)) {
    throw new Error("data/hsk_bands.json is neither an array nor { words: [...] }");
  }

  const rows: CanonRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const simplified = readString(entry, "simplified");
    if (simplified === null) continue;

    const pinyin = entry["pinyin"];
    let numbered: string | null = null;
    if (isRecord(pinyin)) numbered = readString(pinyin, "numbered");
    if (numbered === null) numbered = readString(entry, "pinyin_numbered");

    const hsk = entry["hsk"];
    let band: number | null = null;
    if (isRecord(hsk)) band = readNumber(hsk, "band2026");
    if (band === null) band = readNumber(entry, "band2026");

    const audio = entry["audio"];
    rows.push({
      id: readString(entry, "id") ?? `dex:w:?:${simplified}`,
      simplified,
      numbered: numbered === null ? "" : compactReading(numbered),
      band: band ?? 0,
      audio: isRecord(audio) ? audio : null,
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* The audio-metadata probe                                                    */
/* -------------------------------------------------------------------------- */

interface AudioMetaReport {
  /** True once the canon carries per-word availability the planner can measure. */
  readonly metadataPresent: boolean;
  readonly rowsWithAudioObject: number;
  readonly fieldsObserved: readonly string[];
  readonly voiceFieldShape: string;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly availability: Readonly<Record<"female" | "male", { available: number; unavailable: number; unknown: number }>>;
  readonly urlsPresent: number;
  readonly byteSizesPresent: number;
  readonly totalBytesFromCanon: number | null;
  readonly note: string;
}

/**
 * Field names an enrichment pass might plausibly use for a byte count. Probed,
 * not required: if none is present the planner says so rather than guessing.
 */
const BYTE_FIELD_ALIASES = ["bytes", "size", "sizeBytes", "byteLength", "contentLength"] as const;

/**
 * Read one voice slot. Two shapes are understood and neither is required:
 *
 *   "female": { "available": true, "hosted": false }   the enriched canon
 *   "female": "https://.../x.mp3" | null               a URL-bearing canon
 *
 * Anything else reads as `null` — unmeasured. Absence is never coerced to false;
 * "the canon does not say" and "there is no clip" are different facts and
 * conflating them is how a migration silently skips 11,000 files.
 */
function readVoiceAvailability(audio: Record<string, unknown>, key: string): boolean | null {
  const slot = audio[key];
  if (typeof slot === "string") return slot.length > 0;
  if (isRecord(slot)) {
    const available = slot["available"];
    if (typeof available === "boolean") return available;
  }
  return null;
}

function rowAvailability(row: CanonRow): RowAvailability {
  if (row.audio === null) return { female: null, male: null };
  return {
    female: readVoiceAvailability(row.audio, "female") ?? readVoiceAvailability(row.audio, "amy"),
    male: readVoiceAvailability(row.audio, "male") ?? readVoiceAvailability(row.audio, "james"),
  };
}

function probeAudioMetadata(rows: readonly CanonRow[]): AudioMetaReport {
  const fields = new Set<string>();
  const shapes = new Set<string>();
  const statusCounts: Record<string, number> = {};
  const availability = {
    female: { available: 0, unavailable: 0, unknown: 0 },
    male: { available: 0, unavailable: 0, unknown: 0 },
  };
  let rowsWithAudioObject = 0;
  let urlsPresent = 0;
  let byteSizesPresent = 0;
  let totalBytes = 0;

  for (const row of rows) {
    const audio = row.audio;
    if (audio === null) continue;
    rowsWithAudioObject += 1;

    for (const key of Object.keys(audio)) fields.add(key);
    for (const key of ["female", "male", "amy", "james"]) {
      if (!(key in audio)) continue;
      const slot = audio[key];
      shapes.add(slot === null ? "null" : Array.isArray(slot) ? "array" : typeof slot === "object" ? "object" : typeof slot);
      if (typeof slot === "string" && slot.length > 0) urlsPresent += 1;
    }

    const status = readString(audio, "status") ?? "(no status field)";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const avail = rowAvailability(row);
    for (const voice of ["female", "male"] as const) {
      const value = avail[voice];
      if (value === null) availability[voice].unknown += 1;
      else if (value) availability[voice].available += 1;
      else availability[voice].unavailable += 1;
    }

    for (const byteKey of BYTE_FIELD_ALIASES) {
      const value = readNumber(audio, byteKey);
      if (value !== null) {
        byteSizesPresent += 1;
        totalBytes += value;
        break;
      }
    }
  }

  const measured =
    availability.female.available + availability.female.unavailable + availability.male.available + availability.male.unavailable;
  const metadataPresent = measured > 0;

  return {
    metadataPresent,
    rowsWithAudioObject,
    fieldsObserved: [...fields].sort(),
    voiceFieldShape: [...shapes].sort().join(" | ") || "(no voice field)",
    statusCounts,
    availability,
    urlsPresent,
    byteSizesPresent,
    totalBytesFromCanon: byteSizesPresent > 0 ? totalBytes : null,
    note: metadataPresent
      ? "The canon carries per-word audio availability. The migration set below is MEASURED from it. " +
        "It carries no byte sizes, so byte totals remain estimates."
      : "The canon carries NO per-word audio availability metadata: every voice slot reads as unmeasured. " +
        "The migration set below is taken from the reuse ledger (ZHONGDEX.md §3.1) and is an ASSUMPTION, not a " +
        "measurement. Re-run after the enrichment pass lands and the basis switches to \"canon-metadata\".",
  };
}

/* -------------------------------------------------------------------------- */
/* Headword analysis                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A headword whose written form is not a bare word and therefore cannot mint a
 * constructible URL. These are annotation artifacts of the source list —
 * `们（朋友们）`, `哥哥|哥`, `…分之…`, `好（不）容易` — and percent-encoding them
 * produces exactly the unreadable, un-retypeable URL the scheme exists to
 * avoid. They are BLOCKED, not normalised: picking a base form silently is a
 * coercion, and the right output of a planner is a decision request.
 */
const BARE_WORD = /^[㐀-䶿一-鿿豈-﫿]+$/u;

interface Headword {
  readonly form: string;
  readonly reading: string;
  /** True when this form has more than one reading in the canon. */
  readonly polyphone: boolean;
  readonly band: number;
  readonly rowIds: readonly string[];
  /** Merged over the rows that share this (form, reading). null = unmeasured. */
  readonly female: boolean | null;
  readonly male: boolean | null;
}

/** true wins over false wins over null: one row saying "there is a clip" is evidence. */
function mergeAvailability(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

interface HeadwordAnalysis {
  readonly clipBearing: readonly Headword[];
  readonly distinctForms: number;
  readonly distinctFormReadingPairs: number;
  readonly polyphoneForms: readonly { readonly form: string; readonly readings: readonly string[] }[];
  readonly blocked: readonly { readonly form: string; readonly rows: number; readonly reason: string }[];
  readonly readingless: readonly string[];
}

function analyseHeadwords(rows: readonly CanonRow[]): HeadwordAnalysis {
  /** form -> reading -> accumulator */
  const forms = new Map<
    string,
    Map<string, { band: number; rowIds: string[]; female: boolean | null; male: boolean | null }>
  >();
  const blocked: { form: string; rows: number; reason: string }[] = [];
  const blockedSeen = new Map<string, number>();
  const readingless: string[] = [];

  for (const row of rows) {
    if (!BARE_WORD.test(row.simplified)) {
      blockedSeen.set(row.simplified, (blockedSeen.get(row.simplified) ?? 0) + 1);
      continue;
    }
    if (row.numbered.length === 0) {
      readingless.push(row.id);
      continue;
    }
    let readings = forms.get(row.simplified);
    if (readings === undefined) {
      readings = new Map();
      forms.set(row.simplified, readings);
    }
    const avail = rowAvailability(row);
    const existing = readings.get(row.numbered);
    if (existing === undefined) {
      readings.set(row.numbered, { band: row.band, rowIds: [row.id], female: avail.female, male: avail.male });
    } else {
      // Same form, same reading => same pronunciation => one clip. The lowest
      // band wins so the clip migrates in the earliest useful batch.
      existing.band = Math.min(existing.band, row.band);
      existing.rowIds.push(row.id);
      existing.female = mergeAvailability(existing.female, avail.female);
      existing.male = mergeAvailability(existing.male, avail.male);
    }
  }

  for (const [form, count] of [...blockedSeen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    blocked.push({
      form,
      rows: count,
      reason:
        "headword carries source-list annotation (parenthetical, ellipsis or alternation) and is not a bare word; " +
        "no constructible key can be minted until a normalisation rule is published",
    });
  }

  const clipBearing: Headword[] = [];
  const polyphoneForms: { form: string; readings: string[] }[] = [];

  for (const [form, readings] of forms) {
    const polyphone = readings.size > 1;
    if (polyphone) {
      polyphoneForms.push({ form, readings: [...readings.keys()].sort() });
    }
    for (const [reading, meta] of readings) {
      clipBearing.push({
        form,
        reading,
        polyphone,
        band: meta.band,
        rowIds: [...meta.rowIds].sort(),
        female: meta.female,
        male: meta.male,
      });
    }
  }

  // Deterministic order: band ascending (band 1 migrates first and is useful on
  // its own), then form, then reading. No localeCompare — host ICU varies.
  clipBearing.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    if (a.form !== b.form) return a.form < b.form ? -1 : 1;
    return a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0;
  });
  polyphoneForms.sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));

  return {
    clipBearing,
    distinctForms: forms.size,
    distinctFormReadingPairs: clipBearing.length,
    polyphoneForms,
    blocked,
    readingless,
  };
}

/* -------------------------------------------------------------------------- */
/* Key construction                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The R2 object key. Equal to the URL path minus the leading slash, so the
 * bucket can be served by a custom domain with no Worker and no rewrite.
 */
export function objectKey(word: Headword, voice: Voice, variant: Variant): string {
  const suffix = word.polyphone ? `.${word.reading}` : "";
  const speed = variant === "slow" ? ".slow" : "";
  return `v1/w/${voice}/${word.form}${suffix}${speed}.mp3`;
}

/** The public URL. `encodeURIComponent` on the filename only; slashes stay. */
export function publicUrl(key: string): string {
  const parts = key.split("/");
  const last = parts[parts.length - 1] ?? "";
  const encoded = [...parts.slice(0, -1), encodeURIComponent(last)].join("/");
  return `https://${AUDIO_HOST}/${encoded}`;
}

/** Length of the encoded path (what the WAF `len()` guard actually measures). */
function encodedPathLength(key: string): number {
  return publicUrl(key).length - `https://${AUDIO_HOST}`.length;
}

/* -------------------------------------------------------------------------- */
/* Plan shape                                                                  */
/* -------------------------------------------------------------------------- */

interface PlanBatch {
  readonly index: number;
  readonly clips: number;
  readonly estimatedBytes: number;
  readonly bands: readonly number[];
  readonly firstKey: string;
  readonly lastKey: string;
}

function buildBatches(words: readonly Headword[], voice: Voice, variant: Variant, bytesPerClip: number): PlanBatch[] {
  const batches: PlanBatch[] = [];
  for (let start = 0; start < words.length; start += BATCH_SIZE) {
    const slice = words.slice(start, start + BATCH_SIZE);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;
    const bands = [...new Set(slice.map((w) => w.band))].sort((a, b) => a - b);
    batches.push({
      index: batches.length + 1,
      clips: slice.length,
      estimatedBytes: slice.length * bytesPerClip,
      bands,
      firstKey: objectKey(first, voice, variant),
      lastKey: objectKey(last, voice, variant),
    });
  }
  return batches;
}

function human(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(1)} kB`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): number {
  if (!existsSync(CANON_PATH)) {
    process.stderr.write(
      `plan-migration: data/hsk_bands.json not found.\n` +
        `  data/ is a build output, not a committed source. Run:\n\n` +
        `    npm run build\n\n`,
    );
    return 2;
  }

  const rawBuffer = readFileSync(CANON_PATH);
  const rows = parseCanon(rawBuffer.toString("utf8"));
  const audioMeta = probeAudioMetadata(rows);
  const words = analyseHeadwords(rows);

  const bytesPerClip =
    audioMeta.totalBytesFromCanon !== null && audioMeta.byteSizesPresent > 0
      ? Math.round(audioMeta.totalBytesFromCanon / audioMeta.byteSizesPresent)
      : MEASURED_WORD_CLIP_BYTES;
  const bytesBasis =
    audioMeta.byteSizesPresent > 0
      ? `mean of ${String(audioMeta.byteSizesPresent)} byte counts carried by the canon`
      : `measured single-clip size, ZHONGDEX.md §7.2 (${String(MEASURED_WORD_CLIP_BYTES)} bytes); the canon carries no sizes`;

  // Longest encoded path across every key this plan would ever mint.
  let maxPathLength = 0;
  let maxPathKey = "";
  for (const word of words.clipBearing) {
    for (const voice of VOICES) {
      for (const variant of VARIANTS) {
        const key = objectKey(word, voice, variant);
        const length = encodedPathLength(key);
        if (length > maxPathLength) {
          maxPathLength = length;
          maxPathKey = key;
        }
      }
    }
  }

  /**
   * A cell migrates only if BOTH are true: the speed exists upstream (a ledger
   * fact no per-word flag can supply) and the word itself has that voice. When
   * the canon has not been enriched yet, "has that voice" falls back to the
   * ledger's corpus-wide claim and the basis is labelled `ledger`, not measured.
   */
  const cells = LEDGER_AVAILABILITY.map((cell) => {
    const members = cell.variantExists
      ? words.clipBearing.filter((word) => {
          const flag = cell.canonVoice === "female" ? word.female : word.male;
          return audioMeta.metadataPresent ? flag === true : true;
        })
      : [];
    const unmeasured = cell.variantExists
      ? words.clipBearing.filter((word) => (cell.canonVoice === "female" ? word.female : word.male) === null).length
      : 0;
    return {
      voice: cell.voice,
      canonVoice: cell.canonVoice,
      variant: cell.variant,
      action: members.length > 0 ? ("migrate" as const) : ("gap" as const),
      clips: members.length,
      unmeasuredHeadwords: audioMeta.metadataPresent ? unmeasured : words.clipBearing.length,
      estimatedBytes: members.length * bytesPerClip,
      basis: audioMeta.metadataPresent ? "canon-metadata" : "ledger",
      source: cell.source,
      members,
    };
  });

  const migrateCells = cells.filter((cell) => cell.action === "migrate");
  const migrateClips = migrateCells.reduce((sum, cell) => sum + cell.clips, 0);
  const migrateBytes = migrateCells.reduce((sum, cell) => sum + cell.estimatedBytes, 0);

  const batches = migrateCells.flatMap((cell) =>
    buildBatches(cell.members, cell.voice, cell.variant, bytesPerClip).map((batch) => ({
      ...batch,
      voice: cell.voice,
      variant: cell.variant,
    })),
  );

  // `members` is working state, not plan output: a plan file that inlines
  // 11,000 headwords per cell is unreadable and duplicates the batch list.
  const cellSummaries = cells.map(({ members: _members, ...rest }) => rest);

  const plan = {
    schema: PLAN_SCHEMA,
    generator: "src/audio/plan-migration.ts",
    dryRun: true,
    movesBytes: false,
    contactsRemote: false,
    note:
      "A PLAN, not an execution. Nothing here has been uploaded, copied, or reserved. " +
      "No timestamp is emitted so two runs over the same canon are byte-identical.",

    corpus: {
      canonPath: "data/hsk_bands.json",
      sha256: createHash("sha256").update(rawBuffer).digest("hex"),
      bytes: rawBuffer.byteLength,
      rows: rows.length,
    },

    canonAudio: audioMeta,

    scheme: {
      host: AUDIO_HOST,
      pathPrefix: PATH_PREFIX,
      natural: `${PATH_PREFIX}/<voice>/<word>.mp3`,
      slow: `${PATH_PREFIX}/<voice>/<word>.slow.mp3`,
      polyphone: `${PATH_PREFIX}/<voice>/<word>.<numberedPinyin>.mp3`,
      voices: VOICES,
      variants: VARIANTS,
      r2KeyEqualsUrlPath: true,
      r2KeyTemplate: "v1/w/<voice>/<word>[.<reading>][.slow].mp3",
      encoding:
        "The R2 key holds the raw UTF-8 word. The URL percent-encodes the final path segment only. " +
        "Both forms are recorded per batch so an uploader never has to guess which one to use.",
      rejected: {
        sha256Paths:
          "REVISION1 §1.2 — /v1/w/ab/<64-hex>.amy.mp3 is a transcription trap; models retype URLs into card " +
          "fields and storeMediaFile arguments and a 64-hex segment fails silently into a 404.",
        workerRouteMap:
          "A Worker executes before the cache lookup and therefore bills on every cache HIT (~$302/mo at 1B, " +
          "REVISION1 §6.6). Making the key equal the path removes the Worker from the audio route entirely.",
      },
      pathLength: {
        maxObserved: maxPathLength,
        maxObservedKey: maxPathKey,
        wafGuard: WAF_MAX_PATH_LENGTH,
        headroom: WAF_MAX_PATH_LENGTH - maxPathLength,
        note:
          "The WAF rule in docs/HOSTING.md rejects /v1/w/ paths longer than the guard. Measured against every " +
          "key this plan would mint, so the guard and the corpus cannot drift apart unnoticed.",
      },
    },

    headwords: {
      canonRows: rows.length,
      distinctForms: words.distinctForms,
      distinctFormReadingPairs: words.distinctFormReadingPairs,
      clipBearingHeadwords: words.clipBearing.length,
      collapsedRows: rows.length - words.clipBearing.length - words.blocked.reduce((n, b) => n + b.rows, 0),
      collapseNote:
        "Canon rows split on POS as well as reading (下/N,V at band 1 and 下/M at band 2 are two rows). " +
        "Audio depends only on the reading, so rows sharing (form, reading) share one clip.",
      polyphoneFormCount: words.polyphoneForms.length,
      polyphoneForms: words.polyphoneForms,
      blockedCount: words.blocked.length,
      blocked: words.blocked,
      readinglessRowIds: words.readingless,
    },

    clips: {
      bytesPerClip,
      bytesBasis,
      cells: cellSummaries,
      migrate: {
        clips: migrateClips,
        estimatedBytes: migrateBytes,
        basis: audioMeta.metadataPresent ? "canon-metadata" : "ledger",
      },
      gap: cellSummaries.filter((cell) => cell.action === "gap"),
    },

    batches: {
      size: BATCH_SIZE,
      order: "band ascending, then form, then reading — band 1 lands first and is useful before the run finishes",
      count: batches.length,
      list: batches,
    },

    openDecisions: [
      {
        id: "D1",
        title: "Dominant reading for the bare polyphone path",
        detail:
          `${String(words.polyphoneForms.length)} headwords carry more than one reading in the canon. ` +
          `Every reading gets an explicit .<pinyin> path, but /v1/w/amy/<word>.mp3 with no suffix has no owner. ` +
          `Leaving it unmapped returns 404 (detectable). Mapping it to the wrong reading is silent and worse. ` +
          `Publish a dominant-reading table or serve 404 on every bare polyphone path — pick one, in writing.`,
        blocking: true,
      },
      {
        id: "D2",
        title: "Normalisation rule for annotated headwords",
        detail:
          `${String(words.blocked.length)} canon headwords are not bare words — they carry source-list annotation ` +
          `such as 们（朋友们）, 哥哥|哥, …分之… or 好（不）容易. Percent-encoding them produces the unreadable URL the ` +
          `constructible scheme exists to avoid. They are excluded from every batch until a rule is published.`,
        blocking: true,
      },
      {
        id: "D3",
        title: "Legacy 0.7x disclosure",
        detail:
          "Every migrated Amy clip is time-stretched to 0.7x and no natural-speed master survives. The .slow " +
          "path names that honestly; the bare .mp3 path for Amy must 404 until G2b renders natural speed, rather " +
          "than aliasing to the stretched clip.",
        blocking: false,
      },
    ],
  };

  mkdirSync(dirname(PLAN_PATH), { recursive: true });
  writeFileSync(PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  /* ---------------------------------------------------------------------- */
  /* Summary                                                                 */
  /* ---------------------------------------------------------------------- */

  const out: string[] = [];
  out.push("");
  out.push("Zhongdex audio migration plan — DRY RUN (no bytes moved, no remote contacted)");
  out.push("");
  out.push(`  canon                    data/hsk_bands.json · ${String(rows.length)} rows`);
  out.push(`  audio metadata           ${audioMeta.metadataPresent ? "present" : "ABSENT"} · fields: ${audioMeta.fieldsObserved.join(", ") || "(none)"}`);
  out.push(`  status counts            ${Object.entries(audioMeta.statusCounts).map(([k, v]) => `${k}=${String(v)}`).join(" · ") || "(none)"}`);
  out.push("");
  out.push(`  distinct headwords       ${String(words.distinctForms)}`);
  out.push(`  distinct (form,reading)  ${String(words.distinctFormReadingPairs)}  <- one clip each, per voice per speed`);
  out.push(`  polyphones needing a suffix  ${String(words.polyphoneForms.length)}`);
  out.push(`  blocked (annotated forms)    ${String(words.blocked.length)}`);
  out.push("");
  out.push("  voice/variant     action   clips     est. bytes");
  for (const cell of cellSummaries) {
    const label = `${cell.voice}/${cell.variant}`.padEnd(16);
    const action = cell.action.padEnd(8);
    const clips = cell.action === "migrate" ? String(cell.clips).padStart(6) : "     -";
    const bytes = cell.action === "migrate" ? human(cell.estimatedBytes).padStart(12) : "           -";
    out.push(`  ${label}${action}${clips}${bytes}`);
  }
  out.push("");
  out.push(`  TO MIGRATE               ${String(migrateClips)} clips · ~${human(migrateBytes)} · ${String(batches.length)} batches of ${String(BATCH_SIZE)}`);
  out.push(`  byte basis               ${bytesBasis}`);
  out.push(`  longest encoded path     ${String(maxPathLength)} chars (WAF guard ${String(WAF_MAX_PATH_LENGTH)}, headroom ${String(WAF_MAX_PATH_LENGTH - maxPathLength)})`);
  out.push("");
  out.push(`  blocking decisions       D1 dominant reading · D2 annotated-headword normalisation`);
  out.push(`  written                  data/audio-migration-plan.json`);
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);

  return 0;
}

process.exitCode = main();
