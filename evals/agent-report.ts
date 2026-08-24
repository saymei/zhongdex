#!/usr/bin/env node
/**
 * Tier 1 — the agent eval's report shapes, artifact and table.
 *
 * `evals/agent-tasks.ts` drives the real MCP server and produces the results;
 * this module owns what they mean and how they are published. It is separate
 * for one reason: the numbers in the README have to be regenerable without
 * re-running the suite, so `tsx evals/agent-report.ts` re-renders the table
 * from the committed `data/agent-eval.json` alone.
 *
 * ── The three metrics ──────────────────────────────────────────────────────
 *
 * **Pass rate** — a task passes when every one of its checks passes. Checks are
 * mechanical and are computed against the data files, never against the
 * server's own loader: `data/hsk_bands.json`, `data/packs/*.json` and
 * `data/sentences.jsonl` are re-read independently by the suite, so a check
 * cannot be satisfied by an implementation agreeing with itself.
 *
 * **Tokens per task** — every byte the server writes back, per task, plus an
 * estimate in tokens. There is no tokenizer in this repo and no network in
 * tier 1, so the estimate is stated rather than measured:
 *
 *     tokens ≈ (CJK codepoints × 1) + (every other codepoint ÷ 4)
 *
 * That is the usual published rule of thumb for Chinese text; it is an
 * estimate, it is not a tokenizer, and `bytes` is reported next to it so
 * anyone can recompute the column with a real one. When the optional tier 2
 * runs, every task is also counted by a real tokenizer over the network and
 * `llmTier.tokenAccuracy` reports how far the estimate was off.
 *
 * **Recovery rate** — the one that matters, and the one almost nobody
 * measures. For each deliberate failure, the eval extracts a next step from
 * the error *mechanically* — no model, no human reading — and executes it
 * against the same server. It counts as a recovery only if that call comes
 * back with `isError: false`. Three extraction shapes are accepted, and every
 * result records which one it used:
 *
 *   literal-call    the message contains a pasteable call, e.g.
 *                   `Next: mandarin_find_sentences({contains:"把", hsk:4})`.
 *   param-override  the message names a parameter and a value to pass instead
 *                   (`Pass voice:"female".`); applied to the original arguments.
 *   param-rename    the message rejects a parameter and names the one that was
 *                   meant (`Unknown parameter "level" … Did you mean "limit"?`);
 *                   the value moves across.
 *
 * An error that offers none of the three is recorded as `none`, is not a
 * recovery, and is listed by name in the report. That is the honest way to
 * count it: an agent that has to *infer* the next call from prose is not being
 * handed one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What was actually seen. Present on failure; kept short on success. */
  detail: string;
}

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** UTF-8 bytes of the response body the server wrote back. */
  bytes: number;
  /** Estimated tokens for the same body. See the module header. */
  tokens: number;
}

export type SuggestionKind = "literal-call" | "param-override" | "param-rename" | "none";

export interface RecoveryResult {
  /** The error message the failing call returned, verbatim. */
  errorText: string;
  kind: SuggestionKind;
  /** The call the extraction produced, as `tool({...})`. Empty when kind is none. */
  suggested: string;
  /** True when the extracted call was executed and came back not-an-error. */
  recovered: boolean;
  /** What the recovery call returned: a summary, or why it failed. */
  detail: string;
}

export interface TaskResult {
  id: string;
  /** The job in the words a user would use. */
  job: string;
  kind: "job" | "failure";
  calls: CallRecord[];
  checks: CheckResult[];
  passed: boolean;
  bytes: number;
  tokens: number;
  /** Present on `kind: "failure"`. */
  recovery: RecoveryResult | null;
}

export interface LlmTaskResult {
  id: string;
  /** Tool calls the model chose, in order, as `tool({...})`. */
  trajectory: string[];
  /** Did the model's own trajectory satisfy the task's checks? */
  passed: boolean;
  detail: string;
  /** Real tokenizer count of every server response in the model's trajectory. */
  measuredTokens: number | null;
}

export interface LlmTier {
  status: "ran" | "skipped";
  reason: string;
  model: string | null;
  /** ISO date of the run. The only non-deterministic field in the artifact. */
  ranAt: string | null;
  tasks: LlmTaskResult[];
  summary: {
    tasksAttempted: number;
    tasksPassed: number;
    passRate: number;
  } | null;
  /**
   * The estimator, checked against a real tokenizer over the same responses.
   * `ratio` is estimated ÷ measured: 1.0 means the stated rule was exact.
   */
  tokenAccuracy: {
    estimatedTokens: number;
    measuredTokens: number;
    ratio: number;
    tokenizer: string;
  } | null;
}

