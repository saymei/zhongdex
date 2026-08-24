#!/usr/bin/env node
/**
 * Tier 1 — the agent eval.
 *
 * Tier 0 (`evals/contract.ts`) asserts the dataset's promises. This asserts the
 * *server's*: it starts `src/mcp/server.ts` as a real child process, speaks
 * stdio JSON-RPC to it exactly as Claude Desktop or Claude Code would, and runs
 * eleven jobs of the kind people actually bring to a Mandarin corpus — build an
 * HSK 3 deck, find 把 sentences at HSK 4, page through a pack, read a
 * polyphone — plus ten of the mistakes agents actually make.
 *
 * Three numbers come out, and the third is the one that matters:
 *
 *   pass rate       did the call sequence produce the right result, asserted
 *                   mechanically against the data
 *   tokens per task how much of the context window each job costs
 *   recovery rate   when a call fails, does the error hand back a next call
 *                   that *works* — executed, not eyeballed
 *
 * Everything is asserted against the data files, re-read by this file's own
 * loader. It deliberately does not import `src/mcp/data.ts`: an eval that
 * reuses the loader it is checking proves only that the implementation agrees
 * with itself. Where a check needs a number — how many band-3 words there are,
 * which sentences contain 把 at grade ≤ 4 — the number is computed here from
 * `data/hsk_bands.json`, `data/packs/*.json` and `data/sentences.jsonl`.
 *
 * No task hard-codes a corpus fact. Every expectation is derived at run time,
 * so a rebuild that legitimately changes the corpus does not need this file
 * edited — and one that changes it illegitimately still fails Tier 0.
 *
 * Usage:  npm run eval:agent            deterministic tier only, no network
 *         npm run eval:agent -- --llm   also run a real model against the server
 * Exit:   0 = every check passed · 1 = checks failed · 2 = could not run
 *
 * The markdown table goes to stdout so it can be piped straight into a README;
 * progress goes to stderr. The full artifact is written to data/agent-eval.json.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  renderMarkdown,
  writeReport,
  type CallRecord,
  type CheckResult,
  type LlmTaskResult,
  type LlmTier,
  type RecoveryResult,
  type SuggestionKind,
  type TaskResult,
} from "./agent-report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const PACK_DIR = join(DATA_DIR, "packs");
const SERVER = join(ROOT, "src", "mcp", "server.ts");
const REPORT_PATH = join(DATA_DIR, "agent-eval.json");

/** The per-response ceiling the server renders under, restated here to check it. */
const TOKEN_BUDGET = 10_000;

/** One request may not take longer than this. A hung server is a failed eval. */
const REQUEST_TIMEOUT_MS = 60_000;

type Args = Record<string, unknown>;

function abort(message: string): never {
  process.stderr.write(`\nagent eval could not run\n\n  ${message}\n\n`);
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* The facts, read independently of the server                                 */
/* -------------------------------------------------------------------------- */

interface Word {
  id: string;
  simplified: string;
  pinyinNumbered: string;
  band2026: number | null;
  gloss: string[];
}

interface Sentence {
  id: string;
  hanzi: string;
  zsg: number | null;
  newWordCount: Record<string, number>;
}

interface Pack {
  slug: string;
  size: number;
  wordIds: string[];
}

interface Facts {
  version: string;
  words: Word[];
  byId: Map<string, Word>;
  bySimplified: Map<string, Word[]>;
  packs: Map<string, Pack>;
  sentences: Map<string, Sentence>;
  bandCount: (band: number) => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) abort(`${path} is missing. Run \`npm run build\` first.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return abort(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function loadFacts(): Facts {
  const canon = readJson(join(DATA_DIR, "hsk_bands.json"));
  if (!Array.isArray(canon)) abort("data/hsk_bands.json is not a JSON array.");
  const words: Word[] = [];
  for (const row of canon) {
    if (!isRecord(row)) continue;
    const simplified = row["simplified"];
    const pinyin = row["pinyin"];
    const hsk = row["hsk"];
    if (typeof simplified !== "string" || !isRecord(pinyin) || !isRecord(hsk)) continue;
    const definitions = row["definitions"];
    const gloss: string[] = [];
    if (Array.isArray(definitions)) {
      for (const entry of definitions) {
        if (isRecord(entry) && typeof entry["text"] === "string") gloss.push(entry["text"]);
      }
    }
    const band = hsk["band2026"];
    words.push({
      id: typeof row["id"] === "string" ? row["id"] : "",
      simplified,
      pinyinNumbered: typeof pinyin["numbered"] === "string" ? pinyin["numbered"] : "",
      band2026: typeof band === "number" ? band : null,
      gloss,
    });
  }
  if (words.length === 0) abort("data/hsk_bands.json yielded no word records.");

  const byId = new Map<string, Word>();
  const bySimplified = new Map<string, Word[]>();
  for (const word of words) {
    if (!byId.has(word.id)) byId.set(word.id, word);
    const bucket = bySimplified.get(word.simplified) ?? [];
    bucket.push(word);
    bySimplified.set(word.simplified, bucket);
  }

  const packs = new Map<string, Pack>();
  if (!existsSync(PACK_DIR)) abort(`${PACK_DIR} is missing. Run \`npm run build\` first.`);
  for (const file of readdirSync(PACK_DIR).sort()) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    const doc = readJson(join(PACK_DIR, file));
    if (!isRecord(doc)) continue;
    const slug = doc["slug"];
    const wordIds = doc["words"];
    if (typeof slug !== "string" || !Array.isArray(wordIds)) continue;
    packs.set(slug, {
      slug,
      size: typeof doc["size"] === "number" ? doc["size"] : wordIds.length,
      wordIds: wordIds.filter((id): id is string => typeof id === "string"),
    });
  }

  const sentences = new Map<string, Sentence>();
  const jsonl = join(DATA_DIR, "sentences.jsonl");
  if (existsSync(jsonl)) {
    for (const line of readFileSync(jsonl, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const id = parsed["id"];
      const hanzi = parsed["hanzi"];
      if (typeof id !== "string" || typeof hanzi !== "string") continue;
      const counts: Record<string, number> = {};
      const raw = parsed["newWordCount"];
      if (isRecord(raw)) {
        for (const [band, value] of Object.entries(raw)) {
          if (typeof value === "number") counts[band] = value;
        }
      }
      const zsg = parsed["zsg"];
      sentences.set(id, {
        id,
        hanzi,
        zsg: typeof zsg === "number" ? zsg : null,
        newWordCount: counts,
      });
    }
  }

  const index = readJson(join(PACK_DIR, "index.json"));
  const version =
    isRecord(index) && typeof index["corpusVersion"] === "string" ? index["corpusVersion"] : "unknown";

  return {
    version,
    words,
    byId,
    bySimplified,
    packs,
    sentences,
    bandCount: (band) => words.filter((word) => word.band2026 === band).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Token estimate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stated, not measured: CJK codepoints count 1 token each, everything else 4
 * characters to the token. There is no tokenizer in this repo and tier 1 makes
 * no network calls, so the honest move is to publish the rule next to the byte
 * count and let a reader recompute. Tier 2, when it runs, counts the same
 * responses with a real tokenizer and reports the ratio.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2ebef)
    ) {
      cjk += 1;
    } else {
      rest += 1;
    }
  }
  return cjk + Math.ceil(rest / 4);
}

