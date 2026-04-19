import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runCommand,
  scoreCommand,
  main,
  parseRunArgs,
  parseScoreArgs,
  type RunCliArgs,
  type ScoreCliArgs,
} from "../src/app/cli.js";
import { itEffect } from "./support/effect.js";

const EXIT_RUNNER_RESOLUTION = 2;
const EXIT_LOAD_FAILURE = 2;
const EXIT_FATAL = 2;
const EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;
const SCEN_PATH_BOGUS = "/tmp/cc-judge-nonexistent-cli-path-xyz";
const TRACES_PATH_MISSING = "/tmp/cc-judge-nonexistent-traces.json";

function tmpScenarioDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-cli-"));
  const yaml = `
id: cli-t
name: cli-t
description: d
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
`;
  writeFileSync(path.join(dir, "a.yaml"), yaml, "utf8");
  return dir;
}

function baseArgs(scenarioDir: string): RunCliArgs {
  return {
    scenarioPath: scenarioDir,
    runtime: "docker",
    judge: "claude-opus-4-7",
    judgeBackend: "anthropic",
    runs: 1,
    results: mkdtempSync(path.join(os.tmpdir(), "cc-judge-cli-out-")),
    concurrency: 1,
    logLevel: "error",
    emitBraintrust: false,
  };
}

describe("runCommand runner-resolution failure", () => {
  itEffect("exits 2 when runtime=docker but --image is missing", function* () {
    const dir = tmpScenarioDir();
    const code = yield* runCommand(baseArgs(dir));
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
  });

  itEffect("exits 2 when runtime=subprocess but --bin is missing", function* () {
    const dir = tmpScenarioDir();
    const args: RunCliArgs = { ...baseArgs(dir), runtime: "subprocess" };
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
  });

  itEffect("exits 2 when scenario path does not exist (load failure)", function* () {
    const args: RunCliArgs = { ...baseArgs("/tmp"), scenarioPath: SCEN_PATH_BOGUS };
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_LOAD_FAILURE);
  });
});

describe("scoreCommand", () => {
  itEffect("exits 2 when trace file decode fails with malformed content", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const args: ScoreCliArgs = {
      tracesPath: traceFile,
      traceFormat: "canonical",
      judge: "claude-opus-4-7",
      judgeBackend: "anthropic",
      results: mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-out-")),
      concurrency: 1,
      logLevel: "error",
      emitBraintrust: false,
    };
    const code = yield* scoreCommand(args);
    expect(code).toBe(EXIT_FATAL);
  });
});

describe("main (yargs dispatch)", () => {
  itEffect("dispatches `run` subcommand to runCommand (exits via runner-resolution path)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime",
      "docker",
      "--results",
      results,
      "--log-level",
      "error",
    ]);
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
  });

  itEffect("dispatches `score` subcommand with malformed trace → exit 2", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-out-"));
    const code = yield* main([
      "score",
      traceFile,
      "--trace-format",
      "canonical",
      "--results",
      results,
      "--log-level",
      "error",
    ]);
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("main with subprocess runtime and --bin parses cleanly (returns before runner invokes)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-"));
    // subprocess runtime parses OK; pipeline starts and runs against /bin/echo.
    // That call may produce non-zero turns but never throws, so runCommand folds
    // to exit 0 or 1 (not the 2 we see for missing --bin).
    const code = yield* main([
      "run",
      dir,
      "--runtime",
      "subprocess",
      "--bin",
      "/bin/echo",
      "--runs",
      "1",
      "--concurrency",
      "1",
      "--results",
      results,
      "--log-level",
      "error",
    ]);
    expect([EXIT_SUCCESS, EXIT_FAILURE]).toContain(code);
  });

  itEffect("main with score + otel trace-format dispatches via otel adapter", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-"));
    const traceFile = path.join(dir, "empty-otel.json");
    writeFileSync(traceFile, JSON.stringify({ resourceSpans: [] }), "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-out-"));
    const code = yield* main([
      "score",
      traceFile,
      "--trace-format",
      "otel",
      "--results",
      results,
      "--log-level",
      "error",
    ]);
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("main with explicit --judge model passes it through to parseRunArgs", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime",
      "docker",
      "--judge",
      "claude-sonnet-4-6",
      "--judge-backend",
      "anthropic",
      "--results",
      results,
      "--log-level",
      "warn",
    ]);
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
  });
});

