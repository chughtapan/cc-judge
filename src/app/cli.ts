// CLI entrypoints: `cc-judge run` and `cc-judge score`.
// Built on yargs. Exit codes: 0 all-pass, 1 any-fail, 2 fatal.

import { Effect } from "effect";
import { readFileSync } from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { scenarioLoader } from "../core/scenario.js";
import type { Scenario } from "../core/schema.js";
import type { Trace } from "../core/schema.js";
import { AnthropicJudgeBackend } from "../judge/index.js";
import { DockerRunner, SubprocessRunner, type AgentRunner } from "../runner/index.js";
import { BraintrustEmitter, PromptfooEmitter, type ObservabilityEmitter } from "../emit/observability.js";
import { getTraceAdapter, type TraceFormat } from "../emit/trace-adapter.js";
import { runScenarios, scoreTraces } from "./pipeline.js";

export type CliExitCode = 0 | 1 | 2;

export interface RunCliArgs {
  readonly scenarioPath: string;
  readonly runtime: "docker" | "subprocess";
  readonly image?: string;
  readonly bin?: string;
  readonly judge: string;
  readonly judgeBackend: string;
  readonly runs: number;
  readonly scenarioIds?: ReadonlyArray<string>;
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

function buildRunner(args: RunCliArgs): AgentRunner {
  if (args.runtime === "subprocess") {
    if (args.bin === undefined) {
      throw new Error("--bin is required with --runtime subprocess");
    }
    return new SubprocessRunner({ bin: args.bin });
  }
  if (args.image === undefined) {
    throw new Error("--image is required with --runtime docker");
  }
  return new DockerRunner({ image: args.image });
}

export function runCommand(args: RunCliArgs): Effect.Effect<CliExitCode, never, never> {
  return Effect.gen(function* () {
    const loadRes = yield* Effect.either(scenarioLoader.loadFromPath(args.scenarioPath));
    if (loadRes._tag === "Left") {
      process.stderr.write(`cc-judge: load failed: ${loadRes.left.cause._tag}\n`);
      return 2 as CliExitCode;
    }
    const scenarios: ReadonlyArray<Scenario> = loadRes.right;
    let runner: AgentRunner;
    try {
      runner = buildRunner(args);
    } catch (err) {
      process.stderr.write(`cc-judge: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2 as CliExitCode;
    }
    const judge = new AnthropicJudgeBackend({ model: args.judge });
    const emitters = buildObservability(args.emitBraintrust, args.emitPromptfoo);
    const runRes = yield* Effect.either(
      runScenarios(scenarios, {
        runner,
        judge,
        resultsDir: args.results,
        runsPerScenario: args.runs,
        concurrency: args.concurrency,
        emitters,
        logLevel: args.logLevel,
        ...(args.scenarioIds !== undefined ? { scenarioIdFilter: args.scenarioIds } : {}),
        ...(args.githubComment !== undefined ? { githubComment: args.githubComment } : {}),
        ...(args.githubCommentArtifactUrl !== undefined
          ? { githubCommentArtifactUrl: args.githubCommentArtifactUrl }
          : {}),
        ...(args.totalTimeoutMs !== undefined ? { totalTimeoutMs: args.totalTimeoutMs } : {}),
      }),
    );
    if (runRes._tag === "Left") {
      process.stderr.write(`cc-judge: runner resolution failed: ${runRes.left.cause._tag}\n`);
      return 2 as CliExitCode;
    }
    const report = runRes.right;
    process.stdout.write(
      `cc-judge: ${String(report.summary.passed)}/${String(report.summary.total)} passed\n`,
    );
    return (report.summary.failed === 0 ? 0 : 1) as CliExitCode;
  });
}

export function scoreCommand(args: ScoreCliArgs): Effect.Effect<CliExitCode, never, never> {
  return Effect.gen(function* () {
    const adapter = getTraceAdapter(args.traceFormat);
    const files = resolveTraceFiles(args.tracesPath);
    if (files.length === 0) {
      process.stderr.write(`cc-judge: no trace files matched ${args.tracesPath}\n`);
      return 2 as CliExitCode;
    }
    const traces: Trace[] = [];
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      const decoded = yield* Effect.either(adapter.decode(source, f));
      if (decoded._tag === "Left") {
        process.stderr.write(
          `cc-judge: trace decode failed for ${f}: ${decoded.left.cause._tag}\n`,
        );
        continue;
      }
      traces.push(decoded.right);
    }
    if (traces.length === 0) return 2 as CliExitCode;
    const judge = new AnthropicJudgeBackend({ model: args.judge });
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
    process.stdout.write(
      `cc-judge: ${String(report.summary.passed)}/${String(report.summary.total)} passed\n`,
    );
    return (report.summary.failed === 0 ? 0 : 1) as CliExitCode;
  });
}

function resolveTraceFiles(pathOrGlob: string): ReadonlyArray<string> {
  // Scenario loader already handles glob + file + directory resolution;
  // reuse its underlying glob library by going via node:fs for a single
  // file — traces are JSON not TS, so we don't import them.
  // For v1 we accept a single file path. Expansion deferred.
  return [pathOrGlob];
}

interface YargsParsed {
  readonly [key: string]: unknown;
}

function asObject(raw: unknown): YargsParsed {
  if (typeof raw !== "object" || raw === null) return {};
  const out: { [k: string]: unknown } = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v;
  return out;
}

function parseRunArgs(raw: unknown): RunCliArgs {
  const r = asObject(raw);
  const scenarioPath = typeof r["scenario"] === "string" ? r["scenario"] : "";
  const runtime = r["runtime"] === "subprocess" ? "subprocess" : "docker";
  const logLevel = (r["logLevel"] === "debug" || r["logLevel"] === "info" || r["logLevel"] === "warn" || r["logLevel"] === "error")
    ? r["logLevel"]
    : "info";
  return {
    scenarioPath,
    runtime,
    ...(typeof r["image"] === "string" ? { image: r["image"] } : {}),
    ...(typeof r["bin"] === "string" ? { bin: r["bin"] } : {}),
    judge: typeof r["judge"] === "string" ? r["judge"] : "claude-opus-4-7",
    judgeBackend: typeof r["judgeBackend"] === "string" ? r["judgeBackend"] : "anthropic",
    runs: typeof r["runs"] === "number" ? r["runs"] : 1,
    ...(Array.isArray(r["scenarioIds"]) ? { scenarioIds: r["scenarioIds"] as ReadonlyArray<string> } : {}),
    results: typeof r["results"] === "string" ? r["results"] : "./eval-results",
    ...(typeof r["githubComment"] === "number" ? { githubComment: r["githubComment"] } : {}),
    ...(typeof r["githubCommentArtifactUrl"] === "string"
      ? { githubCommentArtifactUrl: r["githubCommentArtifactUrl"] }
      : {}),
    concurrency: typeof r["concurrency"] === "number" ? r["concurrency"] : 1,
    logLevel,
    ...(typeof r["totalTimeoutMs"] === "number" ? { totalTimeoutMs: r["totalTimeoutMs"] } : {}),
    emitBraintrust: r["emitBraintrust"] === true,
    ...(typeof r["emitPromptfoo"] === "string" ? { emitPromptfoo: r["emitPromptfoo"] } : {}),
  };
}

function parseScoreArgs(raw: unknown): ScoreCliArgs {
  const r = asObject(raw);
  const traceFormat = r["traceFormat"] === "otel" ? "otel" : "canonical";
  const logLevel = (r["logLevel"] === "debug" || r["logLevel"] === "info" || r["logLevel"] === "warn" || r["logLevel"] === "error")
    ? r["logLevel"]
    : "info";
  return {
    tracesPath: typeof r["traces"] === "string" ? r["traces"] : "",
    traceFormat: traceFormat as TraceFormat,
    judge: typeof r["judge"] === "string" ? r["judge"] : "claude-opus-4-7",
    judgeBackend: typeof r["judgeBackend"] === "string" ? r["judgeBackend"] : "anthropic",
    results: typeof r["results"] === "string" ? r["results"] : "./eval-results",
    ...(typeof r["githubComment"] === "number" ? { githubComment: r["githubComment"] } : {}),
    ...(typeof r["githubCommentArtifactUrl"] === "string"
      ? { githubCommentArtifactUrl: r["githubCommentArtifactUrl"] }
      : {}),
    concurrency: typeof r["concurrency"] === "number" ? r["concurrency"] : 1,
    logLevel,
    ...(typeof r["totalTimeoutMs"] === "number" ? { totalTimeoutMs: r["totalTimeoutMs"] } : {}),
    emitBraintrust: r["emitBraintrust"] === true,
    ...(typeof r["emitPromptfoo"] === "string" ? { emitPromptfoo: r["emitPromptfoo"] } : {}),
  };
}

export function main(argv: ReadonlyArray<string>): Effect.Effect<CliExitCode, never, never> {
  return Effect.suspend(() => {
    const parsed = yargs(argv.slice())
      .scriptName("cc-judge")
      .command("run <scenario>", "Run scenarios", (y) =>
        y
          .positional("scenario", { type: "string", demandOption: true })
          .option("runtime", { choices: ["docker", "subprocess"] as const, default: "docker" })
          .option("image", { type: "string" })
          .option("bin", { type: "string" })
          .option("judge", { type: "string", default: "claude-opus-4-7" })
          .option("judge-backend", { type: "string", default: "anthropic" })
          .option("runs", { type: "number", default: 1 })
          .option("scenario-ids", { type: "array", string: true })
          .option("results", { type: "string", default: "./eval-results" })
          .option("github-comment", { type: "number" })
          .option("github-comment-artifact-url", { type: "string" })
          .option("concurrency", { type: "number", default: 1 })
          .option("log-level", { choices: ["debug", "info", "warn", "error"] as const, default: "info" })
          .option("total-timeout-ms", { type: "number" })
          .option("emit-braintrust", { type: "boolean", default: false })
          .option("emit-promptfoo", { type: "string" }),
      )
      .command("score <traces>", "Score traces", (y) =>
        y
          .positional("traces", { type: "string", demandOption: true })
          .option("trace-format", { choices: ["canonical", "otel"] as const, default: "canonical" })
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
      default:
        process.stderr.write(`cc-judge: unknown command\n`);
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
