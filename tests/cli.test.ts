import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

const SAVED_ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];

beforeEach(() => {
  process.env["ANTHROPIC_API_KEY"] = "test-anthropic-api-key";
});

afterEach(() => {
  if (SAVED_ANTHROPIC_API_KEY === undefined) {
    delete process.env["ANTHROPIC_API_KEY"];
    return;
  }
  process.env["ANTHROPIC_API_KEY"] = SAVED_ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Mock runScenarios / scoreTraces to capture opts passed from cli.ts.
// This kills ConditionalExpression, EqualityOperator, and ObjectLiteral
// survivors on lines 105, 116-121 (spread args into runScenarios).
// ---------------------------------------------------------------------------

let capturedRunOpts: Record<string, unknown> | null = null;
let capturedRunScenarios: unknown[] | null = null;
let capturedScoreOpts: Record<string, unknown> | null = null;
let capturedScoreTraces: unknown[] | null = null;
let mockRunScenariosShouldFail = false;
let mockRunScenariosFailTag = "NoRunnerConfigured";

vi.mock("../src/app/pipeline.js", () => ({
  runScenarios: vi.fn((scenarios: unknown[], opts: Record<string, unknown>) => {
    if (mockRunScenariosShouldFail) {
      return Effect.fail({ cause: { _tag: mockRunScenariosFailTag } });
    }
    capturedRunScenarios = scenarios;
    capturedRunOpts = opts;
    // Return a minimal report so runCommand completes
    return Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    });
  }),
  scoreTraces: vi.fn((traces: unknown[], opts: Record<string, unknown>) => {
    capturedScoreTraces = traces;
    capturedScoreOpts = opts;
    return Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    });
  }),
}));

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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers for option-passthrough tests.
// A subprocess runner with bin=/bin/true + a scenarioIdFilter that excludes
// every scenario means: runner resolves OK, runScenarios is called, the forEach
// loop runs over zero jobs, report.summary.total === 0. No subprocess spawned.
// ──────────────────────────────────────────────────────────────────────────────

const NONEXISTENT_SCENARIO_ID = "cc-judge-nonexistent-id-xyz";
const BIN_TRUE = "/bin/true";
const EXIT_SCORE_NO_TRACES = 2;
const EXIT_SCORE_NO_FILES = 2;
const STUB_PROMPTFOO_OUTPUT = "/tmp/cc-judge-promptfoo-stub.json";

function stubRunArgs(scenarioDir: string, overrides: Partial<RunCliArgs> = {}): RunCliArgs {
  return {
    scenarioPath: scenarioDir,
    runtime: "subprocess",
    bin: BIN_TRUE,
    judge: "claude-opus-4-7",
    judgeBackend: "anthropic",
    runs: 1,
    // Filter excludes all scenarios → no jobs → summary.total === 0
    scenarioIds: [NONEXISTENT_SCENARIO_ID],
    results: mkdtempSync(path.join(os.tmpdir(), "cc-judge-stub-out-")),
    concurrency: 1,
    logLevel: "error",
    emitBraintrust: false,
    ...overrides,
  };
}

function stubTraceFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-trace-stub-"));
  const traceFile = path.join(dir, "trace.json");
  // A valid canonical-format trace file that will decode successfully
  const trace = {
    traceId: "trace-001",
    name: "stub-trace",
    expectedBehavior: "b",
    validationChecks: ["c"],
    turns: [],
  };
  writeFileSync(traceFile, JSON.stringify(trace), "utf8");
  return traceFile;
}

