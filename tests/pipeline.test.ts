import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runScenarios, scoreTraces } from "../src/app/pipeline.js";
import { ScenarioId, TraceId } from "../src/core/types.js";
import type { Scenario, Trace, JudgeResult } from "../src/core/schema.js";
import type { JudgeBackend } from "../src/judge/index.js";
import type { AgentRunner, AgentHandle } from "../src/runner/index.js";
import type { AgentStartError, AgentRunTimeoutError } from "../src/core/errors.js";

const stubJudge: JudgeBackend = {
  name: "stub",
  judge() {
    const result: JudgeResult = {
      pass: true,
      reason: "stub pass",
      issues: [],
      overallSeverity: null,
      retryCount: 0,
    };
    return Effect.succeed(result);
  },
};

const failingJudge: JudgeBackend = {
  name: "stub-fail",
  judge() {
    const result: JudgeResult = {
      pass: false,
      reason: "stub fail",
      issues: [{ issue: "nope", severity: "significant" }],
      overallSeverity: "significant",
      retryCount: 0,
    };
    return Effect.succeed(result);
  },
};

const stubRunner: AgentRunner = {
  kind: "subprocess",
  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never> {
    return Effect.succeed({
      __brand: "AgentHandle",
      kind: "subprocess",
      scenarioId: scenario.id,
      workspaceDir: "/tmp/none",
      initialFiles: new Map<string, string>(),
      turnsExecuted: { count: 0 },
    });
  },
  turn(_handle, prompt): Effect.Effect<import("../src/core/types.js").Turn, AgentRunTimeoutError, never> {
    return Effect.succeed({
      index: 0,
      prompt,
      response: `echo: ${prompt}`,
      startedAt: "2026-04-18T00:00:00.000Z",
      latencyMs: 10,
      toolCallCount: 0,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  },
  diff() {
    return Effect.succeed({ changed: [] });
  },
  stop() {
    return Effect.void;
  },
};

function makeScenario(id: string): Scenario {
  return {
    id: ScenarioId(id),
    name: id,
    description: "test",
    axis: "principle-3-typed-errors",
    setupPrompt: "do it",
    expectedBehavior: "does it",
    validationChecks: ["does it"],
  };
}

describe("runScenarios", () => {
  it("produces a Report with pass counts for a happy-path runner+judge", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = await Effect.runPromise(
      runScenarios([makeScenario("happy")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
      }),
    );
    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.runs[0]?.pass).toBe(true);
  });

  it("reports failure when judge fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = await Effect.runPromise(
      runScenarios([makeScenario("sad")], {
        runner: stubRunner,
        judge: failingJudge,
        resultsDir: dir,
      }),
    );
    expect(report.summary.failed).toBe(1);
    expect(report.runs[0]?.overallSeverity).toBe("significant");
  });
});

describe("scoreTraces", () => {
  it("builds records from traces without invoking a runner", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("t-1"),
      name: "trace",
      turns: [
        {
          index: 0,
          prompt: "hi",
          response: "hello",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 10,
          toolCallCount: 0,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      expectedBehavior: "greets",
      validationChecks: ["says hello"],
    };
    const report = await Effect.runPromise(
      scoreTraces([trace], { judge: stubJudge, resultsDir: dir }),
    );
    expect(report.summary.total).toBe(1);
    expect(report.runs[0]?.source).toBe("trace");
    expect(report.runs[0]?.traceId).toBe("t-1");
  });
});