export interface AgentEvalReport {
  schema: "zhongdex/agent-eval/v1";
  generator: "evals/agent-tasks.ts";
  corpusVersion: string;
  target: string;
  metrics: Record<string, string>;
  summary: {
    tasks: number;
    passed: number;
    passRate: number;
    jobTasks: number;
    jobTasksPassed: number;
    failureTasks: number;
    failureTasksPassed: number;
    checks: number;
    checksPassed: number;
    calls: number;
    totalBytes: number;
    totalTokens: number;
    medianTokensPerTask: number;
    maxTokensPerTask: number;
    tokenBudgetPerResponse: number;
    responsesOverBudget: number;
    recoveriesOffered: number;
    recoveriesExecuted: number;
    recoveriesSucceeded: number;
    recoveryRate: number;
    errorsWithNoNextCall: string[];
  };
  tasks: TaskResult[];
  llmTier: LlmTier;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Fixed decimals, so the artifact does not churn on floating-point noise. */
function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(1));
}

export function buildReport(
  corpusVersion: string,
  tasks: readonly TaskResult[],
  llmTier: LlmTier,
  tokenBudget: number,
): AgentEvalReport {
  const jobs = tasks.filter((t) => t.kind === "job");
  const failures = tasks.filter((t) => t.kind === "failure");
  const recoveries = failures
    .map((t) => t.recovery)
    .filter((r): r is RecoveryResult => r !== null);
  const offered = recoveries.filter((r) => r.kind !== "none");
  const calls = tasks.flatMap((t) => t.calls);

  return {
    schema: "zhongdex/agent-eval/v1",
    generator: "evals/agent-tasks.ts",
    corpusVersion,
    target: "src/mcp/server.ts over stdio JSON-RPC, spawned as a child process",
    metrics: {
      passRate:
        "A task passes when every check passes. Checks are recomputed from data/hsk_bands.json, " +
        "data/packs/*.json and data/sentences.jsonl by the eval's own reader, not by the server's.",
      tokensPerTask:
        "Bytes are exact (UTF-8 of every response body in the task). Tokens are an estimate: " +
        "CJK codepoints × 1 + all other codepoints ÷ 4. Not a tokenizer — see llmTier.tokenAccuracy " +
        "for the same responses counted by a real one.",
      recoveryRate:
        "Of the deliberate failures whose error text yields a machine-extractable next step, the " +
        "share where executing that step returns isError: false. Errors yielding no extractable " +
        "step are listed in summary.errorsWithNoNextCall and are not counted as recoveries.",
    },
    summary: {
      tasks: tasks.length,
      passed: tasks.filter((t) => t.passed).length,
      passRate: rate(tasks.filter((t) => t.passed).length, tasks.length),
      jobTasks: jobs.length,
      jobTasksPassed: jobs.filter((t) => t.passed).length,
      failureTasks: failures.length,
      failureTasksPassed: failures.filter((t) => t.passed).length,
      checks: tasks.reduce((n, t) => n + t.checks.length, 0),
      checksPassed: tasks.reduce((n, t) => n + t.checks.filter((c) => c.ok).length, 0),
      calls: calls.length,
      totalBytes: tasks.reduce((n, t) => n + t.bytes, 0),
      totalTokens: tasks.reduce((n, t) => n + t.tokens, 0),
      medianTokensPerTask: median(tasks.map((t) => t.tokens)),
      maxTokensPerTask: tasks.reduce((n, t) => Math.max(n, t.tokens), 0),
      tokenBudgetPerResponse: tokenBudget,
      responsesOverBudget: calls.filter((c) => c.tokens > tokenBudget).length,
      recoveriesOffered: offered.length,
      recoveriesExecuted: offered.length,
      recoveriesSucceeded: offered.filter((r) => r.recovered).length,
      recoveryRate: rate(offered.filter((r) => r.recovered).length, offered.length),
      errorsWithNoNextCall: failures
        .filter((t) => t.recovery !== null && t.recovery.kind === "none")
        .map((t) => t.id),
    },
    tasks: [...tasks],
    llmTier,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

const CHECK = "yes";
const CROSS = "NO";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const widths = (rows[0] ?? []).map((_, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), 0),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((cell, i) => pad(cell, widths[i] ?? 0)).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(Math.max(width, 3))).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head ?? []), divider, ...body.map(line)].join("\n");
}

/**
 * The block another agent drops into the README. Every number in it comes from
 * the report object, so it cannot drift from the run that produced it.
 */