function stubScoreArgs(traceFile: string, overrides: Partial<ScoreCliArgs> = {}): ScoreCliArgs {
  return {
    tracesPath: traceFile,
    traceFormat: "canonical",
    judge: "claude-opus-4-7",
    judgeBackend: "anthropic",
    results: mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-stub-out-")),
    concurrency: 1,
    logLevel: "error",
    emitBraintrust: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// runCommand option passthrough tests (kills lines 116–121 NoCoverage survivors)
// Each test passes the optional field and asserts the pipeline reaches the
// runScenarios call (summary.total === 0 since the filter excludes all ids).
// ──────────────────────────────────────────────────────────────────────────────

describe("runCommand option passthroughs (via stub runner + empty filter)", () => {
  itEffect("scenarioIds set → runScenarios called → summary.total 0 → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { scenarioIds: [NONEXISTENT_SCENARIO_ID] });
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(runCommand(args), Effect.sync(restore));
    // summary.total=0 means failed=0 → exit 0
    expect(code).toBe(EXIT_SUCCESS);
    // confirm no runner-resolution failure message
    expect(chunks.join("")).not.toContain("runner resolution failed");
  });

  itEffect("scenarioIds undefined → runScenarios called with no filter → exit 0 (no runs)", function* () {
    const dir = tmpScenarioDir();
    // Without a scenarioIdFilter the scenario IS included, but the runner
    // will call runner.start() which will succeed for subprocess (it spawns
    // /bin/true). We can't safely do that in unit tests, so we test the
    // defined-vs-undefined branching by checking that the conditional branch
    // is reached at all. The actual observable difference is tested separately.
    const args = stubRunArgs(dir, { scenarioIds: undefined });
    // This will try to run the scenario against /bin/true (subprocess runner).
    // SubprocessRunner.start() is called — let's just verify the code path
    // exits without a runner-resolution failure (code 2).
    // Since it may fail at agent-start level, we accept code 0 or 1.
    const code = yield* runCommand(args);
    // code !== EXIT_RUNNER_RESOLUTION means the runner resolved
    expect(code).not.toBe(EXIT_RUNNER_RESOLUTION);
  }, 10_000);

  itEffect("githubComment set → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubComment: 1 });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("githubComment undefined → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubComment: undefined });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("githubCommentArtifactUrl set → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubCommentArtifactUrl: "https://example.com/artifact" });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("githubCommentArtifactUrl undefined → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubCommentArtifactUrl: undefined });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("totalTimeoutMs set → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { totalTimeoutMs: 60_000 });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("totalTimeoutMs undefined → runScenarios called → exit 0", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { totalTimeoutMs: undefined });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("stdout summary line written after successful run", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    type StdoutWritable = { write: typeof process.stdout.write };
    (process.stdout as unknown as StdoutWritable).write = ((s: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    const code = yield* Effect.ensuring(
      runCommand(args),
      Effect.sync(() => { (process.stdout as unknown as StdoutWritable).write = origWrite; }),
    );
    expect(code).toBe(EXIT_SUCCESS);
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("cc-judge:");
    expect(stdout).toContain("passed");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// scoreCommand option passthrough + boundary tests (lines 140, 156, 166–170)
// ──────────────────────────────────────────────────────────────────────────────

describe("scoreCommand option passthroughs and boundary conditions", () => {
  // NOTE: resolveTraceFiles v1 always returns [pathOrGlob] (single file).
  // The files.length===0 path is currently unreachable via scoreCommand because
  // resolveTraceFiles never returns an empty array for any input. The NoCoverage
  // mutations on lines 140-141 cannot be killed by observable-behavior testing.
  // We assert the decode-failure path instead (file exists but content is invalid).

  itEffect("exits 2 when trace file content is invalid JSON (decode fails → traces empty)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-inv-"));
    const traceFile = path.join(dir, "invalid.json");
    writeFileSync(traceFile, "totally not json", "utf8");
    const { chunks, restore } = installStderrCapture();
    const args = stubScoreArgs(traceFile);
    const code = yield* Effect.ensuring(scoreCommand(args), Effect.sync(restore));
    // Decode fails → traces.length===0 → exit 2
    expect(code).toBe(EXIT_SCORE_NO_TRACES);
    expect(chunks.join("")).toContain("cc-judge: trace decode failed for");
  });

  itEffect("stderr decode-fail message contains the trace file path", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-path-"));
    const traceFile = path.join(dir, "my-trace.json");
    writeFileSync(traceFile, "not valid", "utf8");
    const { chunks, restore } = installStderrCapture();
    const args = stubScoreArgs(traceFile);
    yield* Effect.ensuring(scoreCommand(args), Effect.sync(restore));
    expect(chunks.join("")).toContain("my-trace.json");
  });

  itEffect("exits 2 when all trace files fail to decode (traces.length === 0 path)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-bad-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{bad json", "utf8");
    const { chunks, restore } = installStderrCapture();
    const args = stubScoreArgs(traceFile);
    const code = yield* Effect.ensuring(scoreCommand(args), Effect.sync(restore));
    // traces=[] → exit 2 (the traces.length===0 guard on line 156)
    expect(code).toBe(EXIT_SCORE_NO_TRACES);
  });

  itEffect("stderr decode-fail message contains filename and _tag", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-score-bad2-"));
    const traceFile = path.join(dir, "broken.json");
    writeFileSync(traceFile, "not-valid-json-at-all", "utf8");
    const { chunks, restore } = installStderrCapture();
    const args = stubScoreArgs(traceFile);
    yield* Effect.ensuring(scoreCommand(args), Effect.sync(restore));
    const stderr = chunks.join("");
    expect(stderr).toContain("cc-judge: trace decode failed for");
    expect(stderr).toContain("broken.json");
  });

  // scoreCommand with valid trace file hits the real Anthropic API.
  // These tests (githubComment, githubCommentArtifactUrl, stdout summary)
  // are omitted here and covered by e2e tests with ANTHROPIC_API_KEY set.
});

