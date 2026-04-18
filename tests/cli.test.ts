import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCommand, type RunCliArgs } from "../src/app/cli.js";

function tmpScenarioDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-cli-"));
  const yaml = `
id: cli-t
name: cli-t
description: d
axis: principle-3-typed-errors
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
  it("exits 2 when runtime=docker but --image is missing", async () => {
    const dir = tmpScenarioDir();
    const code = await Effect.runPromise(runCommand(baseArgs(dir)));
    expect(code).toBe(2);
  });

  it("exits 2 when runtime=subprocess but --bin is missing", async () => {
    const dir = tmpScenarioDir();
    const args: RunCliArgs = { ...baseArgs(dir), runtime: "subprocess" };
    const code = await Effect.runPromise(runCommand(args));
    expect(code).toBe(2);
  });
});
