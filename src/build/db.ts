/**
 * Zhongdex enrichment — read-only access to SayMei's production dictionary.
 *
 * The build imports exactly one thing from here — `normalizeReading`, the join
 * key — and that import cannot reach a database: the driver is loaded inside
 * `fetchDictionaryRows`, so merely importing this module opens nothing. The
 * query path runs only from `npm run enrich:fetch`, on a machine that has a
 * SayMei checkout, and it issues nothing but SELECTs: no writes, no DDL, no
 * transactions that could hold a lock. The table it reads is production data.
 *
 * `pg` is imported at run time from the SayMei checkout instead of being added
 * to this repo's dependencies. That is deliberate. CI installs with `npm ci`
 * and must not have a Postgres driver available at all, so that no future edit
 * can accidentally make the public build reach for a private database. The
 * price is that `enrich:fetch` only runs where SayMei is checked out, which is
 * correct: only the maintainer can refresh the snapshot, and everyone else
 * builds from the committed one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SnapshotRow } from "./types.js";

/** Where the SayMei checkout lives. Override for a different machine. */
const SAYMEI_ROOT = process.env["ZHONGDEX_SAYMEI_ROOT"] ?? "/Users/lelandchar/Desktop/SayMei-Web";

/** Columns read from `global_dictionary`, with what each is used for. */
export const COLUMNS_READ = [
  "characters",
  "pinyin_numbered",
  "hsk_new_level",
  "hsk_old_level",
  "frequency_rank",
  "zipf_score",
  "audio_url",
] as const;

/**
 * Columns inspected and rejected, with the reason. Kept here rather than in a
 * commit message so the next person does not have to re-measure them.
 */
export const COLUMNS_DROPPED: Record<string, string> = {
  subtlex_freq:
    "0 of 201830 rows non-null. Emitting it would be a column of nulls dressed as a measurement.",
  hsk_level:
    "0 of 201830 rows non-null. Superseded by hsk_new_level / hsk_old_level, which are populated.",
  sentence_audio_url:
    "91 of 201830 rows non-null (0.05%), and this build ships no sentences to attach them to.",
  traditional_characters:
    "165247 of 201830 rows non-null, but the canon already carries traditional forms from the " +
    "HSK list and CC-CEDICT. A third opinion would need adjudicating, not merging.",
};

/**
 * Reduce numbered pinyin to a comparison key: lowercase, `u:` folded to `v`,
 * everything that is not a letter or digit removed.
 *
 * Both sides need it. The HSK list writes CC-CEDICT convention (`ai4 hao4`,
 * `lu:3 you2`); `global_dictionary.pinyin_numbered` writes the same convention
 * but inconsistently cased (`San1` for 三). Tone digits are kept, because the
 * whole point of a reading key is to tell 白 bai2 from 白 bo2.
 */
export function normalizeReading(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/u:/g, "v").replace(/[^a-z0-9]/g, "");
}

/** What one fetch returns: the rows, plus the provenance the snapshot records. */
export interface FetchResult {
  /** Upstream rows for the requested forms, grouped by simplified form. */
  readonly rowsByForm: ReadonlyMap<string, readonly SnapshotRow[]>;
  /** Total rows in `global_dictionary` at capture time. */
  readonly tableRows: number;
  /** Table-wide non-null counts for the columns actually captured. */
  readonly columnCoverage: Record<string, number>;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pull DATABASE_URL out of the SayMei `.env`. Reading the file rather than the
 * ambient environment keeps the credential from leaking into this repo's own
 * tooling, and makes the failure mode ("SayMei is not checked out here") legible.
 */
function readDatabaseUrl(): string {
  const envPath = join(SAYMEI_ROOT, ".env");
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${envPath}.\n` +
        `  enrich:fetch needs a SayMei checkout; set ZHONGDEX_SAYMEI_ROOT to it.\n` +
        `  If you only want to build, you do not need this: \`npm run build\` reads the\n` +
        `  committed snapshot at data/enrichment.json and never opens a connection.`,
    );
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("DATABASE_URL=")) continue;
    const value = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return value;
  }
  throw new Error(`${envPath} has no non-empty DATABASE_URL.`);
}

