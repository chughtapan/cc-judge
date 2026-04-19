import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runScenarios, runScenario, scoreTraces } from "../src/app/pipeline.js";
import {
  ScenarioId,
  TraceId,
  ISSUE_SEVERITY,
  RUN_SOURCE,
} from "../src/core/types.js";
import type { Scenario, Trace, JudgeResult } from "../src/core/schema.js";
import type { JudgeBackend } from "../src/judge/index.js";
import type { AgentRunner, AgentHandle } from "../src/runner/index.js";
import type {
  AgentStartError,
  AgentRunTimeoutError,
  RunnerResolutionError,
} from "../src/core/errors.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

const EXPECTED_TOTAL_ONE = 1;
const EXPECTED_PASSED_ONE = 1;
const EXPECTED_FAILED_ONE = 1;
const EXPECTED_TOTAL_ZERO = 0;
const EXPECTED_AVG_ZERO = 0;
const EXPECTED_TOTAL_TWO = 2;
const EXPECTED_TOTAL_FOUR = 4;
const EXPECTED_PROMPT_COUNT_ONE = 1;
const HAPPY_TRACE_ID = "t-1";
const TRACE_ID_WITH_SCENARIO = "t-with-scen";
const TRACE_SCENARIO_ID = "trace-scen-id";
const SCEN_ID_ALPHA = "alpha";
const SCEN_ID_BETA = "beta";
const PIPELINE_ERROR_PREFIX = "pipeline error:";
const TIMEOUT_ERROR_FRAGMENT = "timed out";
const AGENT_START_FAILED_FRAGMENT = "agent start failed";
const DIFF_ADDED_COUNT_ONE = 1;
const DIFF_CHANGED_COUNT_ONE = 1;
const DIFF_REMOVED_COUNT_ONE = 1;
const TURN_TOKENS_IN = 5;
const TURN_TOKENS_OUT = 7;
const TURN_CACHE_READ = 3;
const TURN_CACHE_WRITE = 2;
const TURN_TOOL_CALLS = 4;
const RUNS_PER_SCENARIO_TWO = 2;
const MODEL_DOCKER_FRAGMENT = "docker";
const MODEL_SUBPROCESS_FRAGMENT = "subprocess";

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
    setupPrompt: "do it",
    expectedBehavior: "does it",
    validationChecks: ["does it"],
  };
}

describe("runScenarios", () => {
  itEffect("produces a Report with pass counts for a happy-path runner+judge", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario("happy")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
    expect(report.summary.passed).toBe(EXPECTED_PASSED_ONE);
    expect(report.runs[0]?.pass).toBe(true);
  });

  itEffect("reports failure when judge fails", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario("sad")], {
      runner: stubRunner,
      judge: failingJudge,
      resultsDir: dir,
    });
    expect(report.summary.failed).toBe(EXPECTED_FAILED_ONE);
    expect(report.runs[0]?.overallSeverity).toBe(ISSUE_SEVERITY.Significant);
  });
});

describe("scoreTraces", () => {
  itEffect("builds records from traces without invoking a runner", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId(HAPPY_TRACE_ID),
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
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
    expect(report.runs[0]?.source).toBe(RUN_SOURCE.Trace);
    expect(report.runs[0]?.traceId).toBe(HAPPY_TRACE_ID);
  });

  itEffect("derives scenarioId from traceId when trace has no explicit scenarioId", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("no-scen-trace"),
      name: "t",
      turns: [],
      expectedBehavior: "anything",
      validationChecks: ["ok"],
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    expect(report.runs[0]?.scenarioId).not.toBeUndefined();
  });

  itEffect("uses explicit scenarioId from trace when provided", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId(TRACE_ID_WITH_SCENARIO),
      scenarioId: ScenarioId(TRACE_SCENARIO_ID),
      name: "t",
      turns: [{
        index: 0,
        prompt: "ask",
        response: "answer",
        startedAt: "2026-04-18T00:00:00.000Z",
        latencyMs: 5,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    expect(report.runs[0]?.scenarioId).toBe(TRACE_SCENARIO_ID);
  });

  itEffect("carries workspaceDiff through when trace provides one", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("wd-trace"),
      name: "wd",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "a.txt", before: null, after: "new" },
          { path: "b.txt", before: "old", after: null },
          { path: "c.txt", before: "x", after: "y" },
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const summary = report.runs[0]?.workspaceDiffSummary;
    expect(summary?.added).toBe(DIFF_ADDED_COUNT_ONE);
    expect(summary?.removed).toBe(DIFF_REMOVED_COUNT_ONE);
    expect(summary?.changed).toBe(DIFF_CHANGED_COUNT_ONE);
  });
});