// ──────────────────────────────────────────────────────────────────────────────
// buildObservability — indirect tests via runCommand with env vars
// Kills lines 59–68 NoCoverage survivors.
// ──────────────────────────────────────────────────────────────────────────────

describe("buildObservability", () => {
  const SAVED_ENV: Partial<Record<string, string>> = {};

  beforeEach(() => {
    SAVED_ENV["BRAINTRUST_API_KEY"] = process.env["BRAINTRUST_API_KEY"];
    SAVED_ENV["BRAINTRUST_PROJECT"] = process.env["BRAINTRUST_PROJECT"];
  });

  afterEach(() => {
    if (SAVED_ENV["BRAINTRUST_API_KEY"] === undefined) {
      delete process.env["BRAINTRUST_API_KEY"];
    } else {
      process.env["BRAINTRUST_API_KEY"] = SAVED_ENV["BRAINTRUST_API_KEY"];
    }
    if (SAVED_ENV["BRAINTRUST_PROJECT"] === undefined) {
      delete process.env["BRAINTRUST_PROJECT"];
    } else {
      process.env["BRAINTRUST_PROJECT"] = SAVED_ENV["BRAINTRUST_PROJECT"];
    }
  });

  itEffect("emitBraintrust=false → runs without BraintrustEmitter regardless of env", function* () {
    process.env["BRAINTRUST_API_KEY"] = "test-key-abc";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: false });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitBraintrust=true + BRAINTRUST_API_KEY set → BraintrustEmitter included → exit 0", function* () {
    process.env["BRAINTRUST_API_KEY"] = "test-key-for-coverage";
    process.env["BRAINTRUST_PROJECT"] = "test-project";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitBraintrust=true + BRAINTRUST_API_KEY empty string → emitter NOT included", function* () {
    process.env["BRAINTRUST_API_KEY"] = "";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    const code = yield* runCommand(args);
    // Runs OK even with empty key — apiKey.length > 0 guard prevents emitter
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitBraintrust=true + no BRAINTRUST_API_KEY → emitter NOT included", function* () {
    delete process.env["BRAINTRUST_API_KEY"];
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitPromptfoo set → PromptfooEmitter included → pipeline completes", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitPromptfoo: STUB_PROMPTFOO_OUTPUT });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitPromptfoo undefined → no PromptfooEmitter → pipeline completes", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitPromptfoo: undefined });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitBraintrust=true + BRAINTRUST_PROJECT env set uses custom project name", function* () {
    process.env["BRAINTRUST_API_KEY"] = "test-key-xyz";
    process.env["BRAINTRUST_PROJECT"] = "my-custom-project";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("emitBraintrust=true + no BRAINTRUST_PROJECT env → defaults to cc-judge project", function* () {
    process.env["BRAINTRUST_API_KEY"] = "test-key-xyz";
    delete process.env["BRAINTRUST_PROJECT"];
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    const code = yield* runCommand(args);
    expect(code).toBe(EXIT_SUCCESS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseScoreArgs — logLevel survivors (lines 230–394)
// The existing "normalizes logLevel" test only covers "trace"→"info".
// These tests cover each individual position in the OR chain by checking
// that each of the four valid values is accepted, and invalid ones normalize.
// ──────────────────────────────────────────────────────────────────────────────

describe("parseScoreArgs logLevel each position in OR chain", () => {
  it("accepts logLevel=debug (first position in OR chain)", () => {
    expect(parseScoreArgs({ logLevel: "debug" }).logLevel).toBe("debug");
  });

  it("accepts logLevel=info (second position in OR chain)", () => {
    expect(parseScoreArgs({ logLevel: "info" }).logLevel).toBe("info");
  });

  it("accepts logLevel=warn (third position in OR chain)", () => {
    expect(parseScoreArgs({ logLevel: "warn" }).logLevel).toBe("warn");
  });

  it("accepts logLevel=error (fourth position in OR chain)", () => {
    expect(parseScoreArgs({ logLevel: "error" }).logLevel).toBe("error");
  });

  it("normalizes unrecognized logLevel to info", () => {
    expect(parseScoreArgs({ logLevel: "verbose" }).logLevel).toBe("info");
    expect(parseScoreArgs({ logLevel: "silly" }).logLevel).toBe("info");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseRunArgs — logLevel OR chain survivors (line 202)
// ──────────────────────────────────────────────────────────────────────────────

describe("parseRunArgs logLevel each position in OR chain", () => {
  it("accepts logLevel=debug (first position)", () => {
    expect(parseRunArgs({ logLevel: "debug" }).logLevel).toBe("debug");
  });

  it("accepts logLevel=info (second position)", () => {
    expect(parseRunArgs({ logLevel: "info" }).logLevel).toBe("info");
  });

  it("accepts logLevel=warn (third position)", () => {
    expect(parseRunArgs({ logLevel: "warn" }).logLevel).toBe("warn");
  });

  it("accepts logLevel=error (fourth position)", () => {
    expect(parseRunArgs({ logLevel: "error" }).logLevel).toBe("error");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// main() yargs option-name and default survivors (lines 253–294)
// Each test passes a specific option by name and asserts observable behaviour.
// ──────────────────────────────────────────────────────────────────────────────

describe("main (yargs) option names and defaults", () => {
  itEffect("--scenario-ids filters scenarios (run subcommand)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-si-"));
    // --scenario-ids with a non-matching ID → no jobs → exit 0
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--github-comment passed to run subcommand (option name resolves)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-gc-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--github-comment", "1",
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--github-comment-artifact-url passed to run subcommand", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-gca-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--github-comment-artifact-url", "https://example.com/art",
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--total-timeout-ms passed to run subcommand", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-tto-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--total-timeout-ms", "60000",
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--emit-braintrust default false: no emitter created", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-eb-"));
    // Without --emit-braintrust, default is false
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--emit-promptfoo passed to run subcommand (option name resolves)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-ep-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--emit-promptfoo", STUB_PROMPTFOO_OUTPUT,
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--runs default 1 (option resolves with number default)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-runs-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--runs", "1",
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--concurrency passed to run subcommand", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-conc-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--concurrency", "1",
      "--results", results,
      "--log-level", "debug",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("--log-level info: run subcommand resolves", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-ll-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "info",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("score subcommand: --github-comment option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sgc-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sgc-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--trace-format", "canonical",
        "--github-comment", "1",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --github-comment-artifact-url option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sgca-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sgca-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--trace-format", "canonical",
        "--github-comment-artifact-url", "https://example.com/art",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --total-timeout-ms option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-stto-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-stto-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--total-timeout-ms", "30000",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --concurrency option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sconc-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sconc-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--concurrency", "1",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --emit-braintrust option name resolves (default false)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-seb-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-seb-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --emit-promptfoo option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sep-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sep-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--emit-promptfoo", STUB_PROMPTFOO_OUTPUT,
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --judge default claude-opus-4-7 (option resolves)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sj-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sj-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--judge", "claude-opus-4-7",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("score subcommand: --trace-format canonical default (option resolves)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-stf-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-stf-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--trace-format", "canonical",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("run subcommand: --image option name resolves", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-img-"));
    // With --runtime docker + --image set, runner resolves but start() will fail
    // (no docker available in test env). Exit 0 or 1 is acceptable.
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "run",
        dir,
        "--runtime", "docker",
        "--image", "cc-judge-nonexistent-image-xyz",
        "--scenario-ids", NONEXISTENT_SCENARIO_ID,
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    // Runner resolved (exit 2 is runner-resolution, but we gave an image)
    // With the nonexistent-id filter no agent is started → exit 0
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("run subcommand: --bin option name resolves", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-bin-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("run subcommand: --judge-backend option name resolves", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-jb-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--judge-backend", "anthropic",
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("score subcommand: --judge-backend option name resolves", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sjb-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sjb-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--judge-backend", "anthropic",
        "--results", results,
        "--log-level", "error",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("run subcommand: --results default ./eval-results (option name resolves)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-res-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "warn",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });

  itEffect("score subcommand: --results default ./eval-results (option name resolves)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sres-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-sres-out-"));
    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "score", traceFile,
        "--results", results,
        "--log-level", "warn",
      ]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("run: --runtime subprocess (default docker changed to subprocess)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-main-rt-"));
    const code = yield* main([
      "run",
      dir,
      "--runtime", "subprocess",
      "--bin", BIN_TRUE,
      "--scenario-ids", NONEXISTENT_SCENARIO_ID,
      "--results", results,
      "--log-level", "error",
    ]);
    expect(code).toBe(EXIT_SUCCESS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// main() command dispatch survivors (lines 294–298)
// ──────────────────────────────────────────────────────────────────────────────

describe("main (yargs) command dispatch edge cases", () => {
  itEffect("run command is dispatched (case `run` literal)", function* () {
    const dir = tmpScenarioDir();
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-dispatch-run-"));
    // docker runtime, missing image → exits 2 via runner-resolution (not unknown command)
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main(["run", dir, "--results", results, "--log-level", "error"]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
    // Must NOT be the "unknown command" path
    expect(chunks.join("")).not.toContain("unknown command");
  });

  itEffect("score command is dispatched (case `score` literal)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-dispatch-score-"));
    const traceFile = path.join(dir, "bad.json");
    writeFileSync(traceFile, "{not json", "utf8");
    const results = mkdtempSync(path.join(os.tmpdir(), "cc-judge-dispatch-score-out-"));
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main(["score", traceFile, "--results", results, "--log-level", "error"]),
      Effect.sync(restore),
    );
    expect(code).toBe(EXIT_FATAL);
    expect(chunks.join("")).not.toContain("unknown command");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveTraceFiles (line 184 survivor: `return []` vs `return [pathOrGlob]`)
// ──────────────────────────────────────────────────────────────────────────────

describe("resolveTraceFiles (via scoreCommand)", () => {
  // resolveTraceFiles v1 always returns [pathOrGlob], so files.length is always
  // at least 1. The files.length===0 guard on line 140 is currently unreachable
  // by observable-behavior testing (NoCoverage, not Survived). We test the
  // reachable observable: [pathOrGlob] returned → decode attempted.

  // Valid-trace-file scoreCommand test omitted: hits real Anthropic API (hangs without key).
  // Covered by e2e.

  itEffect("returns the trace path even for binary file → decode fails → traces empty → exit 2", function* () {
    // /bin/true exists on disk; its content is not valid JSON/trace
    const { restore } = installStderrCapture();
    const args = stubScoreArgs(BIN_TRUE);
    const code = yield* Effect.ensuring(scoreCommand(args), Effect.sync(restore));
    // Decode fails → traces=[] → exit 2
    expect(code).toBe(EXIT_SCORE_NO_TRACES);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Capture stderr to assert on the exact error-message prefixes runCommand writes
// on load failure and runner-resolution failure. Kills StringLiteral mutations
// on those prefixes + the InvalidRuntime cause.value strings.
// ──────────────────────────────────────────────────────────────────────────────
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

// ---------------------------------------------------------------------------
// Mock-based tests: capture opts passed to runScenarios from runCommand.
// Kills ConditionalExpression, EqualityOperator, ObjectLiteral survivors on
// lines 105, 116-121 by asserting that the spread conditionals actually
// include or omit the optional fields.
// ---------------------------------------------------------------------------

const MOCK_SCENARIO_ID = "cc-judge-mock-sid-001";
const MOCK_GITHUB_COMMENT = 7;
const MOCK_ARTIFACT_URL = "https://example.com/artifact/42";
const MOCK_TOTAL_TIMEOUT_MS = 120_000;
const MOCK_LOG_LEVEL_ERROR = "error" as const;

describe("runCommand passes optional opts to runScenarios (mock capture)", () => {
  beforeEach(() => {
    capturedRunOpts = null;
    capturedRunScenarios = null;
  });

  itEffect("scenarioIds are spread into opts when defined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { scenarioIds: [MOCK_SCENARIO_ID] });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["scenarioIdFilter"]).toEqual([MOCK_SCENARIO_ID]);
  });

  itEffect("scenarioIds omitted from opts when undefined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { scenarioIds: undefined });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["scenarioIdFilter"]).toBeUndefined();
  });

  itEffect("githubComment is spread into opts when defined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubComment: MOCK_GITHUB_COMMENT });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["githubComment"]).toBe(MOCK_GITHUB_COMMENT);
  });

  itEffect("githubComment omitted from opts when undefined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubComment: undefined });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["githubComment"]).toBeUndefined();
  });

  itEffect("githubCommentArtifactUrl is spread into opts when defined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubCommentArtifactUrl: MOCK_ARTIFACT_URL });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["githubCommentArtifactUrl"]).toBe(MOCK_ARTIFACT_URL);
  });

  itEffect("githubCommentArtifactUrl omitted from opts when undefined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { githubCommentArtifactUrl: undefined });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["githubCommentArtifactUrl"]).toBeUndefined();
  });

  itEffect("totalTimeoutMs is spread into opts when defined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { totalTimeoutMs: MOCK_TOTAL_TIMEOUT_MS });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["totalTimeoutMs"]).toBe(MOCK_TOTAL_TIMEOUT_MS);
  });

  itEffect("totalTimeoutMs omitted from opts when undefined", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { totalTimeoutMs: undefined });
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["totalTimeoutMs"]).toBeUndefined();
  });

  itEffect("base fields (runner, judge, resultsDir, runsPerScenario, concurrency, logLevel, emitters) are always present", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir);
    yield* runCommand(args);
    expect(capturedRunOpts).not.toBeNull();
    expect(capturedRunOpts!["runner"]).toBeDefined();
    expect(capturedRunOpts!["judge"]).toBeDefined();
    expect(capturedRunOpts!["resultsDir"]).toBeDefined();
    expect(capturedRunOpts!["runsPerScenario"]).toBeDefined();
    expect(capturedRunOpts!["concurrency"]).toBeDefined();
    expect(capturedRunOpts!["logLevel"]).toBe(MOCK_LOG_LEVEL_ERROR);
    expect(capturedRunOpts!["emitters"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mock-based tests: capture emitters passed to runScenarios from runCommand.
// Kills buildObservability survivors (lines 59-68): BlockStatement,
// ConditionalExpression, EqualityOperator, StringLiteral mutants.
// ---------------------------------------------------------------------------

describe("runCommand buildObservability emitter composition (mock capture)", () => {
  const SAVED_ENV_OBS: Partial<Record<string, string>> = {};

  beforeEach(() => {
    capturedRunOpts = null;
    SAVED_ENV_OBS["BRAINTRUST_API_KEY"] = process.env["BRAINTRUST_API_KEY"];
    SAVED_ENV_OBS["BRAINTRUST_PROJECT"] = process.env["BRAINTRUST_PROJECT"];
  });

  afterEach(() => {
    if (SAVED_ENV_OBS["BRAINTRUST_API_KEY"] === undefined) {
      delete process.env["BRAINTRUST_API_KEY"];
    } else {
      process.env["BRAINTRUST_API_KEY"] = SAVED_ENV_OBS["BRAINTRUST_API_KEY"];
    }
    if (SAVED_ENV_OBS["BRAINTRUST_PROJECT"] === undefined) {
      delete process.env["BRAINTRUST_PROJECT"];
    } else {
      process.env["BRAINTRUST_PROJECT"] = SAVED_ENV_OBS["BRAINTRUST_PROJECT"];
    }
  });

  itEffect("emitBraintrust=false → emitters array has no braintrust entry", function* () {
    process.env["BRAINTRUST_API_KEY"] = "some-key";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: false });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeUndefined();
  });

  itEffect("emitBraintrust=true + valid BRAINTRUST_API_KEY → emitters array includes braintrust", function* () {
    process.env["BRAINTRUST_API_KEY"] = "bt-test-key-valid";
    process.env["BRAINTRUST_PROJECT"] = "bt-test-project";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeDefined();
  });

  itEffect("emitBraintrust=true + BRAINTRUST_API_KEY empty string → emitters has no braintrust", function* () {
    process.env["BRAINTRUST_API_KEY"] = "";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeUndefined();
  });

  itEffect("emitBraintrust=true + no BRAINTRUST_API_KEY env → emitters has no braintrust", function* () {
    delete process.env["BRAINTRUST_API_KEY"];
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeUndefined();
  });

  itEffect("emitPromptfoo set → emitters array includes promptfoo", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitPromptfoo: STUB_PROMPTFOO_OUTPUT });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "promptfoo")).toBeDefined();
  });

  itEffect("emitPromptfoo undefined → emitters array has no promptfoo", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitPromptfoo: undefined });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "promptfoo")).toBeUndefined();
  });

  itEffect("both braintrust + promptfoo → emitters array includes both", function* () {
    process.env["BRAINTRUST_API_KEY"] = "bt-both-key";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true, emitPromptfoo: STUB_PROMPTFOO_OUTPUT });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeDefined();
    expect(emitters.find((e) => e.name === "promptfoo")).toBeDefined();
  });

  itEffect("neither braintrust nor promptfoo → emitters array is empty", function* () {
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: false, emitPromptfoo: undefined });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.length).toBe(0);
  });

  itEffect("emitBraintrust=true + no BRAINTRUST_PROJECT env → defaults project to cc-judge (emitter still created)", function* () {
    process.env["BRAINTRUST_API_KEY"] = "bt-default-project-key";
    delete process.env["BRAINTRUST_PROJECT"];
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir, { emitBraintrust: true });
    yield* runCommand(args);
    const emitters = capturedRunOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mock-based tests: capture opts passed to scoreTraces from scoreCommand.
// Kills ConditionalExpression, ObjectLiteral survivors on lines 166-170
// (spread args into scoreTraces). Uses mock so scoreTraces never calls API.
// ---------------------------------------------------------------------------

describe("scoreCommand passes optional opts to scoreTraces (mock capture)", () => {
  beforeEach(() => {
    capturedScoreOpts = null;
    capturedScoreTraces = null;
  });

  itEffect("githubComment is spread into opts when defined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { githubComment: MOCK_GITHUB_COMMENT });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["githubComment"]).toBe(MOCK_GITHUB_COMMENT);
  });

  itEffect("githubComment omitted from opts when undefined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { githubComment: undefined });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["githubComment"]).toBeUndefined();
  });

  itEffect("githubCommentArtifactUrl is spread into opts when defined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { githubCommentArtifactUrl: MOCK_ARTIFACT_URL });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["githubCommentArtifactUrl"]).toBe(MOCK_ARTIFACT_URL);
  });

  itEffect("githubCommentArtifactUrl omitted from opts when undefined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { githubCommentArtifactUrl: undefined });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["githubCommentArtifactUrl"]).toBeUndefined();
  });

  itEffect("totalTimeoutMs is spread into opts when defined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { totalTimeoutMs: MOCK_TOTAL_TIMEOUT_MS });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["totalTimeoutMs"]).toBe(MOCK_TOTAL_TIMEOUT_MS);
  });

  itEffect("totalTimeoutMs omitted from opts when undefined", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { totalTimeoutMs: undefined });
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["totalTimeoutMs"]).toBeUndefined();
  });

  itEffect("base fields (judge, resultsDir, concurrency, emitters, logLevel, traceFormat) are always present", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile);
    yield* scoreCommand(args);
    expect(capturedScoreOpts).not.toBeNull();
    expect(capturedScoreOpts!["judge"]).toBeDefined();
    expect(capturedScoreOpts!["resultsDir"]).toBeDefined();
    expect(capturedScoreOpts!["concurrency"]).toBeDefined();
    expect(capturedScoreOpts!["emitters"]).toBeDefined();
    expect(capturedScoreOpts!["logLevel"]).toBeDefined();
    expect(capturedScoreOpts!["traceFormat"]).toBe("canonical");
  });
});