/* -------------------------------------------------------------------------- */
/* The client: real stdio JSON-RPC against a real child process                */
/* -------------------------------------------------------------------------- */

interface ToolReply {
  text: string;
  isError: boolean;
  structured: Record<string, unknown> | null;
  bytes: number;
  tokens: number;
}

class McpClient {
  private readonly child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private stderr = "";
  /** The server's own `instructions` string, as the host receives it. */
  instructions = "";

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.absorb(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  /** Spawn the server the way an MCP host does: a process, stdio, nothing else. */
  static async start(): Promise<McpClient> {
    const child = spawn(process.execPath, ["--import", "tsx", SERVER], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const client = new McpClient(child);
    const handshake = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zhongdex-agent-eval", version: "1" },
    });
    const result = handshake["result"];
    if (isRecord(result) && typeof result["instructions"] === "string") {
      client.instructions = result["instructions"];
    }
    client.notify("notifications/initialized", {});
    return client;
  }

  private absorb(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      const id = message["id"];
      if (typeof id !== "number") continue;
      const resolve = this.pending.get(id);
      if (resolve === undefined) continue;
      this.pending.delete(id);
      resolve(message);
    }
  }

  private notify(method: string, params: Args): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method: string, params: Args): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} did not answer in ${String(REQUEST_TIMEOUT_MS)} ms. Server stderr:\n${this.stderr}`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return message;
  }

  /** One `tools/call`, with the response measured. */
  async callTool(name: string, args: Args): Promise<ToolReply> {
    const message = await this.request("tools/call", { name, arguments: args });
    const error = message["error"];
    if (isRecord(error)) {
      const text = typeof error["message"] === "string" ? error["message"] : JSON.stringify(error);
      return {
        text,
        isError: true,
        structured: null,
        bytes: Buffer.byteLength(text, "utf8"),
        tokens: estimateTokens(text),
      };
    }
    const result = message["result"];
    if (!isRecord(result)) throw new Error(`tools/call ${name} returned no result`);
    const content = result["content"];
    let text = "";
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && typeof block["text"] === "string") text += block["text"];
      }
    }
    const structured = result["structuredContent"];
    return {
      text,
      isError: result["isError"] === true,
      structured: isRecord(structured) ? structured : null,
      bytes: Buffer.byteLength(text, "utf8"),
      tokens: estimateTokens(text),
    };
  }

  stop(): void {
    this.child.kill();
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the server's responses                                              */
/* -------------------------------------------------------------------------- */

/** Word ids, one per row, as `mandarin_find_words` renders them. */
function wordIdsIn(text: string): string[] {
  return [...text.matchAll(/^(dex:w:\S+)/gm)].map((match) => match[1] ?? "");
}

/** Sentence ids, one per block head. */
function sentenceIdsIn(text: string): string[] {
  return [...text.matchAll(/^(dex:s:[^\s·]+)/gm)].map((match) => match[1] ?? "");
}

/** The `id dex:w:…` line `mandarin_lookup` puts on every record. */
function lookupIdsIn(text: string): string[] {
  return [...text.matchAll(/^id (dex:w:\S+)/gm)].map((match) => match[1] ?? "");
}

function headwordsIn(text: string): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? "");
}

/** `— 20 of 973 words · …` → the total the footer claims. */
function footerTotal(text: string): number | null {
  const match = /^— \d+ of ([\d,]+) \w+/m.exec(text);
  if (match === null) return null;
  return Number((match[1] ?? "").replace(/,/g, ""));
}

function footerShown(text: string): number | null {
  const match = /^— (\d+) of [\d,]+ \w+/m.exec(text);
  if (match === null) return null;
  return Number(match[1] ?? "");
}

function nextCursor(text: string): string | null {
  const match = /next_cursor "([^"]+)"/.exec(text);
  return match === null ? null : (match[1] ?? null);
}

function notesOf(reply: ToolReply): Record<string, unknown>[] {
  const notes = reply.structured?.["notes"];
  if (!Array.isArray(notes)) return [];
  return notes.filter(isRecord);
}

function fieldsOf(note: Record<string, unknown>): Record<string, string> {
  const fields = note["fields"];
  if (!isRecord(fields)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Recovery: extract a next step from an error, mechanically                   */
/* -------------------------------------------------------------------------- */

interface Suggestion {
  kind: SuggestionKind;
  tool: string;
  args: Args;
  rendered: string;
}

const NO_SUGGESTION: Suggestion = { kind: "none", tool: "", args: {}, rendered: "" };

/**
 * Parse `mandarin_find_words({hsk:1, limit:20})` into a tool and arguments.
 *
 * The argument body is JSON5-ish — bare keys, single or double quotes — because
 * it is written to be pasted into a call, not to be parsed. Normalising it to
 * JSON is a dozen characters of regex and keeps the eval from having to
 * hand-write what each error "meant".
 */
function parseCall(source: string): { tool: string; args: Args } | null {
  const match = /(mandarin_[a-z_]+)\(\{([\s\S]*?)\}\)/.exec(source);
  if (match === null) return null;
  const tool = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (body === "") return { tool, args: {} };
  const json = `{${body}}`
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? { tool, args: parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Turn an error message into a next call, without a model reading it.
 *
 * Order matters: an explicit `Next:` clause is the server's own contract and
 * beats anything inferred. A "did you mean" that names a legal replacement for
 * something the caller actually passed is next, because it is unambiguous —
 * the rejected token is matched against the original arguments, so the fix is
 * applied to the argument that was wrong rather than guessed at. A bare literal
 * call anywhere in the message is last: it is usually an example, not a fix.
 */
function extractSuggestion(errorText: string, tool: string, args: Args): Suggestion {
  const render = (name: string, body: Args): string =>
    `${name}(${JSON.stringify(body).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1:")})`;

  const nextClause = /Next:([\s\S]*)$/m.exec(errorText);
  if (nextClause !== null) {
    const parsed = parseCall(nextClause[1] ?? "");
    if (parsed !== null) {
      return {
        kind: "literal-call",
        tool: parsed.tool,
        args: parsed.args,
        rendered: render(parsed.tool, parsed.args),
      };
    }
  }

  // `No pack "hsk3". Did you mean "hsk-2026-t3" …` — the rejected token is a
  // value here and a parameter name in E8, and the two need different repairs.
  const rejected = /(?:No pack|No pattern|Unknown parameter|Unknown field) "([^"]+)"/.exec(errorText);
  const meant = /Did you mean "([^"]+)"/.exec(errorText);
  if (rejected !== null && meant !== null) {
    const bad = rejected[1] ?? "";
    const good = meant[1] ?? "";
    for (const [key, value] of Object.entries(args)) {
      if (value === bad) {
        const repaired: Args = { ...args, [key]: good };
        return {
          kind: "param-override",
          tool,
          args: repaired,
          rendered: render(tool, repaired),
        };
      }
      if (key === bad) {
        const repaired: Args = { ...args, [good]: value };
        delete repaired[bad];
        return { kind: "param-rename", tool, args: repaired, rendered: render(tool, repaired) };
      }
    }
  }

  // `Pass voice:"female".` / `call again with band_standard:"hsk2021"`.
  const override = /(?:Pass|pass|call again with) ([a-z_]+):"([^"]+)"/.exec(errorText);
  if (override !== null) {
    const repaired: Args = { ...args, [override[1] ?? ""]: override[2] ?? "" };
    return { kind: "param-override", tool, args: repaired, rendered: render(tool, repaired) };
  }

  const anyCall = parseCall(errorText);
  if (anyCall !== null) {
    return {
      kind: "literal-call",
      tool: anyCall.tool,
      args: anyCall.args,
      rendered: render(anyCall.tool, anyCall.args),
    };
  }
  return NO_SUGGESTION;
}

