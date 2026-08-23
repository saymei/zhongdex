/**
 * `npm run export:anki` — build importable Anki decks from the canon.
 *
 * Emits into dist/anki/:
 *   Zhongdex-HSK-2026-t1.apkg  ...  -t6.apkg, -t7-9.apkg   one deck per band
 *   Zhongdex-HSK-2026-Complete.apkg                        all seven as subdecks
 *
 * An .apkg is a zip holding a SQLite collection plus a media manifest. This
 * writes the legacy-but-universally-accepted layout: `collection.anki2` at
 * schema 11 (`col.ver = 11`) and a `media` file of `{}`. The schema, the `col`
 * defaults, the note/card column order and the base91 guid encoding all follow
 * kerrickstaley/genanki (`apkg_schema.py`, `apkg_col.py`, `util.guid_for`),
 * which is the reference implementation current Anki still imports.
 *
 * SQLite comes from `node:sqlite`, built into Node 22 — no new dependency.
 *
 * NO AUDIO in this release: the clips are not hosted yet, so the note type has
 * no audio field rather than a `[sound:...]` reference that would 404.
 *
 * Deterministic: ids are derived from stable hashes and counters, never from
 * the clock, so two builds of the same corpus produce the same bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BandLabel, CanonWord, ExampleSentence } from "./shared.js";
import {
  BANDS,
  bandLabel,
  bandTitle,
  corpusVersion,
  DIST_DIR,
  ensureDir,
  escapeHtml,
  humanBytes,
  loadCanon,
  loadSentencesByWordId,
  markedPinyin,
  numberedPinyin,
  posLabel,
  sha256Hex,
  stableInt,
  zipBuffer,
} from "./shared.js";

const OUT_DIR = join(DIST_DIR, "anki");
const SITE = "https://www.saymei.app";
const UTM = "utm_source=anki&utm_medium=deck&utm_campaign=zhongdex";
const ATTRIBUTION_HTML =
  `Zhongdex &middot; free HSK 3.0 (2026) data from ` +
  `<a href="${SITE}/?${UTM}">SayMei</a> &middot; CC BY-SA 4.0`;

/** Anki id space is ms-since-epoch. Fixed base keeps the build hermetic. */
const ID_BASE = 1_700_000_000_000;
/** genanki's `crt`: the collection creation day start. */
const COLLECTION_CREATED = 1_411_124_400;
const MODEL_ID = ID_BASE + stableInt("zhongdex:model:word:v1", 32);
const MAX_EXAMPLES = 3;

/* -------------------------------------------------------------------------- */
/* Schema (genanki apkg_schema.py)                                             */
/* -------------------------------------------------------------------------- */