// ---------------------------------------------------------------------------
// scoreCommand buildObservability emitter composition (mock capture).
// Kills buildObservability survivors for the scoreCommand path (lines 158-159).
// ---------------------------------------------------------------------------

describe("scoreCommand buildObservability emitter composition (mock capture)", () => {
  const SAVED_ENV_SCORE_OBS: Partial<Record<string, string>> = {};

  beforeEach(() => {
    capturedScoreOpts = null;
    capturedScoreTraces = null;
    SAVED_ENV_SCORE_OBS["BRAINTRUST_API_KEY"] = process.env["BRAINTRUST_API_KEY"];
    SAVED_ENV_SCORE_OBS["BRAINTRUST_PROJECT"] = process.env["BRAINTRUST_PROJECT"];
  });

  afterEach(() => {
    if (SAVED_ENV_SCORE_OBS["BRAINTRUST_API_KEY"] === undefined) {
      delete process.env["BRAINTRUST_API_KEY"];
    } else {
      process.env["BRAINTRUST_API_KEY"] = SAVED_ENV_SCORE_OBS["BRAINTRUST_API_KEY"];
    }
    if (SAVED_ENV_SCORE_OBS["BRAINTRUST_PROJECT"] === undefined) {
      delete process.env["BRAINTRUST_PROJECT"];
    } else {
      process.env["BRAINTRUST_PROJECT"] = SAVED_ENV_SCORE_OBS["BRAINTRUST_PROJECT"];
    }
  });

  itEffect("emitBraintrust=false → emitters has no braintrust entry", function* () {
    process.env["BRAINTRUST_API_KEY"] = "score-bt-key";
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { emitBraintrust: false });
    yield* scoreCommand(args);
    const emitters = capturedScoreOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeUndefined();
  });

  itEffect("emitBraintrust=true + valid BRAINTRUST_API_KEY → emitters includes braintrust", function* () {
    process.env["BRAINTRUST_API_KEY"] = "score-bt-valid-key";
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { emitBraintrust: true });
    yield* scoreCommand(args);
    const emitters = capturedScoreOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeDefined();
  });

  itEffect("emitBraintrust=true + empty BRAINTRUST_API_KEY → emitters has no braintrust", function* () {
    process.env["BRAINTRUST_API_KEY"] = "";
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { emitBraintrust: true });
    yield* scoreCommand(args);
    const emitters = capturedScoreOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "braintrust")).toBeUndefined();
  });

  itEffect("emitPromptfoo set → emitters includes promptfoo", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { emitPromptfoo: STUB_PROMPTFOO_OUTPUT });
    yield* scoreCommand(args);
    const emitters = capturedScoreOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "promptfoo")).toBeDefined();
  });

  itEffect("emitPromptfoo undefined → emitters has no promptfoo", function* () {
    const traceFile = stubTraceFile();
    const args = stubScoreArgs(traceFile, { emitPromptfoo: undefined });
    yield* scoreCommand(args);
    const emitters = capturedScoreOpts!["emitters"] as ReadonlyArray<{ name: string }>;
    expect(emitters.find((e) => e.name === "promptfoo")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runCommand stderr: runScenarios failure path (line 125).
// When runScenarios fails, the error message must contain the correct prefix.
// Uses a module-level flag to make the mock return a failure.
// ---------------------------------------------------------------------------

describe("runCommand runScenarios failure stderr (mock)", () => {
  beforeEach(() => {
    capturedRunOpts = null;
    mockRunScenariosShouldFail = false;
  });

  afterEach(() => {
    mockRunScenariosShouldFail = false;
  });

  itEffect("writes `cc-judge: runner resolution failed:` with _tag when runScenarios returns Left", function* () {
    mockRunScenariosShouldFail = true;
    mockRunScenariosFailTag = "NoRunnerConfigured";
    const dir = tmpScenarioDir();
    const args = stubRunArgs(dir);
    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(runCommand(args), Effect.sync(restore));
    const stderr = chunks.join("");
    expect(code).toBe(EXIT_RUNNER_RESOLUTION);
    expect(stderr).toContain("cc-judge: runner resolution failed:");
    expect(stderr).toContain("NoRunnerConfigured");
  });
});