// Direct tests for parseRunArgs / parseScoreArgs exercise the typeof defaults
// that yargs' option defaults hide at runtime. Spec #38 Q2 amendment allows
// widening the public surface when observable-behavior tests can't reach the
// branch — parse-path defaults are otherwise unreachable via main().
describe("parseRunArgs", () => {
  it("supplies defaults for every optional field when raw is empty", () => {
    const args = parseRunArgs({});
    expect(args.scenarioPath).toBe("");
    expect(args.runtime).toBe("docker");
    expect(args.judge).toBe("claude-opus-4-7");
    expect(args.judgeBackend).toBe("anthropic");
    expect(args.runs).toBe(1);
    expect(args.results).toBe("./eval-results");
    expect(args.concurrency).toBe(1);
    expect(args.logLevel).toBe("info");
    expect(args.emitBraintrust).toBe(false);
    expect(args.image).toBeUndefined();
    expect(args.bin).toBeUndefined();
    expect(args.scenarioIds).toBeUndefined();
    expect(args.githubComment).toBeUndefined();
    expect(args.githubCommentArtifactUrl).toBeUndefined();
    expect(args.totalTimeoutMs).toBeUndefined();
    expect(args.emitPromptfoo).toBeUndefined();
  });

  it("returns empty-default shape for non-object raw values", () => {
    expect(parseRunArgs(null).scenarioPath).toBe("");
    expect(parseRunArgs(42).scenarioPath).toBe("");
    expect(parseRunArgs("string").scenarioPath).toBe("");
    expect(parseRunArgs([]).scenarioPath).toBe("");
  });

  it("passes through string scenario + image + bin when provided", () => {
    const args = parseRunArgs({
      scenario: "/path/to/s",
      runtime: "subprocess",
      image: "my-img",
      bin: "/usr/bin/claude",
      judge: "claude-custom",
      judgeBackend: "openai",
      runs: 5,
      scenarioIds: ["a", "b"],
      results: "/out",
      githubComment: 42,
      githubCommentArtifactUrl: "https://example/art",
      concurrency: 8,
      logLevel: "debug",
      totalTimeoutMs: 60_000,
      emitBraintrust: true,
      emitPromptfoo: "/p.json",
    });
    expect(args.scenarioPath).toBe("/path/to/s");
    expect(args.runtime).toBe("subprocess");
    expect(args.image).toBe("my-img");
    expect(args.bin).toBe("/usr/bin/claude");
    expect(args.judge).toBe("claude-custom");
    expect(args.judgeBackend).toBe("openai");
    expect(args.runs).toBe(5);
    expect(args.scenarioIds).toEqual(["a", "b"]);
    expect(args.results).toBe("/out");
    expect(args.githubComment).toBe(42);
    expect(args.githubCommentArtifactUrl).toBe("https://example/art");
    expect(args.concurrency).toBe(8);
    expect(args.logLevel).toBe("debug");
    expect(args.totalTimeoutMs).toBe(60_000);
    expect(args.emitBraintrust).toBe(true);
    expect(args.emitPromptfoo).toBe("/p.json");
  });

  it("normalizes runtime to docker when value is neither docker nor subprocess", () => {
    expect(parseRunArgs({ runtime: "wasm" }).runtime).toBe("docker");
    expect(parseRunArgs({ runtime: null }).runtime).toBe("docker");
    expect(parseRunArgs({ runtime: "" }).runtime).toBe("docker");
  });

  it("normalizes logLevel to info when value is not one of the four accepted levels", () => {
    expect(parseRunArgs({ logLevel: "trace" }).logLevel).toBe("info");
    expect(parseRunArgs({ logLevel: 7 }).logLevel).toBe("info");
    expect(parseRunArgs({ logLevel: "WARN" }).logLevel).toBe("info"); // case-sensitive
  });

  it("accepts each valid logLevel value (debug/info/warn/error)", () => {
    expect(parseRunArgs({ logLevel: "debug" }).logLevel).toBe("debug");
    expect(parseRunArgs({ logLevel: "info" }).logLevel).toBe("info");
    expect(parseRunArgs({ logLevel: "warn" }).logLevel).toBe("warn");
    expect(parseRunArgs({ logLevel: "error" }).logLevel).toBe("error");
  });

  it("drops image / bin / scenarioIds / githubComment when the wrong type", () => {
    const args = parseRunArgs({
      image: 42,
      bin: null,
      scenarioIds: "not-an-array",
      githubComment: "not-a-number",
      githubCommentArtifactUrl: 99,
      totalTimeoutMs: "not-a-number",
      emitPromptfoo: 100,
    });
    expect(args.image).toBeUndefined();
    expect(args.bin).toBeUndefined();
    expect(args.scenarioIds).toBeUndefined();
    expect(args.githubComment).toBeUndefined();
    expect(args.githubCommentArtifactUrl).toBeUndefined();
    expect(args.totalTimeoutMs).toBeUndefined();
    expect(args.emitPromptfoo).toBeUndefined();
  });

  it("treats emitBraintrust non-true values as false (boolean strict equality)", () => {
    expect(parseRunArgs({ emitBraintrust: false }).emitBraintrust).toBe(false);
    expect(parseRunArgs({ emitBraintrust: "true" }).emitBraintrust).toBe(false);
    expect(parseRunArgs({ emitBraintrust: 1 }).emitBraintrust).toBe(false);
    expect(parseRunArgs({ emitBraintrust: true }).emitBraintrust).toBe(true);
  });

  it("returns runs=1 when runs is not a number", () => {
    expect(parseRunArgs({ runs: "5" }).runs).toBe(1);
    expect(parseRunArgs({ runs: null }).runs).toBe(1);
  });

  it("returns concurrency=1 when concurrency is not a number", () => {
    expect(parseRunArgs({ concurrency: "8" }).concurrency).toBe(1);
  });
});