const APKG_SCHEMA = `
CREATE TABLE col (
    id integer primary key, crt integer not null, mod integer not null,
    scm integer not null, ver integer not null, dty integer not null,
    usn integer not null, ls integer not null, conf text not null,
    models text not null, decks text not null, dconf text not null,
    tags text not null
);
CREATE TABLE notes (
    id integer primary key, guid text not null, mid integer not null,
    mod integer not null, usn integer not null, tags text not null,
    flds text not null, sfld integer not null, csum integer not null,
    flags integer not null, data text not null
);
CREATE TABLE cards (
    id integer primary key, nid integer not null, did integer not null,
    ord integer not null, mod integer not null, usn integer not null,
    type integer not null, queue integer not null, due integer not null,
    ivl integer not null, factor integer not null, reps integer not null,
    lapses integer not null, left integer not null, odue integer not null,
    odid integer not null, flags integer not null, data text not null
);
CREATE TABLE revlog (
    id integer primary key, cid integer not null, usn integer not null,
    ease integer not null, ivl integer not null, lastIvl integer not null,
    factor integer not null, time integer not null, type integer not null
);
CREATE TABLE graves (
    usn integer not null, oid integer not null, type integer not null
);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const COL_CONF = {
  activeDecks: [1],
  addToCur: true,
  collapseTime: 1200,
  curDeck: 1,
  curModel: String(MODEL_ID),
  dueCounts: true,
  estTimes: true,
  newBury: true,
  newSpread: 0,
  nextPos: 1,
  sortBackwards: false,
  sortType: "noteFld",
  timeLim: 0,
};

const COL_DCONF = {
  "1": {
    autoplay: true,
    id: 1,
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
    maxTaken: 60,
    mod: 0,
    name: "Default",
    new: {
      bury: true,
      delays: [1, 10],
      initialFactor: 2500,
      ints: [1, 4, 7],
      order: 1,
      perDay: 20,
      separate: true,
    },
    replayq: true,
    rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
    timer: 0,
    usn: 0,
  },
};

/* -------------------------------------------------------------------------- */
/* Note type                                                                   */
/* -------------------------------------------------------------------------- */

const FIELD_NAMES = [
  "Hanzi",
  "Traditional",
  "Pinyin",
  "PinyinNumbered",
  "Meaning",
  "HSK",
  "Examples",
  "ZhongdexId",
] as const;

const CARD_CSS = `
.card {
  font-family: -apple-system, "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: 20px;
  text-align: center;
  color: #1c1917;
  background: #fdfcfb;
}
.zd-hanzi { font-size: 64px; line-height: 1.2; margin: 12px 0; }
.zd-pinyin { font-size: 26px; color: #b45309; margin-bottom: 4px; }
.zd-numbered { font-size: 15px; color: #8a8580; margin-bottom: 12px; }
.zd-meaning { font-size: 20px; text-align: left; display: inline-block; max-width: 34em; }
.zd-band { font-size: 13px; color: #78716c; letter-spacing: .04em; text-transform: uppercase; }
.zd-trad { font-size: 15px; color: #78716c; margin-top: 6px; }
.zd-examples { margin-top: 16px; text-align: left; display: inline-block; max-width: 34em; }
.zd-ex { margin: 8px 0; }
.zd-ex-hanzi { font-size: 19px; }
.zd-ex-pinyin { font-size: 14px; color: #8a8580; }
.zd-ex-en { font-size: 14px; color: #57534e; }
.zd-credit { margin-top: 22px; font-size: 12px; color: #8a8580; }
.zd-credit a { color: #b45309; text-decoration: none; }
.nightMode .card, .night_mode .card { color: #e7e5e4; background: #1c1917; }
.nightMode .zd-credit, .night_mode .zd-credit { color: #a8a29e; }
`.trim();

const QFMT = `
<div class="zd-band">{{HSK}}</div>
<div class="zd-hanzi">{{Hanzi}}</div>
<div class="zd-credit">${ATTRIBUTION_HTML}</div>
`.trim();

const AFMT = `
{{FrontSide}}

<hr id=answer>

<div class="zd-pinyin">{{Pinyin}}</div>
<div class="zd-numbered">{{PinyinNumbered}}</div>
<div class="zd-meaning">{{Meaning}}</div>
{{#Traditional}}<div class="zd-trad">Traditional: {{Traditional}}</div>{{/Traditional}}
{{#Examples}}<div class="zd-examples">{{Examples}}</div>{{/Examples}}

<div class="zd-credit">${ATTRIBUTION_HTML}</div>
`.trim();

function modelJson(deckId: number): Record<string, unknown> {
  return {
    id: String(MODEL_ID),
    name: "Zhongdex Word (HSK 3.0 2026)",
    type: 0,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: deckId,
    css: CARD_CSS,
    latexPre:
      "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n" +
      "\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n" +
      "\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
    latexPost: "\\end{document}",
    latexsvg: false,
    flds: FIELD_NAMES.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: "Arial",
      size: 20,
      media: [],
    })),
    tmpls: [
      {
        name: "Recognition",
        ord: 0,
        qfmt: QFMT,
        afmt: AFMT,
        did: null,
        bqfmt: "",
        bafmt: "",
        bfont: "",
        bsize: 0,
      },
    ],
    // Hanzi is the only field the question side needs.
    req: [[0, "all", [0]]],
    tags: [],
    vers: [],
  };
}

function deckJson(id: number, name: string, description: string): Record<string, unknown> {
  return {
    id,
    name,
    desc: description,
    collapsed: false,
    conf: 1,
    dyn: 0,
    extendNew: 0,
    extendRev: 50,
    lrnToday: [0, 0],
    newToday: [0, 0],
    revToday: [0, 0],
    timeToday: [0, 0],
    mod: 0,
    usn: -1,
  };
}

/* -------------------------------------------------------------------------- */
/* Note rendering                                                              */
/* -------------------------------------------------------------------------- */

const BASE91 =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/** Anki's base91 note guid, seeded deterministically from the Zhongdex id. */
function guidFor(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 8);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  const radix = BigInt(BASE91.length);
  let out = "";
  while (value > 0n) {
    out = BASE91[Number(value % radix)] + out;
    value /= radix;
  }
  return out === "" ? "a" : out;
}

/** Anki's note checksum: the first 8 hex digits of sha1(sort field). */
function fieldChecksum(text: string): number {
  return Number.parseInt(createHash("sha1").update(text).digest("hex").slice(0, 8), 16);
}

function meaningHtml(word: CanonWord): string {
  const glosses = word.definitions.map((definition) => escapeHtml(definition.text));
  if (glosses.length === 0) return "";
  if (glosses.length === 1) return glosses[0] ?? "";
  return `<ol>${glosses.map((gloss) => `<li>${gloss}</li>`).join("")}</ol>`;
}

function examplesHtml(sentences: readonly ExampleSentence[]): string {
  if (sentences.length === 0) return "";
  return sentences
    .slice(0, MAX_EXAMPLES)
    .map((sentence) => {
      const rows = [`<div class="zd-ex-hanzi">${escapeHtml(sentence.hanzi)}</div>`];
      if (sentence.pinyin !== null) {
        rows.push(`<div class="zd-ex-pinyin">${escapeHtml(sentence.pinyin)}</div>`);
      }
      if (sentence.english !== null) {
        rows.push(`<div class="zd-ex-en">${escapeHtml(sentence.english)}</div>`);
      }
      return `<div class="zd-ex">${rows.join("")}</div>`;
    })
    .join("");
}

function bandTagFor(band: BandLabel): string {
  return `zhongdex::hsk::${band}`;
}

function noteTags(word: CanonWord, band: BandLabel | null): string {
  const tags = ["zhongdex"];
  if (band !== null) tags.push(bandTagFor(band));
  for (const pos of word.pos) tags.push(`zhongdex::pos::${posLabel(pos).replace(/\s+/g, "-")}`);
  return ` ${tags.join(" ")} `;
}

interface NoteRow {
  readonly fields: readonly string[];
  readonly sortField: string;
  readonly guid: string;
  readonly tags: string;
  readonly deckId: number;
}

function toNote(
  word: CanonWord,
  band: BandLabel | null,
  sentences: readonly ExampleSentence[],
  deckId: number,
): NoteRow {
  const traditional = word.traditional === word.simplified ? "" : word.traditional;
  const fields = [
    escapeHtml(word.simplified),
    escapeHtml(traditional),
    escapeHtml(markedPinyin(word)),
    escapeHtml(numberedPinyin(word)),
    meaningHtml(word),
    band === null ? "" : `${bandTitle(band)} (2026)`,
    examplesHtml(sentences),
    escapeHtml(word.id),
  ];
  return {
    fields,
    sortField: escapeHtml(word.simplified),
    guid: guidFor(word.id),
    tags: noteTags(word, band),
    deckId,
  };
}

/* -------------------------------------------------------------------------- */
/* Collection writing                                                          */
/* -------------------------------------------------------------------------- */

interface DeckSpec {
  readonly id: number;
  readonly name: string;
  readonly description: string;
}

function writeCollection(dbPath: string, decks: readonly DeckSpec[], notes: readonly NoteRow[]): void {
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(APKG_SCHEMA);

    const primaryDeck = decks[0];
    if (primaryDeck === undefined) throw new Error("a collection needs at least one deck");

    const decksJson: Record<string, unknown> = {
      "1": deckJson(1, "Default", ""),
    };
    for (const deck of decks) decksJson[String(deck.id)] = deckJson(deck.id, deck.name, deck.description);

    db.prepare(
      "INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
    ).run(
      COLLECTION_CREATED,
      JSON.stringify(COL_CONF),
      JSON.stringify({ [String(MODEL_ID)]: modelJson(primaryDeck.id) }),
      JSON.stringify(decksJson),
      JSON.stringify(COL_DCONF),
    );

    const insertNote = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const insertCard = db.prepare("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");

    db.exec("BEGIN");
    notes.forEach((note, i) => {
      const noteId = ID_BASE + i * 2;
      const cardId = noteId + 1;
      insertNote.run(
        noteId,
        note.guid,
        MODEL_ID,
        0,
        -1,
        note.tags,
        note.fields.join("\u001f"),
        note.sortField,
        fieldChecksum(note.sortField),
        0,
        "",
      );
      insertCard.run(cardId, noteId, note.deckId, 0, 0, -1, 0, 0, i + 1, 0, 0, 0, 0, 0, 0, 0, 0, "");
    });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Packaging                                                                   */
/* -------------------------------------------------------------------------- */

function writeApkg(
  fileName: string,
  decks: readonly DeckSpec[],
  notes: readonly NoteRow[],
): { path: string; bytes: number; sha256: string } {
  ensureDir(OUT_DIR);
  const apkgPath = join(OUT_DIR, fileName);
  const dbPath = join(OUT_DIR, `.${fileName}.anki2.tmp`);
  writeCollection(dbPath, decks, notes);

  const collection = readFileSync(dbPath);
  rmSync(dbPath, { force: true });

  const buffer = zipBuffer([
    { name: "collection.anki2", data: collection },
    { name: "media", data: Buffer.from("{}", "utf8") },
  ]);
  writeFileSync(apkgPath, buffer);
  return { path: apkgPath, bytes: buffer.length, sha256: sha256Hex(buffer) };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const ROOT_DECK = "Zhongdex HSK 2026";

function deckDescription(scope: string, size: number): string {
  return (
    `${scope} — ${String(size)} words from the HSK 3.0 syllabus effective 1 July 2026. ` +
    `Glosses from CC-CEDICT (CC BY-SA 4.0). Built by Zhongdex, free and open, from SayMei: ${SITE}. ` +
    `Corpus ${corpusVersion()}. No audio in this release.`
  );
}

function main(): void {
  const words = loadCanon();
  const sentencesByWord = loadSentencesByWordId();
  process.stdout.write(
    `canon: ${String(words.length)} words, ` +
      `${String(sentencesByWord.size)} with example sentences (corpus ${corpusVersion()})\n`,
  );

  const byBand = new Map<BandLabel, CanonWord[]>();
  let unbanded = 0;
  for (const word of words) {
    const band = bandLabel(word);
    if (band === null) {
      unbanded += 1;
      continue;
    }
    const bucket = byBand.get(band);
    if (bucket === undefined) byBand.set(band, [word]);
    else bucket.push(word);
  }
  if (unbanded > 0) process.stdout.write(`  ${String(unbanded)} words carry no 2026 band and are not decked\n`);

  const combinedDecks: DeckSpec[] = [
    { id: ID_BASE + stableInt(`zhongdex:deck:${ROOT_DECK}`, 32), name: ROOT_DECK, description: deckDescription("Every band", words.length - unbanded) },
  ];
  const combinedNotes: NoteRow[] = [];
  let total = 0;

  for (const band of BANDS) {
    const bandWords = byBand.get(band) ?? [];
    if (bandWords.length === 0) continue;
    const deckName = `${ROOT_DECK}::${bandTitle(band)}`;
    const deckId = ID_BASE + stableInt(`zhongdex:deck:${deckName}`, 32);
    const description = deckDescription(bandTitle(band), bandWords.length);

    const notes = bandWords.map((word) => toNote(word, band, sentencesByWord.get(word.id) ?? [], deckId));
    combinedNotes.push(...notes);
    combinedDecks.push({ id: deckId, name: deckName, description });

    const parentId = combinedDecks[0]?.id ?? deckId;
    const result = writeApkg(
      `Zhongdex-HSK-2026-t${band}.apkg`,
      [
        { id: deckId, name: deckName, description },
        { id: parentId, name: ROOT_DECK, description: deckDescription("Every band", words.length - unbanded) },
      ],
      notes,
    );
    total += notes.length;
    process.stdout.write(
      `${deckName}: ${String(notes.length)} notes, ${humanBytes(result.bytes)} -> ${result.path}\n`,
    );
  }

  const combined = writeApkg("Zhongdex-HSK-2026-Complete.apkg", combinedDecks, combinedNotes);
  process.stdout.write(
    `${ROOT_DECK} (combined, ${String(combinedDecks.length - 1)} subdecks): ` +
      `${String(combinedNotes.length)} notes, ${humanBytes(combined.bytes)} -> ${combined.path}\n`,
  );
  process.stdout.write(`total notes written across band decks: ${String(total)}\n`);
}

main();