/** The sliver of `pg` this module uses. Structural, so no dependency on its types. */
interface PgQueryResult {
  rows: unknown[];
}
interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: {
    connectionString: string;
    ssl: { rejectUnauthorized: boolean };
    statement_timeout: number;
  }) => PgClient;
}

async function connect(): Promise<PgClient> {
  const entry = join(SAYMEI_ROOT, "node_modules", "pg", "lib", "index.js");
  // Non-literal specifier on purpose: `pg` is not a dependency of this repo and
  // must not become one. See the module header.
  const loaded = (await import(entry)) as { default?: PgModule } & Partial<PgModule>;
  const pg = loaded.default ?? (loaded as PgModule);
  if (typeof pg.Client !== "function") {
    throw new Error(`${entry} did not export a Client constructor.`);
  }
  const client = new pg.Client({
    connectionString: readDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
    // A read that cannot finish in a minute is a bug, not something to wait on
    // while holding a connection to production.
    statement_timeout: 60_000,
  });
  await client.connect();
  return client;
}

/* -------------------------------------------------------------------------- */
/* Row shaping                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // pg returns bigint-ish columns as strings; count(*) is the one that matters here.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The one query                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read the enrichment columns for a set of simplified forms.
 *
 * `audio_url` is reduced to a boolean inside the query, so the URL never
 * crosses this boundary and cannot be leaked into the snapshot by a later edit.
 * See `WordAudio` in types.ts for why publishing those paths is forbidden.
 */
export async function fetchDictionaryRows(
  simplifiedForms: readonly string[],
): Promise<FetchResult> {
  const client = await connect();
  try {
    const totals = await client.query(
      `select count(*) as table_rows,
              count(hsk_new_level) as hsk_new_level,
              count(hsk_old_level) as hsk_old_level,
              count(frequency_rank) as frequency_rank,
              count(zipf_score) as zipf_score,
              count(audio_url) as audio_url
         from global_dictionary`,
    );
    const totalsRow = totals.rows[0];
    if (!isRecord(totalsRow)) throw new Error("global_dictionary: coverage query returned no row.");

    const columnCoverage: Record<string, number> = {};
    for (const column of ["hsk_new_level", "hsk_old_level", "frequency_rank", "zipf_score", "audio_url"]) {
      columnCoverage[column] = asNumberOrNull(totalsRow[column]) ?? 0;
    }
    for (const [column, count] of Object.entries(columnCoverage)) {
      if (count === 0) {
        throw new Error(
          `global_dictionary.${column} is non-null on 0 rows. Refusing to capture an ` +
            `all-null column — add it to COLUMNS_DROPPED instead.`,
        );
      }
    }

    const result = await client.query(
      `select characters,
              pinyin_numbered,
              hsk_new_level,
              hsk_old_level,
              frequency_rank,
              zipf_score,
              (audio_url is not null and audio_url <> '') as has_audio
         from global_dictionary
        where characters = any($1::text[])`,
      [simplifiedForms],
    );

    const rowsByForm = new Map<string, SnapshotRow[]>();
    for (const raw of result.rows) {
      if (!isRecord(raw)) continue;
      const form = asString(raw["characters"]);
      if (form === "") continue;
      const bucket = rowsByForm.get(form) ?? [];
      bucket.push({
        py: normalizeReading(asString(raw["pinyin_numbered"])),
        b2021: asNumberOrNull(raw["hsk_new_level"]),
        b20: asNumberOrNull(raw["hsk_old_level"]),
        rank: asNumberOrNull(raw["frequency_rank"]),
        zipf: asNumberOrNull(raw["zipf_score"]),
        audio: raw["has_audio"] === true,
      });
      rowsByForm.set(form, bucket);
    }

    return {
      rowsByForm,
      tableRows: asNumberOrNull(totalsRow["table_rows"]) ?? 0,
      columnCoverage,
    };
  } finally {
    await client.end();
  }
}
