import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCommand, type RunCliArgs } from "../src/app/cli.js";
import { itEffect } from "./support/effect.js";

const EXIT_RUNNER_RESOLUTION = 2;

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
});
