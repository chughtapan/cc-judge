// CLI entrypoints: `cc-judge run`, `cc-judge score`, and `cc-judge inspect`.
// Built on yargs. Exit codes: 0 all-pass, 1 any-fail, 2 fatal.

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { glob as doGlob } from "glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { Trace } from "../core/schema.js";
import { RunnerResolutionError } from "../core/errors.js";
import { absurd } from "../core/types.js";
import { BraintrustEmitter, PromptfooEmitter, type ObservabilityEmitter } from "../emit/observability.js";
import { getTraceAdapter, type TraceFormat } from "../emit/trace-adapter.js";
import { AnthropicJudgeBackend, JUDGE_SYSTEM_PROMPT } from "../judge/index.js";
import {
  DockerRuntime,
  SubprocessRuntime,
  type AgentRuntime,
} from "../runner/index.js";
import { runPlannedHarnessPath } from "../plans/compiler.js";
import { ensureJudgeReady } from "./judge-preflight.js";
import { inspectRun, type InspectErrorCause } from "./inspect.js";
import { scoreTraces } from "./pipeline.js";

export type CliExitCode = 0 | 1 | 2;

export interface RunCliArgs {
  readonly scenarioPath: string;
  readonly runtime: "docker" | "subprocess";
  readonly image?: string;
  readonly bin?: string;
  readonly judge: string;
  readonly judgeBackend: string;
  readonly results: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
  readonly concurrency: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly totalTimeoutMs?: number;
  readonly emitBraintrust: boolean;
  readonly emitPromptfoo?: string;
}

export interface ScoreCliArgs {
  readonly tracesPath: string;
  readonly traceFormat: "canonical" | "otel";
  readonly judge: string;
  readonly judgeBackend: string;
  readonly judgeRubric?: string;
  readonly results: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
  readonly concurrency: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly totalTimeoutMs?: number;
  readonly emitBraintrust: boolean;
  readonly emitPromptfoo?: string;
}

function buildObservability(
  emitBraintrust: boolean,
  emitPromptfoo: string | undefined,
): ReadonlyArray<ObservabilityEmitter> {
  const emitters: ObservabilityEmitter[] = [];
  if (emitBraintrust) {
    const apiKey = process.env["BRAINTRUST_API_KEY"];
    const project = process.env["BRAINTRUST_PROJECT"] ?? "cc-judge";
    if (apiKey !== undefined && apiKey.length > 0) {
      emitters.push(new BraintrustEmitter({ apiKey, project }));
    }
  }
  if (emitPromptfoo !== undefined) {
    emitters.push(new PromptfooEmitter({ outputPath: emitPromptfoo }));
  }
  return emitters;
}

function buildRuntime(args: RunCliArgs): Effect.Effect<AgentRuntime, RunnerResolutionError, never> {
  if (args.runtime === "subprocess") {
    if (args.bin === undefined) {
      return Effect.fail(
        new RunnerResolutionError({
          cause: { _tag: "InvalidRuntime", value: "subprocess: missing --bin" },
        }),
      );
    }
    return Effect.succeed(new SubprocessRuntime({ bin: args.bin }));
  }
  return Effect.succeed(new DockerRuntime());
}

function printReportSummary(
  passed: number,
  total: number,
): void {
  process.stdout.write(`cc-judge: ${String(passed)}/${String(total)} passed\n`);
}