export function renderMarkdown(report: AgentEvalReport): string {
  const s = report.summary;
  const out: string[] = [];

  out.push(`### Agent eval — ${String(s.tasks)} tasks against the real MCP server`);
  out.push("");
  out.push(
    `Corpus ${report.corpusVersion}. Every task drives \`src/mcp/server.ts\` over stdio JSON-RPC as ` +
      "a child process; every assertion is recomputed from the data files by the eval's own reader.",
  );
  out.push("");
  out.push(
    table([
      ["Metric", "Value", "How it is measured"],
      [
        "Pass rate",
        `**${s.passRate.toFixed(1)}%** (${String(s.passed)}/${String(s.tasks)})`,
        `${String(s.checksPassed)}/${String(s.checks)} individual checks, asserted against the data`,
      ],
      [
        "Tokens per task",
        `median **${String(s.medianTokensPerTask)}**, max ${String(s.maxTokensPerTask)}`,
        `${String(s.totalBytes)} B over ${String(s.calls)} responses; CJK×1 + rest÷4`,
      ],
      [
        "Recovery rate",
        `**${s.recoveryRate.toFixed(1)}%** (${String(s.recoveriesSucceeded)}/${String(s.recoveriesOffered)})`,
        "next call extracted from the error, executed, checked for isError: false",
      ],
      [
        "Responses over budget",
        `${String(s.responsesOverBudget)} of ${String(s.calls)}`,
        `budget is ${String(s.tokenBudgetPerResponse)} tokens per response`,
      ],
    ]),
  );
  out.push("");

  out.push("#### Jobs");
  out.push("");
  out.push(
    table([
      ["Task", "Job", "Calls", "Bytes", "Tokens", "Pass"],
      ...report.tasks
        .filter((task) => task.kind === "job")
        .map((task) => [
          `\`${task.id}\``,
          task.job,
          String(task.calls.length),
          String(task.bytes),
          String(task.tokens),
          task.passed ? CHECK : CROSS,
        ]),
    ]),
  );
  out.push("");

  out.push("#### Failure cases, and whether the error recovers");
  out.push("");
  out.push(
    table([
      ["Task", "What the agent did wrong", "Next step offered", "Recovered"],
      ...report.tasks
        .filter((task) => task.kind === "failure")
        .map((task) => [
          `\`${task.id}\``,
          task.job,
          task.recovery === null
            ? "—"
            : task.recovery.kind === "none"
              ? "**none**"
              : `${task.recovery.kind}: \`${task.recovery.suggested}\``,
          task.recovery === null ? "—" : task.recovery.recovered ? CHECK : CROSS,
        ]),
    ]),
  );
  out.push("");

  if (s.errorsWithNoNextCall.length > 0) {
    out.push(
      `Errors that hand back no machine-extractable next call: ` +
        `${s.errorsWithNoNextCall.map((id) => `\`${id}\``).join(", ")}.`,
    );
    out.push("");
  }

  const llm = report.llmTier;
  out.push("#### Tier 2 — a real model driving the same server");
  out.push("");
  if (llm.status === "skipped") {
    out.push(`Not run: ${llm.reason} Tier 1 above is complete and needs no model.`);
  } else {
    const summary = llm.summary;
    out.push(
      `${llm.model ?? "model"}, ${llm.ranAt ?? ""}. The model is given the server's own ` +
        "instructions and tool schemas and nothing else, picks its own calls, and is scored by the " +
        "same mechanical checks.",
    );
    out.push("");
    if (summary !== null) {
      out.push(
        `**${summary.passRate.toFixed(1)}%** of jobs completed ` +
          `(${String(summary.tasksPassed)}/${String(summary.tasksAttempted)}).`,
      );
    }
    if (llm.tokenAccuracy !== null) {
      const accuracy = llm.tokenAccuracy;
      out.push("");
      out.push(
        `Token estimate checked against ${accuracy.tokenizer}: ` +
          `${String(accuracy.estimatedTokens)} estimated vs ${String(accuracy.measuredTokens)} ` +
          `measured over the same responses, ratio ${accuracy.ratio.toFixed(2)}.`,
      );
    }
    out.push("");
    const short = (call: string): string =>
      call.length <= 64 ? call : `${call.slice(0, 61)}…)`;
    out.push(
      table([
        ["Task", "Calls the model chose", "Result", "Completed"],
        ...llm.tasks.map((task) => [
          `\`${task.id}\``,
          task.trajectory.length === 0
            ? "—"
            : task.trajectory.map((call) => `\`${short(call)}\``).join(" → "),
          task.detail,
          task.passed ? CHECK : CROSS,
        ]),
      ]),
    );
  }
  out.push("");
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Write                                                                       */
/* -------------------------------------------------------------------------- */

export function writeReport(path: string, report: AgentEvalReport): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Run directly to re-render the table from the committed artifact. */
function main(): void {
  const path = process.argv[2] ?? fileURLToPath(new URL("../data/agent-eval.json", import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(
      `agent-report: cannot read ${path}: ${(error as Error).message}\n` +
        "Run `npm run eval:agent` first.\n",
    );
    process.exit(1);
    return;
  }
  process.stdout.write(`${renderMarkdown(parsed as AgentEvalReport)}\n`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("agent-report.ts")) {
  main();
}