/* -------------------------------------------------------------------------- */
/* Task machinery                                                              */
/* -------------------------------------------------------------------------- */

interface Step {
  tool: string;
  args: Args;
  reply: ToolReply;
}

class Context {
  readonly calls: CallRecord[] = [];
  readonly checks: CheckResult[] = [];
  readonly steps: Step[] = [];
  /** Response bodies, kept so tier 2 can re-count the same text with a real tokenizer. */
  readonly bodies: string[] = [];
  recovery: RecoveryResult | null = null;

  constructor(
    private readonly client: McpClient,
    readonly facts: Facts,
  ) {}

  async call(tool: string, args: Args): Promise<ToolReply> {
    const reply = await this.client.callTool(tool, args);
    this.calls.push({
      tool,
      args,
      isError: reply.isError,
      bytes: reply.bytes,
      tokens: reply.tokens,
    });
    this.steps.push({ tool, args, reply });
    this.bodies.push(reply.text);
    return reply;
  }

  check(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail });
  }

  /** `expected === actual`, with both sides printed when they are not. */
  equal(name: string, actual: unknown, expected: unknown): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.check(name, ok, ok ? `${JSON.stringify(actual)}` : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }

  /**
   * Extract a next call from a failed reply, execute it, and record whether it
   * worked. This is the recovery metric: nothing is graded on the wording of an
   * error, only on whether the call it hands back succeeds.
   */
  async attemptRecovery(reply: ToolReply, tool: string, args: Args): Promise<void> {
    const suggestion = extractSuggestion(reply.text, tool, args);
    if (suggestion.kind === "none") {
      this.recovery = {
        errorText: reply.text.split("\n\n—")[0] ?? reply.text,
        kind: "none",
        suggested: "",
        recovered: false,
        detail:
          "The message names no call, no replacement value and no replacement parameter. " +
          "An agent has to infer the next step from prose.",
      };
      return;
    }
    const executed = await this.call(suggestion.tool, suggestion.args);
    const recovered = !executed.isError;
    this.recovery = {
      errorText: reply.text.split("\n\n—")[0] ?? reply.text,
      kind: suggestion.kind,
      suggested: suggestion.rendered,
      recovered,
      detail: recovered
        ? `Returned ${String(executed.bytes)} B, isError: false.`
        : `Re-ran and failed again: ${(executed.text.split("\n")[0] ?? "").slice(0, 160)}`,
    };
  }
}

interface LlmSpec {
  /** The job in a user's words. The model gets this and the server's own tool list. */
  prompt: string;
  /** Did the model's own trajectory do the job? Mechanical, same data, no judge. */
  verify: (steps: readonly Step[], facts: Facts) => { ok: boolean; detail: string };
}

interface Task {
  id: string;
  job: string;
  kind: "job" | "failure";
  run: (ctx: Context) => Promise<void>;
  llm?: LlmSpec;
}

/* -------------------------------------------------------------------------- */
/* The tasks                                                                   */
/* -------------------------------------------------------------------------- */

/** Simplified forms with exactly one canon record, so a lookup returns one block each. */
function unambiguousForms(facts: Facts, band: number, count: number): string[] {
  const out: string[] = [];
  for (const word of facts.words) {
    if (out.length >= count) break;
    if (word.band2026 !== band) continue;
    if ((facts.bySimplified.get(word.simplified) ?? []).length !== 1) continue;
    out.push(word.simplified);
  }
  return out;
}