function runHarnessPlanCommand(args: RunCliArgs): Effect.Effect<CliExitCode, never, never> {
  return Effect.gen(function* () {
    const runtimeRes = yield* Effect.either(buildRuntime(args));
    if (runtimeRes._tag === "Left") {
      const cause = runtimeRes.left.cause;
      const detail = cause._tag === "InvalidRuntime" ? cause.value : cause._tag;
      process.stderr.write(`cc-judge: runtime resolution failed: ${detail}\n`);
      return 2 as CliExitCode;
    }
    const preflightFailure = ensureJudgeReady(args.judgeBackend);
    if (preflightFailure !== null) {
      process.stderr.write(`cc-judge: ${preflightFailure}\n`);
      return 2 as CliExitCode;
    }
    const judge = new AnthropicJudgeBackend({ model: args.judge });
    const emitters = buildObservability(args.emitBraintrust, args.emitPromptfoo);
    const runRes = yield* Effect.either(
      runPlannedHarnessPath(args.scenarioPath, {
        runtime: runtimeRes.right,
        judge,
        resultsDir: args.results,
        concurrency: args.concurrency,
        emitters,
        logLevel: args.logLevel,
        ...(args.githubComment !== undefined ? { githubComment: args.githubComment } : {}),
        ...(args.githubCommentArtifactUrl !== undefined
          ? { githubCommentArtifactUrl: args.githubCommentArtifactUrl }
          : {}),
        ...(args.totalTimeoutMs !== undefined ? { totalTimeoutMs: args.totalTimeoutMs } : {}),
      }),
    );
    if (runRes._tag === "Left") {
      const cause = runRes.left.cause;
      process.stderr.write(`cc-judge: harness run failed: ${cause._tag}\n`);
      return 2 as CliExitCode;
    }
    printReportSummary(runRes.right.summary.passed, runRes.right.summary.total);
    return (runRes.right.summary.failed === 0 ? 0 : 1) as CliExitCode;
  });
}

export function runCommand(args: RunCliArgs): Effect.Effect<CliExitCode, never, never> {
  return runHarnessPlanCommand(args);
}

export function scoreCommand(args: ScoreCliArgs): Effect.Effect<CliExitCode, never, never> {
  return Effect.gen(function* () {
    const preflightFailure = ensureJudgeReady(args.judgeBackend);
    if (preflightFailure !== null) {
      process.stderr.write(`cc-judge: ${preflightFailure}\n`);
      return 2 as CliExitCode;
    }
    const adapter = getTraceAdapter(args.traceFormat);
    const files = resolveTraceFiles(args.tracesPath);
    if (files.length === 0) {
      process.stderr.write(`cc-judge: no trace files matched ${args.tracesPath}\n`);
      return 2 as CliExitCode;
    }
    const traces: Trace[] = [];
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      const decoded = yield* Effect.either(adapter.decode(source, filePath));
      if (decoded._tag === "Left") {
        process.stderr.write(
          `cc-judge: trace decode failed for ${filePath}: ${decoded.left.cause._tag}\n`,
        );
        continue;
      }
      traces.push(decoded.right);
    }
    if (traces.length === 0) {
      return 2 as CliExitCode;
    }
    const rubric = args.judgeRubric !== undefined
      ? readFileSync(args.judgeRubric, "utf8")
      : undefined;
    const judge = new AnthropicJudgeBackend({
      model: args.judge,
      ...(rubric !== undefined ? { systemPrompt: `${JUDGE_SYSTEM_PROMPT}\n\n${rubric}` } : {}),
    });
    const emitters = buildObservability(args.emitBraintrust, args.emitPromptfoo);
    const report = yield* scoreTraces(traces, {
      judge,
      resultsDir: args.results,
      concurrency: args.concurrency,
      emitters,
      logLevel: args.logLevel,
      traceFormat: args.traceFormat,
      ...(args.githubComment !== undefined ? { githubComment: args.githubComment } : {}),
      ...(args.githubCommentArtifactUrl !== undefined
        ? { githubCommentArtifactUrl: args.githubCommentArtifactUrl }
        : {}),
      ...(args.totalTimeoutMs !== undefined ? { totalTimeoutMs: args.totalTimeoutMs } : {}),
    });
    printReportSummary(report.summary.passed, report.summary.total);
    return (report.summary.failed === 0 ? 0 : 1) as CliExitCode;
  });
}

