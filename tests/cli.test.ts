import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCommand, scoreCommand, main, type RunCliArgs, type ScoreCliArgs } from "../src/app/cli.js";
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
});