describe("parseScoreArgs", () => {
  it("supplies defaults for every optional field when raw is empty", () => {
    const args = parseScoreArgs({});
    expect(args.tracesPath).toBe("");
    expect(args.traceFormat).toBe("canonical");
    expect(args.judge).toBe("claude-opus-4-7");
    expect(args.judgeBackend).toBe("anthropic");
    expect(args.results).toBe("./eval-results");
    expect(args.concurrency).toBe(1);
    expect(args.logLevel).toBe("info");
    expect(args.emitBraintrust).toBe(false);
    expect(args.githubComment).toBeUndefined();
    expect(args.githubCommentArtifactUrl).toBeUndefined();
    expect(args.totalTimeoutMs).toBeUndefined();
    expect(args.emitPromptfoo).toBeUndefined();
  });

  it("normalizes traceFormat to canonical when value is not `otel`", () => {
    expect(parseScoreArgs({ traceFormat: "otel" }).traceFormat).toBe("otel");
    expect(parseScoreArgs({ traceFormat: "canonical" }).traceFormat).toBe("canonical");
    expect(parseScoreArgs({ traceFormat: "jaeger" }).traceFormat).toBe("canonical");
    expect(parseScoreArgs({ traceFormat: null }).traceFormat).toBe("canonical");
    expect(parseScoreArgs({ traceFormat: 42 }).traceFormat).toBe("canonical");
  });

  it("normalizes logLevel to info when value is not one of the four accepted levels", () => {
    expect(parseScoreArgs({ logLevel: "trace" }).logLevel).toBe("info");
    expect(parseScoreArgs({ logLevel: 7 }).logLevel).toBe("info");
  });

  it("passes through every valid field when raw is fully specified", () => {
    const args = parseScoreArgs({
      traces: "/trace.json",
      traceFormat: "otel",
      judge: "claude-custom",
      judgeBackend: "openai",
      results: "/out",
      githubComment: 42,
      githubCommentArtifactUrl: "https://example/art",
      concurrency: 4,
      logLevel: "warn",
      totalTimeoutMs: 90_000,
      emitBraintrust: true,
      emitPromptfoo: "/p.json",
    });
    expect(args.tracesPath).toBe("/trace.json");
    expect(args.traceFormat).toBe("otel");
    expect(args.judge).toBe("claude-custom");
    expect(args.judgeBackend).toBe("openai");
    expect(args.results).toBe("/out");
    expect(args.githubComment).toBe(42);
    expect(args.githubCommentArtifactUrl).toBe("https://example/art");
    expect(args.concurrency).toBe(4);
    expect(args.logLevel).toBe("warn");
    expect(args.totalTimeoutMs).toBe(90_000);
    expect(args.emitBraintrust).toBe(true);
    expect(args.emitPromptfoo).toBe("/p.json");
  });

  it("returns empty-default shape for non-object raw values", () => {
    expect(parseScoreArgs(null).tracesPath).toBe("");
    expect(parseScoreArgs(42).tracesPath).toBe("");
    expect(parseScoreArgs([]).tracesPath).toBe("");
  });

  it("treats emitBraintrust non-true values as false", () => {
    expect(parseScoreArgs({ emitBraintrust: "true" }).emitBraintrust).toBe(false);
    expect(parseScoreArgs({ emitBraintrust: 1 }).emitBraintrust).toBe(false);
    expect(parseScoreArgs({ emitBraintrust: true }).emitBraintrust).toBe(true);
  });

  it("drops githubComment / totalTimeoutMs / emitPromptfoo when the wrong type", () => {
    const args = parseScoreArgs({
      githubComment: "42",
      githubCommentArtifactUrl: 99,
      totalTimeoutMs: "not-a-number",
      emitPromptfoo: 100,
    });
    expect(args.githubComment).toBeUndefined();
    expect(args.githubCommentArtifactUrl).toBeUndefined();
    expect(args.totalTimeoutMs).toBeUndefined();
    expect(args.emitPromptfoo).toBeUndefined();
  });
});