function resolveTraceFiles(pathOrGlob: string): ReadonlyArray<string> {
  const isDir = (() => {
    try {
      return statSync(pathOrGlob).isDirectory();
    } catch (error) {
      void error;
      return false;
    }
  })();
  if (isDir) {
    return readdirSync(pathOrGlob)
      .filter((entry) => entry.endsWith(".json") || entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .map((entry) => path.join(pathOrGlob, entry))
      .sort();
  }
  if (/[*?\[\]{}]/.test(pathOrGlob)) {
    return doGlob.sync(pathOrGlob);
  }
  return [pathOrGlob];
}

interface YargsParsed {
  readonly [key: string]: unknown;
}

function asObject(raw: unknown): YargsParsed {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  return out;
}

export function parseRunArgs(raw: unknown): RunCliArgs {
  const record = asObject(raw);
  const scenarioPath = typeof record["input"] === "string" ? record["input"] : "";
  const runtime = record["runtime"] === "subprocess" ? "subprocess" : "docker";
  const logLevel = (
    record["logLevel"] === "debug" ||
    record["logLevel"] === "info" ||
    record["logLevel"] === "warn" ||
    record["logLevel"] === "error"
  )
    ? record["logLevel"]
    : "info";
  return {
    scenarioPath,
    runtime,
    ...(typeof record["image"] === "string" ? { image: record["image"] } : {}),
    ...(typeof record["bin"] === "string" ? { bin: record["bin"] } : {}),
    judge: typeof record["judge"] === "string" ? record["judge"] : "claude-opus-4-7",
    judgeBackend: typeof record["judgeBackend"] === "string" ? record["judgeBackend"] : "anthropic",
    results: typeof record["results"] === "string" ? record["results"] : "./eval-results",
    ...(typeof record["githubComment"] === "number" ? { githubComment: record["githubComment"] } : {}),
    ...(typeof record["githubCommentArtifactUrl"] === "string"
      ? { githubCommentArtifactUrl: record["githubCommentArtifactUrl"] }
      : {}),
    concurrency: typeof record["concurrency"] === "number" ? record["concurrency"] : 1,
    logLevel,
    ...(typeof record["totalTimeoutMs"] === "number" ? { totalTimeoutMs: record["totalTimeoutMs"] } : {}),
    emitBraintrust: record["emitBraintrust"] === true,
    ...(typeof record["emitPromptfoo"] === "string" ? { emitPromptfoo: record["emitPromptfoo"] } : {}),
  };
}

export function parseScoreArgs(raw: unknown): ScoreCliArgs {
  const record = asObject(raw);
  const traceFormat = record["traceFormat"] === "otel" ? "otel" : "canonical";
  const logLevel = (
    record["logLevel"] === "debug" ||
    record["logLevel"] === "info" ||
    record["logLevel"] === "warn" ||
    record["logLevel"] === "error"
  )
    ? record["logLevel"]
    : "info";
  return {
    tracesPath: typeof record["traces"] === "string" ? record["traces"] : "",
    traceFormat: traceFormat as TraceFormat,
    judge: typeof record["judge"] === "string" ? record["judge"] : "claude-opus-4-7",
    judgeBackend: typeof record["judgeBackend"] === "string" ? record["judgeBackend"] : "anthropic",
    ...(typeof record["judgeRubric"] === "string" ? { judgeRubric: record["judgeRubric"] } : {}),
    results: typeof record["results"] === "string" ? record["results"] : "./eval-results",
    ...(typeof record["githubComment"] === "number" ? { githubComment: record["githubComment"] } : {}),
    ...(typeof record["githubCommentArtifactUrl"] === "string"
      ? { githubCommentArtifactUrl: record["githubCommentArtifactUrl"] }
      : {}),
    concurrency: typeof record["concurrency"] === "number" ? record["concurrency"] : 1,
    logLevel,
    ...(typeof record["totalTimeoutMs"] === "number" ? { totalTimeoutMs: record["totalTimeoutMs"] } : {}),
    emitBraintrust: record["emitBraintrust"] === true,
    ...(typeof record["emitPromptfoo"] === "string" ? { emitPromptfoo: record["emitPromptfoo"] } : {}),
  };
}

export interface InspectCliArgs {
  readonly runId: string;
  readonly results: string;
}

export function parseInspectArgs(raw: unknown): InspectCliArgs {
  const record = asObject(raw);
  return {
    runId: typeof record["runId"] === "string" ? record["runId"] : "",
    results: typeof record["results"] === "string" ? record["results"] : "./eval-results",
  };
}

export function inspectCommand(args: InspectCliArgs): Effect.Effect<CliExitCode, never, never> {
  return Effect.gen(function* () {
    const result = yield* Effect.either(inspectRun(args.runId, args.results));
    if (result._tag === "Left") {
      const cause: InspectErrorCause = result.left.cause;
      switch (cause._tag) {
        case "RunNotFound":
          process.stderr.write(`cc-judge: inspect: run not found: ${cause.runId}\n`);
          return 2 as CliExitCode;
        case "DuplicateSeq":
          process.stderr.write(
            `cc-judge: inspect: duplicate seq ${String(cause.seq)} in run ${cause.runId}\n`,
          );
          return 2 as CliExitCode;
        default:
          return absurd(cause);
      }
    }
    return 0 as CliExitCode;
  });
}

export function main(argv: ReadonlyArray<string>): Effect.Effect<CliExitCode, never, never> {
  return Effect.suspend(() => {
    const parsed = yargs(argv.slice())
      .scriptName("cc-judge")
      .command("run <input>", "Run harness-backed plans", (yargsBuilder) =>
        yargsBuilder
          .positional("input", { type: "string", demandOption: true })
          .option("runtime", { choices: ["docker", "subprocess"] as const, default: "docker" })
          .option("image", { type: "string" })
          .option("bin", { type: "string" })
          .option("judge", { type: "string", default: "claude-opus-4-7" })
          .option("judge-backend", { type: "string", default: "anthropic" })
          .option("results", { type: "string", default: "./eval-results" })
          .option("github-comment", { type: "number" })
          .option("github-comment-artifact-url", { type: "string" })
          .option("concurrency", { type: "number", default: 1 })
          .option("log-level", { choices: ["debug", "info", "warn", "error"] as const, default: "info" })
          .option("total-timeout-ms", { type: "number" })
          .option("emit-braintrust", { type: "boolean", default: false })
          .option("emit-promptfoo", { type: "string" }),
      )
      .command("score <traces>", "Score traces", (yargsBuilder) =>
        yargsBuilder
          .positional("traces", { type: "string", demandOption: true })
          .option("trace-format", { choices: ["canonical", "otel"] as const, default: "canonical" })
          .option("judge", { type: "string", default: "claude-opus-4-7" })
          .option("judge-backend", { type: "string", default: "anthropic" })
          .option("judge-rubric", {
            type: "string",
            describe: "Path to a rubric file appended to the judge system prompt",
          })
          .option("results", { type: "string", default: "./eval-results" })
          .option("github-comment", { type: "number" })
          .option("github-comment-artifact-url", { type: "string" })
          .option("concurrency", { type: "number", default: 1 })
          .option("log-level", { choices: ["debug", "info", "warn", "error"] as const, default: "info" })
          .option("total-timeout-ms", { type: "number" })
          .option("emit-braintrust", { type: "boolean", default: false })
          .option("emit-promptfoo", { type: "string" }),
      )
      .command("inspect <runId>", "Inspect a run's WAL timeline", (yargsBuilder) =>
        yargsBuilder
          .positional("runId", { type: "string", demandOption: true })
          .option("results", { type: "string", default: "./eval-results" }),
      )
      .demandCommand(1)
      .strict()
      .help()
      .parseSync();

    const command = Array.isArray(parsed._) && parsed._.length > 0 ? String(parsed._[0]) : "";
    switch (command) {
      case "run":
        return runCommand(parseRunArgs(parsed));
      case "score":
        return scoreCommand(parseScoreArgs(parsed));
      case "inspect":
        return inspectCommand(parseInspectArgs(parsed));
      default:
        process.stderr.write("cc-judge: unknown command\n");
        return Effect.succeed(2 as CliExitCode);
    }
  });
}

export function cliEntrypoint(): void {
  const program = main(hideBin(process.argv)).pipe(
    Effect.tap((code) => Effect.sync(() => process.exit(code))),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        process.stderr.write(`cc-judge: fatal: ${String(cause)}\n`);
        process.exit(2);
      }),
    ),
  );
  Effect.runFork(program);
}