describe("runScenarios edge cases (pipeline hardening)", () => {
  itEffect("yields avgLatencyMs=0 when no scenarios selected by filter", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario(SCEN_ID_ALPHA)], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      scenarioIdFilter: [SCEN_ID_BETA],
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ZERO);
    expect(report.summary.avgLatencyMs).toBe(EXPECTED_AVG_ZERO);
    expect(report.summary.passed).toBe(EXPECTED_TOTAL_ZERO);
    expect(report.summary.failed).toBe(EXPECTED_TOTAL_ZERO);
  });

  itEffect("applies scenarioIdFilter inclusively (keeps listed ids)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA)],
      {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        scenarioIdFilter: [SCEN_ID_ALPHA],
      },
    );
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
    expect(report.runs[0]?.scenarioId).toBe(SCEN_ID_ALPHA);
  });

  itEffect("multiplies runs by runsPerScenario and numbers them 1..N", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA)],
      {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        runsPerScenario: RUNS_PER_SCENARIO_TWO,
      },
    );
    expect(report.summary.total).toBe(EXPECTED_TOTAL_FOUR);
    const numbers = report.runs.map((r) => r.runNumber).sort();
    expect(numbers).toEqual([1, 1, 2, 2]);
  });

  itEffect("aggregates turn tokens and tool calls into RunRecord", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const countingRunner: AgentRunner = {
      ...stubRunner,
      turn(_handle, prompt) {
        return Effect.succeed({
          index: 0,
          prompt,
          response: "r",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 1,
          toolCallCount: TURN_TOOL_CALLS,
          inputTokens: TURN_TOKENS_IN,
          outputTokens: TURN_TOKENS_OUT,
          cacheReadTokens: TURN_CACHE_READ,
          cacheWriteTokens: TURN_CACHE_WRITE,
        });
      },
    };
    const report = yield* runScenarios([makeScenario("count")], {
      runner: countingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const rec = report.runs[0];
    expect(rec?.toolCallCount).toBe(TURN_TOOL_CALLS);
    expect(rec?.inputTokens).toBe(TURN_TOKENS_IN);
    expect(rec?.outputTokens).toBe(TURN_TOKENS_OUT);
    expect(rec?.cacheReadTokens).toBe(TURN_CACHE_READ);
    expect(rec?.cacheWriteTokens).toBe(TURN_CACHE_WRITE);
  });

  itEffect("folds runner.start failure into critical JudgeResult without throwing", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const startFailingRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.fail({
          _tag: "AgentStartError",
          scenarioId: scenario.id,
          cause: { _tag: "WorkspacePathEscape", wfPath: "bad" },
        } as unknown as AgentStartError);
      },
    };
    const report = yield* runScenarios([makeScenario("start-fail")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.summary.failed).toBe(EXPECTED_FAILED_ONE);
    expect(report.runs[0]?.overallSeverity).toBe(ISSUE_SEVERITY.Critical);
    expect(report.runs[0]?.reason).toContain(AGENT_START_FAILED_FRAGMENT);
    expect(report.runs[0]?.reason.startsWith(PIPELINE_ERROR_PREFIX)).toBe(true);
  });

  itEffect("folds turn timeout into critical JudgeResult", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const timeoutRunner: AgentRunner = {
      ...stubRunner,
      turn() {
        return Effect.fail({
          _tag: "AgentRunTimeoutError",
          turnIndex: 0,
          timeoutMs: 1000,
        } as unknown as AgentRunTimeoutError);
      },
    };
    const report = yield* runScenarios([makeScenario("timeout")], {
      runner: timeoutRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.runs[0]?.overallSeverity).toBe(ISSUE_SEVERITY.Critical);
    expect(report.runs[0]?.reason).toContain(TIMEOUT_ERROR_FRAGMENT);
  });

  itEffect("tags modelName with runner.kind (subprocess vs docker)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const dockerStub: AgentRunner = { ...stubRunner, kind: "docker" };
    const report1 = yield* runScenarios([makeScenario("sub")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const report2 = yield* runScenarios([makeScenario("doc")], {
      runner: dockerStub,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report1.runs[0]?.modelName).toContain(MODEL_SUBPROCESS_FRAGMENT);
    expect(report2.runs[0]?.modelName).toContain(MODEL_DOCKER_FRAGMENT);
  });

  itEffect("runScenario delegates to runScenarios (single-scenario convenience)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenario(makeScenario("single"), {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
    expect(report.runs[0]?.scenarioId).toBe("single");
  });

  itEffect("processes followUp prompts in addition to setupPrompt", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const seen: string[] = [];
    const tracingRunner: AgentRunner = {
      ...stubRunner,
      turn(_handle, prompt) {
        seen.push(prompt);
        return Effect.succeed({
          index: seen.length - 1,
          prompt,
          response: "r",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      },
    };
    const scen: Scenario = {
      ...makeScenario("fu"),
      followUps: ["followup-1", "followup-2"],
    };
    yield* runScenarios([scen], {
      runner: tracingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(seen).toEqual(["do it", "followup-1", "followup-2"]);
  });

  itEffect("fails with RunnerResolutionError when neither runner opt nor env is set", function* () {
    const prevBin = process.env["CC_JUDGE_SUBPROCESS_BIN"];
    const prevImg = process.env["CC_JUDGE_DOCKER_IMAGE"];
    delete process.env["CC_JUDGE_SUBPROCESS_BIN"];
    delete process.env["CC_JUDGE_DOCKER_IMAGE"];
    try {
      const result = yield* Effect.either(
        runScenarios([makeScenario("no-runner")], { judge: stubJudge }),
      );
      expect(result._tag).toBe(EITHER_LEFT);
      if (result._tag === EITHER_LEFT) {
        const err = result.left as RunnerResolutionError;
        expect(err.cause._tag).toBe("NoRunnerConfigured");
      }
    } finally {
      if (prevBin !== undefined) process.env["CC_JUDGE_SUBPROCESS_BIN"] = prevBin;
      if (prevImg !== undefined) process.env["CC_JUDGE_DOCKER_IMAGE"] = prevImg;
    }
  });

  itEffect("resolves SubprocessRunner from CC_JUDGE_SUBPROCESS_BIN env var", function* () {
    const prevBin = process.env["CC_JUDGE_SUBPROCESS_BIN"];
    process.env["CC_JUDGE_SUBPROCESS_BIN"] = "/bin/true";
    try {
      const result = yield* Effect.either(
        runScenarios([], { judge: stubJudge }),
      );
      expect(result._tag).toBe("Right");
      if (result._tag === "Right") {
        expect(result.right.summary.total).toBe(0);
      }
    } finally {
      if (prevBin !== undefined) process.env["CC_JUDGE_SUBPROCESS_BIN"] = prevBin;
      else delete process.env["CC_JUDGE_SUBPROCESS_BIN"];
    }
  });

  itEffect("resolves DockerRunner from CC_JUDGE_DOCKER_IMAGE env var when subprocess bin is absent", function* () {
    const prevBin = process.env["CC_JUDGE_SUBPROCESS_BIN"];
    const prevImg = process.env["CC_JUDGE_DOCKER_IMAGE"];
    delete process.env["CC_JUDGE_SUBPROCESS_BIN"];
    process.env["CC_JUDGE_DOCKER_IMAGE"] = "dummy:latest";
    try {
      const result = yield* Effect.either(
        runScenarios([], { judge: stubJudge }),
      );
      expect(result._tag).toBe("Right");
    } finally {
      if (prevBin !== undefined) process.env["CC_JUDGE_SUBPROCESS_BIN"] = prevBin;
      if (prevImg !== undefined) process.env["CC_JUDGE_DOCKER_IMAGE"] = prevImg;
      else delete process.env["CC_JUDGE_DOCKER_IMAGE"];
    }
  });
});

// Targeted kills for specific survivors observed in the epic #37 final run:
// summarizeDiff branches, criticalJudgeFromError issue-array shape,
// buildRecord start-failure invariants.
describe("runScenarios targeted assertions", () => {
  const DIFF_ADDED_TWO = 2;
  const DIFF_REMOVED_ONE = 1;
  const DIFF_CHANGED_ZERO = 0;
  const DIFF_ADDED_ZERO = 0;
  const DIFF_REMOVED_TWO = 2;
  const DIFF_CHANGED_THREE = 3;

  itEffect("summarizeDiff counts pure additions (before=null, after!=null)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("add-only"),
      name: "add",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "new1.txt", before: null, after: "content1" },
          { path: "new2.txt", before: null, after: "content2" },
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_TWO);
    expect(sum?.removed).toBe(DIFF_ADDED_ZERO);
    expect(sum?.changed).toBe(DIFF_CHANGED_ZERO);
  });

  itEffect("summarizeDiff counts pure modifications (before!=null, after!=null)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("mod-only"),
      name: "mod",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "a.txt", before: "old-a", after: "new-a" },
          { path: "b.txt", before: "old-b", after: "new-b" },
          { path: "c.txt", before: "old-c", after: "new-c" },
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_ZERO);
    expect(sum?.removed).toBe(DIFF_ADDED_ZERO);
    expect(sum?.changed).toBe(DIFF_CHANGED_THREE);
  });

  itEffect("summarizeDiff counts pure removals (before!=null, after=null)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("rm-only"),
      name: "rm",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "gone1.txt", before: "x", after: null },
          { path: "gone2.txt", before: "y", after: null },
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.removed).toBe(DIFF_REMOVED_TWO);
    expect(sum?.added).toBe(DIFF_ADDED_ZERO);
    expect(sum?.changed).toBe(DIFF_CHANGED_ZERO);
  });

  itEffect("summarizeDiff zero'd when no workspaceDiff is provided", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("no-diff"),
      name: "nd",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_ZERO);
    expect(sum?.removed).toBe(DIFF_ADDED_ZERO);
    expect(sum?.changed).toBe(DIFF_CHANGED_ZERO);
  });

  itEffect("criticalJudgeFromError produces a single critical-severity issue", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const startFailingRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.fail({
          _tag: "AgentStartError",
          scenarioId: scenario.id,
          cause: { _tag: "WorkspacePathEscape", wfPath: "bad" },
        } as unknown as AgentStartError);
      },
    };
    const report = yield* runScenarios([makeScenario("start-fail-issues")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const rec = report.runs[0];
    expect(rec?.issues.length).toBe(1);
    expect(rec?.issues[0]?.severity).toBe(ISSUE_SEVERITY.Critical);
    expect(rec?.issues[0]?.issue.length).toBeGreaterThan(0);
  });

  itEffect("buildRecord on runner-start failure uses empty transcriptPath and nonnegative latency", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const startFailingRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.fail({
          _tag: "AgentStartError",
          scenarioId: scenario.id,
          cause: { _tag: "WorkspacePathEscape", wfPath: "bad" },
        } as unknown as AgentStartError);
      },
    };
    const report = yield* runScenarios([makeScenario("start-fail-record")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const rec = report.runs[0];
    expect(rec?.transcriptPath).toBe("");
    expect(rec?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  itEffect("invokes obs.onRun for every record and obs.onReport once per run", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const onRunCalls: string[] = [];
    let onReportCalls = 0;
    const obs = {
      name: "test-obs",
      onRun: ({ record }: { record: { scenarioId: string } }) => {
        onRunCalls.push(record.scenarioId);
        return Effect.void;
      },
      onReport: () => {
        onReportCalls += 1;
        return Effect.void;
      },
    };
    yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA)],
      {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        emitters: [obs],
      },
    );
    expect(onRunCalls.sort()).toEqual([SCEN_ID_ALPHA, SCEN_ID_BETA]);
    expect(onReportCalls).toBe(1);
  });
});
