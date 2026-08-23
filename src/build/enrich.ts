/**
 * Zhongdex enrichment capture — `npm run enrich:fetch`.
 *
 * Reads the columns the canon wants from SayMei's production dictionary and
 * writes `data/enrichment.json`, which is committed to this repo.
 *
 * The split exists so the build has exactly one live dependency and it is
 * optional: this script needs a database, `npm run build:canon` needs a file.
 * A clone with no credentials, no network and no SayMei checkout builds the
 * full canon from the committed snapshot; a clone with no snapshot at all still
 * builds, with every enriched field marked unknown. Neither path can fail
 * because production was slow, migrated, or unreachable.
 *
 * Order of operations, since the snapshot is keyed by the canon's own words:
 *
 *   npm run build:canon     (once, to have a word list — enrichment optional)
 *   npm run enrich:fetch    (this script; needs the SayMei checkout)
 *   npm run build:canon     (again, now with the snapshot joined in)
 *
 * Only the second `build:canon` differs, and only in the enriched fields. The
 * word list, ids, bands and definitions do not depend on this script at all.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COLUMNS_DROPPED, COLUMNS_READ, fetchDictionaryRows } from "./db.js";
import type { EnrichmentSnapshot, SnapshotRow } from "./types.js";

const REPO_ROOT = new URL("../../", import.meta.url);
const DATA_DIR = fileURLToPath(new URL("data/", REPO_ROOT));
const CANON_JSON = `${DATA_DIR}hsk_bands.json`;
const SNAPSHOT_JSON = `${DATA_DIR}enrichment.json`;

/** Code-unit order. `localeCompare` depends on host ICU data and would not be reproducible. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The distinct simplified forms of the current canon, in code-unit order. */
function readCanonForms(): string[] {
  let text: string;
  try {
    text = readFileSync(CANON_JSON, "utf8");
  } catch {
    throw new Error(
      `${CANON_JSON} is missing. Run \`npm run build:canon\` first — this script captures\n` +
        `  enrichment for the canon's own word list, so the word list has to exist.`,
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${CANON_JSON} is not a JSON array.`);
  const forms = new Set<string>();
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const simplified = (row as Record<string, unknown>)["simplified"];
    if (typeof simplified === "string" && simplified !== "") forms.add(simplified);
  }
  if (forms.size === 0) throw new Error(`${CANON_JSON} yielded no simplified forms.`);
  return [...forms].sort(compareStrings);
}

/**
 * Total order over the rows of one simplified form.
 *
 * Postgres makes no ordering promise without an ORDER BY, and even with one the
 * rows for a form are not distinguishable by any single column. Sorting the
 * captured rows here means two fetches of unchanged data produce byte-identical
 * files, so a no-op refresh shows up as a no-op diff.
 */
function compareRows(a: SnapshotRow, b: SnapshotRow): number {
  return (
    compareStrings(a.py, b.py) ||
    (a.b2021 ?? -1) - (b.b2021 ?? -1) ||
    (a.b20 ?? -1) - (b.b20 ?? -1) ||
    (a.rank ?? -1) - (b.rank ?? -1) ||
    (a.zipf ?? -1) - (b.zipf ?? -1) ||
    Number(a.audio) - Number(b.audio)
  );
}

/** One line per simplified form: valid JSON, and it diffs line by line in git. */
function serialize(snapshot: EnrichmentSnapshot): string {
  const { words, ...head } = snapshot;
  const keys = Object.keys(words).sort(compareStrings);
  const body = keys
    .map((key) => {
      const rows = words[key] ?? [];
      return `${JSON.stringify(key)}: ${JSON.stringify(rows)}`;
    })
    .join(",\n  ");
  const headJson = JSON.stringify(head, null, 2).slice(1, -1).trimEnd();
  return `{${headJson},\n  "words": {\n  ${body}\n  }\n}\n`;
}

async function main(): Promise<void> {
  const log = (line: string): void => void process.stderr.write(`${line}\n`);

  const forms = readCanonForms();
  log(`enrich: canon has ${String(forms.length)} distinct simplified forms`);
  log(`enrich: reading ${COLUMNS_READ.join(", ")} from global_dictionary (SELECT only)`);

  const { rowsByForm, tableRows, columnCoverage } = await fetchDictionaryRows(forms);

  const words: Record<string, SnapshotRow[]> = {};
  let rows = 0;
  for (const form of forms) {
    const captured = rowsByForm.get(form);
    if (captured === undefined || captured.length === 0) continue;
    const sorted = [...captured].sort(compareRows);
    words[form] = sorted;
    rows += sorted.length;
  }

  const snapshot: EnrichmentSnapshot = {
    schema: "zhongdex/enrichment/v1",
    generator: "src/build/enrich.ts",
    capturedAt: new Date().toISOString(),
    source: {
      system: "SayMei production Postgres",
      table: "global_dictionary",
      tableRows,
      columns: columnCoverage,
      droppedColumns: COLUMNS_DROPPED,
      notes: [
        "Captured read-only. This file is the build's input; the database is not.",
        "audio_url is reduced to a boolean at the query. The clips sit on Railway object " +
          "storage with metered egress, so their paths are never captured or published.",
        "Counts in `columns` are table-wide non-null counts at capture time, not counts " +
          "for the captured subset.",
      ],
    },
    formsRequested: forms.length,
    formsMatched: Object.keys(words).length,
    rows,
    words,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_JSON, serialize(snapshot));

  log(
    `enrich: matched ${String(snapshot.formsMatched)}/${String(forms.length)} forms, ` +
      `captured ${String(rows)} rows from ${String(tableRows)} table rows`,
  );
  for (const [column, count] of Object.entries(columnCoverage)) {
    log(`enrich:   ${column.padEnd(16)} ${String(count)} non-null table-wide`);
  }
  for (const [column, why] of Object.entries(COLUMNS_DROPPED)) {
    log(`enrich:   DROPPED ${column} — ${why}`);
  }
  log(`enrich: wrote data/enrichment.json — commit it, the build reads it offline`);
}

await main();