const TASKS: readonly Task[] = [
  {
    id: "deck-hsk3-50",
    job: "Build a 50-word HSK 3 deck",
    kind: "job",
    llm: {
      prompt:
        "Build me a 50-word flashcard deck for HSK 3, ready to import into Anki. " +
        "Call the deck Zhongdex::HSK 3.",
      verify: (steps, facts) => {
        const deck = steps.find((s) => s.tool === "mandarin_build_deck" && !s.reply.isError);
        if (deck === undefined) return { ok: false, detail: "never called mandarin_build_deck" };
        const notes = notesOf(deck.reply);
        const hanzi = notes.map((note) => fieldsOf(note)["Hanzi"] ?? "");
        const offBand = hanzi.filter(
          (form) => (facts.bySimplified.get(form) ?? []).every((w) => w.band2026 !== 3),
        );
        return {
          ok: notes.length === 50 && offBand.length === 0,
          detail: `${String(notes.length)} notes, ${String(offBand.length)} not in band 3`,
        };
      },
    },
    async run(ctx) {
      const found = await ctx.call("mandarin_find_words", { hsk: 3, limit: 50 });
      const ids = wordIdsIn(found.text);
      ctx.check("find_words succeeded", !found.isError, found.isError ? found.text : "ok");
      ctx.equal("returned 50 ids", ids.length, 50);
      const offBand = ids.filter((id) => ctx.facts.byId.get(id)?.band2026 !== 3);
      ctx.equal("every id is a band-3 canon record", offBand.length, 0);
      ctx.equal("footer total is the band-3 count", footerTotal(found.text), ctx.facts.bandCount(3));

      const deck = await ctx.call("mandarin_build_deck", {
        words: ids,
        deck_name: "Zhongdex::HSK 3",
        voice: "female",
      });
      const notes = notesOf(deck);
      ctx.check("build_deck succeeded", !deck.isError, deck.isError ? deck.text : "ok");
      ctx.equal("50 notes", notes.length, 50);
      ctx.equal(
        "note order and content match the ids",
        notes.map((note) => fieldsOf(note)["Hanzi"] ?? ""),
        ids.map((id) => ctx.facts.byId.get(id)?.simplified ?? ""),
      );
      const missingFields = notes.filter((note) => {
        const fields = fieldsOf(note);
        return !("Hanzi" in fields) || !("Pinyin" in fields) || !("English" in fields);
      });
      ctx.equal("every note carries Hanzi, Pinyin and English", missingFields.length, 0);
      ctx.equal("media[] is empty while audio is unhosted", deck.structured?.["media"], []);
      ctx.equal("audio_status is pending", deck.structured?.["audio_status"], "pending");
      const withSound = notes.filter((note) =>
        Object.values(fieldsOf(note)).some((value) => value.includes("[sound:")),
      );
      ctx.equal("no [sound:] reference in any note field", withSound.length, 0);
    },
  },
  {
    id: "band-cumulative",
    job: "Words for a learner who has finished HSK 1–3",
    kind: "job",
    async run(ctx) {
      const reply = await ctx.call("mandarin_find_words", { hsk: 3, scope: "cumulative", limit: 20 });
      const ids = wordIdsIn(reply.text);
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      ctx.equal("returned 20 ids", ids.length, 20);
      const above = ids.filter((id) => (ctx.facts.byId.get(id)?.band2026 ?? 99) > 3);
      ctx.equal("nothing above band 3", above.length, 0);
      const expected =
        ctx.facts.bandCount(1) + ctx.facts.bandCount(2) + ctx.facts.bandCount(3);
      ctx.equal("footer total is bands 1-3", footerTotal(reply.text), expected);
    },
  },
  {
    id: "tone3-band2",
    job: "The tone-3 words in HSK band 2",
    kind: "job",
    async run(ctx) {
      const reply = await ctx.call("mandarin_find_words", {
        hsk: 2,
        query: "3",
        query_type: "pinyin",
        limit: 100,
      });
      const ids = wordIdsIn(reply.text);
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      const wrong = ids.filter((id) => {
        const word = ctx.facts.byId.get(id);
        return word === undefined || word.band2026 !== 2 || !word.pinyinNumbered.includes("3");
      });
      ctx.equal("every hit is band 2 and carries a tone-3 syllable", wrong.length, 0);
      const expected = ctx.facts.words.filter(
        (word) => word.band2026 === 2 && word.pinyinNumbered.includes("3"),
      ).length;
      ctx.equal("footer total matches the corpus", footerTotal(reply.text), expected);
      ctx.equal("page is capped at the limit", ids.length, Math.min(100, expected));
    },
  },
  {
    id: "polyphone-readings",
    job: "What are the readings of 行",
    kind: "job",
    llm: {
      prompt: "What are the readings of the Chinese character 行, and what does each one mean?",
      verify: (steps) => {
        const hit = steps.find((s) => !s.reply.isError && s.reply.text.includes("háng"));
        return {
          ok: hit !== undefined,
          detail: hit === undefined ? "no response contained the háng reading" : "found both readings",
        };
      },
    },
    async run(ctx) {
      const all = await ctx.call("mandarin_lookup", { words: ["行"] });
      const expected = ctx.facts.bySimplified.get("行") ?? [];
      ctx.check("succeeded", !all.isError, all.isError ? all.text : "ok");
      ctx.equal("one block per reading", headwordsIn(all.text).length, expected.length);
      ctx.equal(
        "the ids are the canon's 行 records",
        [...lookupIdsIn(all.text)].sort(),
        expected.map((word) => word.id).sort(),
      );
      ctx.check(
        "the response says the readings are ambiguous",
        all.text.includes("readings"),
        all.text.split("\n")[0] ?? "",
      );

      const pinned = await ctx.call("mandarin_lookup", { words: ["行:hang2"] });
      ctx.equal("pinning a reading returns exactly one record", headwordsIn(pinned.text).length, 1);
      ctx.equal(
        "and it is the hang2 record",
        lookupIdsIn(pinned.text),
        expected.filter((word) => word.pinyinNumbered.replace(/\s/g, "") === "hang2").map((w) => w.id),
      );
    },
  },
  {
    id: "batch-lookup",
    job: "Look up ten words at once for flashcards",
    kind: "job",
    async run(ctx) {
      const forms = unambiguousForms(ctx.facts, 1, 10);
      const reply = await ctx.call("mandarin_lookup", { words: forms, sentences: 1 });
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      ctx.equal("ten records back", lookupIdsIn(reply.text).length, 10);
      const missing = forms.filter((form) => !reply.text.includes(form));
      ctx.equal("every requested word appears", missing.length, 0);
      ctx.check(
        "one batch stays inside the response budget",
        reply.tokens <= TOKEN_BUDGET,
        `${String(reply.tokens)} tokens`,
      );
      ctx.check(
        "no audio url is emitted",
        !/https?:\/\//.test(reply.text),
        /https?:\/\//.test(reply.text) ? "found a url" : "none",
      );
    },
  },
  {
    id: "ba-sentences",
    job: "Ten sentences using 把 at HSK 4",
    kind: "job",
    llm: {
      prompt:
        "Find me 10 example sentences that use the 把 construction, suitable for an HSK 4 learner.",
      verify: (steps, facts) => {
        const hit = steps.find((s) => s.tool === "mandarin_find_sentences" && !s.reply.isError);
        if (hit === undefined) return { ok: false, detail: "no successful sentence search" };
        const ids = sentenceIdsIn(hit.reply.text);
        const withBa = ids.filter((id) => (facts.sentences.get(id)?.hanzi ?? "").includes("把"));
        return {
          ok: ids.length > 0 && withBa.length === ids.length,
          detail: `${String(withBa.length)}/${String(ids.length)} sentences contain 把`,
        };
      },
    },
    async run(ctx) {
      const reply = await ctx.call("mandarin_find_sentences", { contains: "把", hsk: 4, count: 10 });
      const ids = sentenceIdsIn(reply.text);
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      ctx.equal("ten sentences", ids.length, 10);
      const unknown = ids.filter((id) => !ctx.facts.sentences.has(id));
      ctx.equal("every id is a real corpus sentence", unknown.length, 0);
      const withoutBa = ids.filter((id) => !(ctx.facts.sentences.get(id)?.hanzi ?? "").includes("把"));
      ctx.equal("every sentence contains 把", withoutBa.length, 0);
      const tooHard = ids.filter((id) => (ctx.facts.sentences.get(id)?.zsg ?? 0) > 4);
      ctx.equal("nothing graded above HSK 4", tooHard.length, 0);
      ctx.equal("footer shows what it returned", footerShown(reply.text), 10);
    },
  },
  {
    id: "i-plus-one",
    job: "Sentences where 把 is the only new word at HSK 4",
    kind: "job",
    llm: {
      prompt:
        "I am at HSK 4. Find me 5 example sentences containing 把 where at most one word in the " +
        "sentence is above my level.",
      verify: (steps, facts) => {
        const hit = steps.find((s) => s.tool === "mandarin_find_sentences" && !s.reply.isError);
        if (hit === undefined) return { ok: false, detail: "no successful sentence search" };
        const ids = sentenceIdsIn(hit.reply.text);
        const bad = ids.filter((id) => (facts.sentences.get(id)?.newWordCount["4"] ?? 99) > 1);
        return {
          ok: ids.length > 0 && bad.length === 0,
          detail: `${String(ids.length)} sentences, ${String(bad.length)} over the i+1 limit`,
        };
      },
    },
    async run(ctx) {
      const reply = await ctx.call("mandarin_find_sentences", {
        contains: "把",
        hsk: 4,
        max_new_words: 1,
        count: 5,
      });
      const ids = sentenceIdsIn(reply.text);
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      ctx.equal("five sentences", ids.length, 5);
      const violations = ids.filter((id) => {
        const sentence = ctx.facts.sentences.get(id);
        return sentence === undefined || (sentence.newWordCount["4"] ?? 99) > 1;
      });
      ctx.equal("every sentence has at most one word outside HSK 4", violations.length, 0);
      const expected = [...ctx.facts.sentences.values()].filter(
        (sentence) =>
          sentence.hanzi.includes("把") &&
          (sentence.zsg ?? 0) <= 4 &&
          (sentence.newWordCount["4"] ?? 99) <= 1,
      ).length;
      ctx.equal("footer total matches the corpus", footerTotal(reply.text), expected);
    },
  },
  {
    id: "packs-catalogue",
    job: "What ready-made word lists are there",
    kind: "job",
    llm: {
      prompt: "What ready-made Chinese vocabulary packs do you have? Just list them.",
      verify: (steps, facts) => {
        const hit = steps.find((s) => s.tool === "mandarin_packs" && !s.reply.isError);
        if (hit === undefined) return { ok: false, detail: "never called mandarin_packs" };
        const listed = [...facts.packs.keys()].filter((slug) => hit.reply.text.includes(slug));
        return {
          ok: listed.length === facts.packs.size,
          detail: `${String(listed.length)}/${String(facts.packs.size)} packs listed`,
        };
      },
    },
    async run(ctx) {
      const reply = await ctx.call("mandarin_packs", {});
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      ctx.equal("footer total is the pack count", footerTotal(reply.text), ctx.facts.packs.size);
      const missing = [...ctx.facts.packs.keys()].filter((slug) => !reply.text.includes(slug));
      ctx.equal("every pack on disk is listed", missing.length, 0);
      ctx.check(
        "the whole catalogue fits in one cheap call",
        reply.tokens < 2_500,
        `${String(reply.tokens)} tokens`,
      );
    },
  },
  {
    id: "pack-paging",
    job: "Page through a 500-word pack",
    kind: "job",
    async run(ctx) {
      const slug = "hsk-2026-t1";
      const pack = ctx.facts.packs.get(slug);
      if (pack === undefined) {
        ctx.check(`pack ${slug} exists on disk`, false, "missing");
        return;
      }
      const first = await ctx.call("mandarin_find_words", { pack: slug, limit: 100 });
      const firstIds = wordIdsIn(first.text);
      ctx.check("first page succeeded", !first.isError, first.isError ? first.text : "ok");
      ctx.equal("100 words on the first page", firstIds.length, 100);
      ctx.equal("footer total is the pack size", footerTotal(first.text), pack.size);
      const cursor = nextCursor(first.text);
      ctx.check("a cursor is offered", cursor !== null, cursor ?? "none");
      if (cursor === null) return;

      const second = await ctx.call("mandarin_find_words", { pack: slug, limit: 100, cursor });
      const secondIds = wordIdsIn(second.text);
      ctx.check("second page succeeded", !second.isError, second.isError ? second.text : "ok");
      ctx.equal("100 words on the second page", secondIds.length, 100);
      const overlap = secondIds.filter((id) => firstIds.includes(id));
      ctx.equal("the pages do not overlap", overlap.length, 0);
      const strangers = [...firstIds, ...secondIds].filter((id) => !pack.wordIds.includes(id));
      ctx.equal("every word paged is a member of the pack", strangers.length, 0);
    },
  },
  {
    id: "deck-minus-known",
    job: "Deck from a pack, minus what the learner already knows",
    kind: "job",
    llm: {
      prompt:
        "Build me a deck from your numerals pack, but leave out any word that is already in HSK 1 — " +
        "I know those.",
      verify: (steps, facts) => {
        const deck = steps.find((s) => s.tool === "mandarin_build_deck" && !s.reply.isError);
        if (deck === undefined) return { ok: false, detail: "never called mandarin_build_deck" };
        const known = new Set(
          (facts.packs.get("hsk-2026-t1")?.wordIds ?? []).map(
            (id) => facts.byId.get(id)?.simplified ?? "",
          ),
        );
        const notes = notesOf(deck.reply);
        const leaked = notes.filter((note) => known.has(fieldsOf(note)["Hanzi"] ?? ""));
        return {
          ok: notes.length > 0 && leaked.length === 0,
          detail: `${String(notes.length)} notes, ${String(leaked.length)} already known`,
        };
      },
    },
    async run(ctx) {
      const source = ctx.facts.packs.get("pos-numerals");
      const known = ctx.facts.packs.get("hsk-2026-t1");
      if (source === undefined || known === undefined) {
        ctx.check("both packs exist on disk", false, "missing");
        return;
      }
      const reply = await ctx.call("mandarin_build_deck", {
        pack: source.slug,
        exclude_packs: [known.slug],
        deck_name: "Zhongdex::Numerals",
      });
      const notes = notesOf(reply);
      ctx.check("succeeded", !reply.isError, reply.isError ? reply.text : "ok");
      const expected = source.wordIds.filter((id) => !known.wordIds.includes(id));
      ctx.equal("the deck is the pack minus the excluded pack", notes.length, expected.length);
      const excludedForms = new Set(
        known.wordIds.map((id) => ctx.facts.byId.get(id)?.simplified ?? ""),
      );
      const leaked = notes.filter((note) => excludedForms.has(fieldsOf(note)["Hanzi"] ?? ""));
      ctx.equal("nothing from the excluded pack survives", leaked.length, 0);
    },
  },
  {
    id: "audio-check",
    job: "Check whether recordings exist before paying a TTS provider",
    kind: "job",
    async run(ctx) {
      const words = unambiguousForms(ctx.facts, 1, 3);
      const reply = await ctx.call("mandarin_audio", { text: words, check_only: true });
      ctx.check(
        "not an error — an honest answer is not a failure",
        !reply.isError,
        reply.text.slice(0, 120),
      );
      // Asserted on shape, not on wording: every requested string has to open a
      // verdict line of its own, whatever the verdict turns out to say.
      const unanswered = words.filter(
        (word) => !new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `, "m").test(reply.text),
      );
      ctx.equal("every string gets a verdict of its own", unanswered.length, 0);
      ctx.check(
        "no url is returned",
        !/https?:\/\//.test(reply.text),
        /https?:\/\//.test(reply.text) ? "found a url" : "none",
      );
      ctx.check(
        "it says nothing was synthesised or billed",
        reply.text.includes("nothing was billed"),
        reply.text.split("\n")[0] ?? "",
      );
      ctx.check("a check sweep is cheap", reply.tokens < 500, `${String(reply.tokens)} tokens`);
    },
  },

  /* ── deliberate failures ─────────────────────────────────────────────── */

  {
    id: "fail-overconstrained-words",
    job: "Over-constrained word filter (band 1 words with rank > 200,000)",
    kind: "failure",
    async run(ctx) {
      const args: Args = { hsk: 1, freq_min: 200_000 };
      const reply = await ctx.call("mandarin_find_words", args);
      ctx.check("comes back as a tool error, not a protocol error", reply.isError, reply.text.slice(0, 80));
      ctx.check("says how many matched", reply.text.startsWith("0 words match"), reply.text.slice(0, 40));
      ctx.check(
        "names the filters it applied",
        reply.text.includes("hsk 1") && reply.text.includes("freq"),
        reply.text.slice(0, 120),
      );
      ctx.check(
        "counts what relaxing a filter would give",
        /gives [\d,]+ match/.test(reply.text),
        reply.text.slice(0, 160),
      );
      await ctx.attemptRecovery(reply, "mandarin_find_words", args);
    },
  },
  {
    id: "fail-overconstrained-sentences",
    job: "Over-constrained sentence filter (把 at grade 1)",
    kind: "failure",
    async run(ctx) {
      const args: Args = { contains: "把", hsk: 1, difficulty: 1, count: 10 };
      const reply = await ctx.call("mandarin_find_sentences", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check("says how many matched", reply.text.startsWith("0 sentences match"), reply.text.slice(0, 40));
      await ctx.attemptRecovery(reply, "mandarin_find_sentences", args);
    },
  },
  {
    id: "fail-unknown-word",
    job: "Looking up an English word as if it were Chinese",
    kind: "failure",
    async run(ctx) {
      const args: Args = { words: ["hello"] };
      const reply = await ctx.call("mandarin_lookup", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "says why, not just that",
        reply.text.includes("neither Han characters nor valid numbered pinyin"),
        reply.text.slice(0, 120),
      );
      await ctx.attemptRecovery(reply, "mandarin_lookup", args);
    },
  },
  {
    id: "fail-nonsense-word",
    job: "Looking up a string that is not a word in any language",
    kind: "failure",
    async run(ctx) {
      const args: Args = { words: ["blorf"] };
      const reply = await ctx.call("mandarin_lookup", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "reports the miss count out of the batch",
        /\d+ of \d+ words missed/.test(reply.text),
        reply.text.slice(0, 120),
      );
      await ctx.attemptRecovery(reply, "mandarin_lookup", args);
    },
  },
  {
    id: "fail-unknown-pack",
    job: "Guessing a pack id (`hsk3`)",
    kind: "failure",
    async run(ctx) {
      const args: Args = { pack: "hsk3" };
      const reply = await ctx.call("mandarin_find_words", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "offers a real pack id",
        [...ctx.facts.packs.keys()].some((slug) => reply.text.includes(`"${slug}"`)),
        reply.text.slice(0, 120),
      );
      await ctx.attemptRecovery(reply, "mandarin_find_words", args);
    },
  },
  {
    id: "fail-stale-cursor",
    job: "Paging with a cursor from an older release",
    kind: "failure",
    async run(ctx) {
      const args: Args = { hsk: 2, limit: 5, cursor: "dex:w:ni3hao3:你好:int@2025.01" };
      const reply = await ctx.call("mandarin_find_words", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "names the release the cursor came from",
        reply.text.includes("2025.01") && reply.text.includes(ctx.facts.version),
        reply.text.slice(0, 140),
      );
      await ctx.attemptRecovery(reply, "mandarin_find_words", args);
    },
  },
  {
    id: "fail-unknown-pattern",
    job: "Filtering by a grammar pattern this release does not ship",
    kind: "failure",
    async run(ctx) {
      const args: Args = { pattern: "ba-disposal", hsk: 4, count: 10 };
      const reply = await ctx.call("mandarin_find_sentences", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "says the index is absent rather than pretending to search it",
        reply.text.includes("no grammar-pattern index"),
        reply.text.slice(0, 140),
      );
      await ctx.attemptRecovery(reply, "mandarin_find_sentences", args);
    },
  },
  {
    id: "fail-bad-enum",
    job: "Passing the voice's name instead of its value (`voice:\"amy\"`)",
    kind: "failure",
    async run(ctx) {
      const args: Args = { words: unambiguousForms(ctx.facts, 1, 1), voice: "amy" };
      const reply = await ctx.call("mandarin_lookup", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "lists the legal values",
        reply.text.includes("both, female, male"),
        reply.text.slice(0, 120),
      );
      await ctx.attemptRecovery(reply, "mandarin_lookup", args);
    },
  },
  {
    id: "fail-not-a-headword",
    job: "Looking up 你好, which this list does not carry as one entry",
    kind: "failure",
    async run(ctx) {
      const args: Args = { words: ["你好"] };
      const reply = await ctx.call("mandarin_lookup", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "segments it into words the corpus does have",
        reply.text.includes("Segmented into known words"),
        reply.text.slice(0, 140),
      );
      const segments = [...reply.text.matchAll(/\((dex:w:\S+?)\)/g)].map((m) => m[1] ?? "");
      const unknown = segments.filter((id) => !ctx.facts.byId.has(id));
      ctx.equal("every id it names is a real canon record", unknown.length, 0);
      await ctx.attemptRecovery(reply, "mandarin_lookup", args);
    },
  },
  {
    id: "fail-batch-cap",
    job: "Sending 25 words to a tool that takes 20",
    kind: "failure",
    async run(ctx) {
      const words = unambiguousForms(ctx.facts, 1, 25);
      const args: Args = { words };
      const reply = await ctx.call("mandarin_lookup", args);
      ctx.check("comes back as a tool error", reply.isError, reply.text.slice(0, 80));
      ctx.check(
        "states the cap and what was passed",
        reply.text.includes("at most 20 words") && reply.text.includes("you passed 25"),
        reply.text.slice(0, 120),
      );
      ctx.check(
        "nothing is silently truncated",
        !reply.text.includes("dex:w:"),
        "no records returned alongside the error",
      );
      await ctx.attemptRecovery(reply, "mandarin_lookup", args);
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Tier 2 — a real model, if one is reachable                                  */
/* -------------------------------------------------------------------------- */

const MODEL = "gemini-2.5-flash";
const MODEL_TURNS = 5;

/**
 * A key, from the environment first and a SayMei checkout second — the same
 * convention `src/build/db.ts` uses for its credential, and for the same
 * reason: nothing secret is ever read from, or written to, this repo.
 */
function modelKey(): { key: string; from: string } | null {
  const direct = process.env["ZHONGDEX_EVAL_MODEL_KEY"] ?? process.env["GEMINI_API_KEY"];
  if (direct !== undefined && direct !== "") return { key: direct, from: "environment" };
  const root =
    process.env["ZHONGDEX_SAYMEI_ROOT"] ?? process.env["SAYMEI_ROOT"] ?? "/Users/lelandchar/Desktop/SayMei-Web";
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("GEMINI_LIVE_API_KEY=")) continue;
    const value = trimmed.slice("GEMINI_LIVE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return { key: value, from: `${envPath} (GEMINI_LIVE_API_KEY)` };
  }
  return null;
}

interface GeminiPart {
  text?: string;
}

async function generate(key: string, contents: unknown, system: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    },
  );
  if (!response.ok) throw new Error(`${MODEL}: HTTP ${String(response.status)}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`${MODEL}: unreadable response`);
  const candidates = body["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = candidates[0];
  if (!isRecord(first)) return "";
  const content = first["content"];
  if (!isRecord(content)) return "";
  const parts = content["parts"];
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (part as GeminiPart).text ?? "").join("");
}

/** Real tokenizer count for a set of response bodies. */
async function countTokens(key: string, texts: readonly string[]): Promise<number | null> {
  if (texts.length === 0) return 0;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: texts.map((text) => ({ text })) }],
        }),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const total = body["totalTokens"];
    return typeof total === "number" ? total : null;
  } catch {
    return null;
  }
}

/**
 * Run one job the way an agent would: the model is handed the server's own
 * `instructions` string and its own tool list — nothing this eval wrote — and
 * picks its own calls. It is scored by the same mechanical check as tier 1, so
 * a model that reaches the right result by a different route still passes.
 */
async function runLlmTask(
  key: string,
  client: McpClient,
  facts: Facts,
  task: Task,
  toolCatalogue: string,
  instructions: string,
): Promise<LlmTaskResult> {
  const spec = task.llm;
  if (spec === undefined) {
    return { id: task.id, trajectory: [], passed: false, detail: "no prompt", measuredTokens: null };
  }
  const system =
    `${instructions}\n\nTools available:\n${toolCatalogue}\n\n` +
    "Answer with JSON only. To call a tool: " +
    '{"tool":"<name>","arguments":{…}}. When the job is done: {"done":true}. ' +
    "One object per reply, no prose, no markdown fences.";

  const contents: { role: string; parts: { text: string }[] }[] = [
    { role: "user", parts: [{ text: spec.prompt }] },
  ];
  const steps: Step[] = [];
  const trajectory: string[] = [];
  const responses: string[] = [];

  for (let turn = 0; turn < MODEL_TURNS; turn += 1) {
    let raw: string;
    try {
      raw = await generate(key, contents, system);
    } catch (error) {
      return {
        id: task.id,
        trajectory,
        passed: false,
        detail: `model call failed: ${(error as Error).message}`,
        measuredTokens: null,
      };
    }
    contents.push({ role: "model", parts: [{ text: raw }] });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      break;
    }
    if (!isRecord(parsed)) break;
    if (parsed["done"] === true) break;
    const name = parsed["tool"];
    if (typeof name !== "string") break;
    const args = isRecord(parsed["arguments"]) ? parsed["arguments"] : {};
    const reply = await client.callTool(name, args);
    steps.push({ tool: name, args, reply });
    responses.push(reply.text);
    trajectory.push(`${name}(${JSON.stringify(args)})`);
    // The model sees what an agent would see, truncated the way a host truncates.
    contents.push({
      role: "user",
      parts: [{ text: reply.text.slice(0, 4_000) }],
    });
  }

  const verdict = spec.verify(steps, facts);
  return {
    id: task.id,
    trajectory,
    passed: verdict.ok,
    detail: verdict.detail,
    measuredTokens: await countTokens(key, responses),
  };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const started = Date.now();
  const wantLlm = process.argv.includes("--llm");
  const facts = loadFacts();
  const log = (line: string): void => void process.stderr.write(`${line}\n`);

  let client: McpClient;
  try {
    client = await McpClient.start();
  } catch (error) {
    return abort(`could not start ${SERVER}: ${(error as Error).message}`);
  }

  const results: TaskResult[] = [];
  const bodies: string[] = [];
  try {
    for (const task of TASKS) {
      const ctx = new Context(client, facts);
      try {
        await task.run(ctx);
      } catch (error) {
        ctx.check("task ran to completion", false, (error as Error).message);
      }
      bodies.push(...ctx.bodies);
      const passed = ctx.checks.every((check) => check.ok) && ctx.checks.length > 0;
      results.push({
        id: task.id,
        job: task.job,
        kind: task.kind,
        calls: ctx.calls,
        checks: ctx.checks,
        passed,
        bytes: ctx.calls.reduce((n, call) => n + call.bytes, 0),
        tokens: ctx.calls.reduce((n, call) => n + call.tokens, 0),
        recovery: ctx.recovery,
      });
      log(
        `  ${passed ? "PASS" : "FAIL"}  ${task.id.padEnd(30)} ` +
          `${String(ctx.calls.length)} calls · ${String(ctx.calls.reduce((n, c) => n + c.tokens, 0))} tok` +
          `${ctx.recovery === null ? "" : ctx.recovery.recovered ? " · recovered" : " · NOT recovered"}`,
      );
    }

    /* Tier 2. A skipped run does not delete the last one: the artifact is
       published, and dropping the model results because someone re-ran tier 1
       would be losing a measurement, not refreshing it. The carried-over block
       says when it was taken. */
    let llmTier: LlmTier = {
      status: "skipped",
      reason: "not requested; pass --llm to run it.",
      model: null,
      ranAt: null,
      tasks: [],
      summary: null,
      tokenAccuracy: null,
    };
    if (!wantLlm && existsSync(REPORT_PATH)) {
      const previous = readJson(REPORT_PATH);
      const carried = isRecord(previous) ? previous["llmTier"] : null;
      if (isRecord(carried) && carried["status"] === "ran") {
        llmTier = {
          ...(carried as unknown as LlmTier),
          reason: `carried over from the ${String(carried["ranAt"])} run; re-run with --llm to refresh.`,
        };
      }
    }
    if (wantLlm) {
      const credential = modelKey();
      if (credential === null) {
        llmTier = {
          ...llmTier,
          reason:
            "no model key found in ZHONGDEX_EVAL_MODEL_KEY, GEMINI_API_KEY, or a SayMei checkout's .env.",
        };
        log("  tier 2 skipped: no key");
      } else {
        log(`  tier 2: ${MODEL}, key from ${credential.from}`);
        const listed = await client.request("tools/list", {});
        const tools = listed["result"];
        const toolRows: string[] = [];
        if (isRecord(tools) && Array.isArray(tools["tools"])) {
          for (const tool of tools["tools"]) {
            if (!isRecord(tool)) continue;
            toolRows.push(
              `- ${String(tool["name"])}: ${String(tool["description"]).slice(0, 700)}\n  input: ${JSON.stringify(tool["inputSchema"])}`,
            );
          }
        }
        const llmTasks: LlmTaskResult[] = [];
        for (const task of TASKS) {
          if (task.llm === undefined) continue;
          const result = await runLlmTask(
            credential.key,
            client,
            facts,
            task,
            toolRows.join("\n"),
            client.instructions,
          );
          llmTasks.push(result);
          log(`  ${result.passed ? "PASS" : "FAIL"}  ${task.id.padEnd(30)} tier 2 · ${result.detail}`);
        }

        // The estimator, checked against a real tokenizer on the exact response
        // bodies tier 1 measured. Capped so the check is one request.
        const sampleTexts: string[] = [];
        let sampleChars = 0;
        for (const body of bodies) {
          if (sampleChars + body.length > 150_000) break;
          sampleTexts.push(body);
          sampleChars += body.length;
        }
        const estimated = sampleTexts.reduce((n, text) => n + estimateTokens(text), 0);
        const measured = await countTokens(credential.key, sampleTexts);
        llmTier = {
          status: "ran",
          reason: `key from ${credential.from}`,
          model: MODEL,
          ranAt: new Date().toISOString().slice(0, 10),
          tasks: llmTasks,
          summary: {
            tasksAttempted: llmTasks.length,
            tasksPassed: llmTasks.filter((t) => t.passed).length,
            passRate:
              llmTasks.length === 0
                ? 0
                : Number(
                    ((llmTasks.filter((t) => t.passed).length / llmTasks.length) * 100).toFixed(1),
                  ),
          },
          tokenAccuracy:
            measured === null || measured === 0 || sampleTexts.length === 0
              ? null
              : {
                  estimatedTokens: estimated,
                  measuredTokens: measured,
                  ratio: Number((estimated / measured).toFixed(2)),
                  tokenizer: `${MODEL} countTokens, over ${String(sampleTexts.length)} tier-1 responses`,
                },
        };
      }
    }

    const report = buildReport(facts.version, results, llmTier, TOKEN_BUDGET);
    writeReport(REPORT_PATH, report);
    process.stdout.write(`${renderMarkdown(report)}\n`);

    const elapsed = Date.now() - started;
    log(
      `\nagent eval: ${String(report.summary.passed)}/${String(report.summary.tasks)} tasks, ` +
        `${String(report.summary.checksPassed)}/${String(report.summary.checks)} checks, ` +
        `recovery ${report.summary.recoveryRate.toFixed(1)}% ` +
        `(${String(report.summary.recoveriesSucceeded)}/${String(report.summary.recoveriesOffered)}), ` +
        `${String(elapsed)} ms — wrote data/agent-eval.json`,
    );
    if (report.summary.passed !== report.summary.tasks) {
      for (const task of results) {
        if (task.passed) continue;
        for (const check of task.checks) {
          if (check.ok) continue;
          log(`  FAIL  ${task.id}  ${check.name}: ${check.detail}`);
        }
      }
      process.exitCode = 1;
    }
  } finally {
    client.stop();
  }
}

main().catch((error: unknown) => {
  abort((error as Error).message);
});