// Capture stderr to assert on the exact error-message prefixes runCommand writes
// on load failure and runner-resolution failure. Kills StringLiteral mutations
// on those prefixes + the InvalidRuntime cause.value strings.
type StderrWriteFn = typeof process.stderr.write;
type StderrWritable = { write: StderrWriteFn };

function installStderrCapture(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy: StderrWriteFn = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as StderrWriteFn;
  (process.stderr as unknown as StderrWritable).write = spy;
  const restore = (): void => {
    (process.stderr as unknown as StderrWritable).write = original;
  };
  return { chunks, restore };
}

describe("runCommand stderr messages", () => {
  itEffect("writes `cc-judge: runner resolution failed:` with `docker: missing --image` cause", function* () {
    const dir = tmpScenarioDir();
    const args: RunCliArgs = baseArgs(dir);
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(runCommand(args), Effect.sync(restore));
    const stderr = chunks.join("");
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
    expect(stderr).toContain("cc-judge: runner resolution failed:");
    expect(stderr).toContain("docker: missing --image");
  });

  itEffect("writes `cc-judge: runner resolution failed:` with `subprocess: missing --bin` cause", function* () {
    const dir = tmpScenarioDir();
    const args: RunCliArgs = { ...baseArgs(dir), runtime: "subprocess" };
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(runCommand(args), Effect.sync(restore));
    const stderr = chunks.join("");
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
    expect(stderr).toContain("cc-judge: runner resolution failed:");
    expect(stderr).toContain("subprocess: missing --bin");
  });

  itEffect("writes `cc-judge: load failed:` when scenario path does not exist", function* () {
    const args: RunCliArgs = { ...baseArgs("/tmp"), scenarioPath: SCEN_PATH_BOGUS };
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(runCommand(args), Effect.sync(restore));
    const stderr = chunks.join("");
    expect(code).toBe(EXIT_LOAD_FAILURE);
    expect(stderr).toContain("cc-judge: load failed:");
    expect(stderr).toContain("FileNotFound");
  });
});
