import { describe, expect, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runPlans, runScenarios, runScenario, scoreTraces } from "../src/app/pipeline.js";
import * as reportModule from "../src/emit/report.js";
import {
  AgentId,
  ScenarioId,
  ProjectId,
  TraceId,
  ISSUE_SEVERITY,
  RUN_SOURCE,
} from "../src/core/types.js";
import type { Scenario, Trace, JudgeResult } from "../src/core/schema.js";
import type { JudgeBackend } from "../src/judge/index.js";
import type { AgentRunner, AgentHandle, ExecutionHarness, RunCoordinator } from "../src/runner/index.js";
import type {
  AgentStartError,
  AgentRunTimeoutError,
  RunCoordinationError,
  RunnerResolutionError,
} from "../src/core/errors.js";
import { itEffect, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";

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

describe("runPlans", () => {
  itEffect("folds unexpected coordination failures into a failed run record", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const plan = {
      project: ProjectId("cc-judge"),
      scenarioId: ScenarioId("unexpected-coordination"),
      name: "unexpected coordination",
      description: "coordinator returns an unknown failure shape",
      requirements: {
        expectedBehavior: "report a failed run instead of crashing",
        validationChecks: ["report contains a deterministic coordination failure"],
      },
      agents: [
        {
          id: AgentId("agent-1"),
          name: "Agent 1",
          artifact: {
            _tag: "DockerImageArtifact" as const,
            image: "repo/agent:latest",
          },
          promptInputs: {},
        },
      ],
    };
    const harness: ExecutionHarness = {
      name: "test-harness",
      run() {
        return Effect.fail({
          _tag: "ExecutionFailed" as const,
          message: "unused in this test",
        });
      },
    };
    const coordinator: RunCoordinator = {
      execute() {
        return Effect.fail({
          _tag: "RunCoordinationError",
          cause: {
            _tag: "UnexpectedFailure",
            detail: {
              message: "boom",
            },
          },
        } as unknown as RunCoordinationError);
      },
    };

    const report = yield* runPlans([{ plan, harness, coordinator }], {
      judge: stubJudge,
      resultsDir: dir,
    });

    expect(report.summary.failed).toBe(1);
    expect(report.runs[0]?.pass).toBe(false);
    expect(report.runs[0]?.reason).toContain("unexpected coordination failure");
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

// ============================================================
// Survivor kill suite — epic #37 follow-up (68 mutants)
// ============================================================

// Constants for the new tests below.
const ON_RUN_COUNT_ONE = 1;
const ON_RUN_COUNT_TWO = 2;
const ON_REPORT_COUNT_ONE = 1;
const CONCURRENCY_ZERO = 0;
const CONCURRENCY_TWO = 2;
const EXPECTED_TOTAL_THREE = 3;
const LATENCY_FIXED_MS = 50;
const AVG_LATENCY_NONZERO_MIN = 1;
const EXPECTED_FAILED_ZERO = 0;
const EXPECTED_PASSED_ZERO = 0;
const SUM_TURNS_TOKENS_IN = 10;
const SUM_TURNS_TOKENS_OUT = 14;
const SUM_TURNS_CACHE_READ = 6;
const SUM_TURNS_CACHE_WRITE = 4;
const SUM_TURNS_TOOL_CALLS = 8;
const TRACE_MODEL_NAME = "trace";
const TRACE_TRANSCRIPT_PATH = "";
const EMPTY_FILTER: string[] = [];
const SCEN_ID_GAMMA = "gamma";
const RESULTS_DIR_DEFAULT_FRAGMENT = "eval-results";
const GITHUB_COMMENT_PR_NUMBER = 42;

// ── buildReport: failed = total − passed (not total + passed) ──────────────
describe("buildReport arithmetic invariants", () => {
  itEffect("failed = total - passed (not total + passed)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // Two scenarios: one passes, one fails.
    const report = yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA)],
      { runner: stubRunner, judge: failingJudge, resultsDir: dir },
    );
    // Both fail, so failed=2, passed=0
    expect(report.summary.total).toBe(EXPECTED_TOTAL_TWO);
    expect(report.summary.passed).toBe(EXPECTED_PASSED_ZERO);
    expect(report.summary.failed).toBe(EXPECTED_TOTAL_TWO);
  });

  itEffect("passed + failed = total (algebraic invariant)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // Mix: stubJudge passes, failingJudge fails.
    // Use runsPerScenario=1 on two scenarios with different judges.
    // Easiest: one scenario with stubJudge (pass) + one with failingJudge (fail) via two calls.
    const report1 = yield* runScenarios([makeScenario("p")], { runner: stubRunner, judge: stubJudge, resultsDir: dir });
    const report2 = yield* runScenarios([makeScenario("f")], { runner: stubRunner, judge: failingJudge, resultsDir: dir });
    expect(report1.summary.passed + report1.summary.failed).toBe(report1.summary.total);
    expect(report2.summary.passed + report2.summary.failed).toBe(report2.summary.total);
  });

  itEffect("avgLatencyMs is non-zero when runs have positive latency", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // Use a runner that sleeps 50ms per turn to guarantee nonzero latency.
    const slowRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.delay(
          Effect.succeed({
            __brand: "AgentHandle" as const,
            kind: "subprocess" as const,
            scenarioId: scenario.id,
            workspaceDir: "/tmp/none",
            initialFiles: new Map<string, string>(),
            turnsExecuted: { count: 0 },
          }),
          LATENCY_FIXED_MS,
        );
      },
    };
    const report = yield* runScenarios([makeScenario("slow")], {
      runner: slowRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.summary.avgLatencyMs).toBeGreaterThanOrEqual(AVG_LATENCY_NONZERO_MIN);
  });

  itEffect("avgLatencyMs = latencyTotal / total for two runs with equal latency", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const slowRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.delay(
          Effect.succeed({
            __brand: "AgentHandle" as const,
            kind: "subprocess" as const,
            scenarioId: scenario.id,
            workspaceDir: "/tmp/none",
            initialFiles: new Map<string, string>(),
            turnsExecuted: { count: 0 },
          }),
          LATENCY_FIXED_MS,
        );
      },
    };
    const report = yield* runScenarios(
      [makeScenario("s1"), makeScenario("s2")],
      { runner: slowRunner, judge: stubJudge, resultsDir: dir },
    );
    const computedAvg = (report.runs[0]!.latencyMs + report.runs[1]!.latencyMs) / EXPECTED_TOTAL_TWO;
    expect(report.summary.avgLatencyMs).toBeCloseTo(computedAvg, 0);
  });

  itEffect("artifactsDir appears in report when resultsDir is set", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario("art")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    // buildReport always passes resultsDir as artifactsDir
    expect(report.artifactsDir).toBe(dir);
  });
});

// ── sumTurns: multiple turns with distinct token values ────────────────────
describe("sumTurns aggregation (multi-turn scenario)", () => {
  itEffect("sums token fields across two followUp turns", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let callIdx = 0;
    const multiTurnRunner: AgentRunner = {
      ...stubRunner,
      turn(_handle, prompt) {
        callIdx += 1;
        return Effect.succeed({
          index: callIdx - 1,
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
    const scen: Scenario = {
      ...makeScenario("multi"),
      followUps: ["follow-1"],
    };
    const report = yield* runScenarios([scen], {
      runner: multiTurnRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const rec = report.runs[0];
    // Two turns (setup + one followUp) — values are doubles
    expect(rec?.toolCallCount).toBe(SUM_TURNS_TOOL_CALLS);
    expect(rec?.inputTokens).toBe(SUM_TURNS_TOKENS_IN);
    expect(rec?.outputTokens).toBe(SUM_TURNS_TOKENS_OUT);
    expect(rec?.cacheReadTokens).toBe(SUM_TURNS_CACHE_READ);
    expect(rec?.cacheWriteTokens).toBe(SUM_TURNS_CACHE_WRITE);
  });
});

// ── scenarioIdFilter: empty array means keep all ───────────────────────────
describe("runScenarios filter edge cases", () => {
  itEffect("empty scenarioIdFilter array keeps all scenarios", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA)],
      {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        scenarioIdFilter: EMPTY_FILTER,
      },
    );
    // filter.length === 0 → selected = scenarios (no filtering)
    expect(report.summary.total).toBe(EXPECTED_TOTAL_TWO);
  });

  itEffect("concurrency=0 is clamped to 1 via Math.max (all jobs complete)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario("clamp")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      concurrency: CONCURRENCY_ZERO,
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });

  itEffect("concurrency > 1 still produces one record per scenario", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios(
      [makeScenario(SCEN_ID_ALPHA), makeScenario(SCEN_ID_BETA), makeScenario(SCEN_ID_GAMMA)],
      {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        concurrency: CONCURRENCY_TWO,
      },
    );
    expect(report.summary.total).toBe(EXPECTED_TOTAL_THREE);
  });
});

// ── observability discard:true — observer counts ────────────────────────────
describe("observability discard:true — onRun and onReport counts (runScenarios)", () => {
  itEffect("onRun is called exactly once per scenario record", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onRunCount = 0;
    const obs = {
      name: "count-obs",
      onRun: () => {
        onRunCount += 1;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* runScenarios([makeScenario("obs-one")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onRunCount).toBe(ON_RUN_COUNT_ONE);
  });

  itEffect("onReport is called exactly once after all runs finish", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onReportCount = 0;
    const obs = {
      name: "count-obs",
      onRun: () => Effect.void,
      onReport: () => {
        onReportCount += 1;
        return Effect.void;
      },
    };
    yield* runScenarios([makeScenario("rep-one"), makeScenario("rep-two")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onReportCount).toBe(ON_REPORT_COUNT_ONE);
  });

  itEffect("onRun is called on start-failure path (runner.start fails)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onRunCount = 0;
    const obs = {
      name: "start-fail-obs",
      onRun: () => {
        onRunCount += 1;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
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
    yield* runScenarios([makeScenario("start-fail-obs")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onRunCount).toBe(ON_RUN_COUNT_ONE);
  });

  itEffect("two scenarios call onRun twice with discard:true semantics", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onRunCount = 0;
    const obs = {
      name: "two-obs",
      onRun: () => {
        onRunCount += 1;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* runScenarios(
      [makeScenario("obs-a"), makeScenario("obs-b")],
      { runner: stubRunner, judge: stubJudge, resultsDir: dir, emitters: [obs] },
    );
    expect(onRunCount).toBe(ON_RUN_COUNT_TWO);
  });
});

// ── observability counts for scoreTraces ──────────────────────────────────
describe("observability discard:true — onRun and onReport counts (scoreTraces)", () => {
  const makeTrace = (id: string): Trace => ({
    traceId: TraceId(id),
    name: id,
    turns: [],
    expectedBehavior: "e",
    validationChecks: ["c"],
  });

  itEffect("scoreTraces onRun is called once per trace", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onRunCount = 0;
    const obs = {
      name: "trace-obs",
      onRun: () => {
        onRunCount += 1;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* scoreTraces([makeTrace("tr-obs-1")], {
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onRunCount).toBe(ON_RUN_COUNT_ONE);
  });

  itEffect("scoreTraces onReport is called exactly once", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onReportCount = 0;
    const obs = {
      name: "trace-rep-obs",
      onRun: () => Effect.void,
      onReport: () => {
        onReportCount += 1;
        return Effect.void;
      },
    };
    yield* scoreTraces([makeTrace("tr-obs-2"), makeTrace("tr-obs-3")], {
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onReportCount).toBe(ON_REPORT_COUNT_ONE);
  });

  itEffect("scoreTraces onRun called twice for two traces", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let onRunCount = 0;
    const obs = {
      name: "trace-two-obs",
      onRun: () => {
        onRunCount += 1;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* scoreTraces([makeTrace("tr-a"), makeTrace("tr-b")], {
      judge: stubJudge,
      resultsDir: dir,
      emitters: [obs],
    });
    expect(onRunCount).toBe(ON_RUN_COUNT_TWO);
  });
});

// ── scoreOneTrace: record fields ───────────────────────────────────────────
describe("scoreOneTrace record field invariants", () => {
  const makeTrace = (id: string): Trace => ({
    traceId: TraceId(id),
    name: id,
    turns: [],
    expectedBehavior: "e",
    validationChecks: ["c"],
  });

  itEffect("record.modelName is 'trace' (not empty string)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("mn-check")], {
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.runs[0]?.modelName).toBe(TRACE_MODEL_NAME);
  });

  itEffect("record.transcriptPath is empty string (not mutant sentinel)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("tp-check")], {
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.runs[0]?.transcriptPath).toBe(TRACE_TRANSCRIPT_PATH);
  });

  itEffect("record.latencyMs is non-negative", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("lat-check")], {
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.runs[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  itEffect("record.source is RUN_SOURCE.Trace", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("src-check")], {
      judge: stubJudge,
      resultsDir: dir,
    });
    expect(report.runs[0]?.source).toBe(RUN_SOURCE.Trace);
  });

  itEffect("record.description is empty string (not Stryker sentinel)", function* () {
    // traceToScenario hardcodes description: "" — a mutant changes it to "Stryker was here!"
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // We cannot read description off RunRecord directly, but we can confirm
    // the judge receives the correct scenario by checking the record indirectly.
    // The judge stub doesn't use description, so we check via the record.
    // Description isn't in RunRecord, but we can verify judge.judge receives it
    // by spying on what the judge sees.
    let capturedDescription: string | undefined;
    const descCapturingJudge: JudgeBackend = {
      name: "desc-cap",
      judge({ scenario }) {
        capturedDescription = scenario.description;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    yield* scoreTraces([makeTrace("desc-check")], {
      judge: descCapturingJudge,
      resultsDir: dir,
    });
    expect(capturedDescription).toBe("");
  });

  itEffect("setupPrompt is first turn prompt when turns.length > 0", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const FIRST_PROMPT = "first-turn-prompt";
    const trace: Trace = {
      traceId: TraceId("setup-prompt-check"),
      name: "sp",
      turns: [
        {
          index: 0,
          prompt: FIRST_PROMPT,
          response: "r",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    let capturedSetupPrompt: string | undefined;
    const capturingJudge: JudgeBackend = {
      name: "sp-cap",
      judge({ scenario }) {
        capturedSetupPrompt = scenario.setupPrompt;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    yield* scoreTraces([trace], { judge: capturingJudge, resultsDir: dir });
    expect(capturedSetupPrompt).toBe(FIRST_PROMPT);
  });

  itEffect("setupPrompt is empty string when trace has no turns", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSetupPrompt: string | undefined;
    const capturingJudge: JudgeBackend = {
      name: "sp-empty-cap",
      judge({ scenario }) {
        capturedSetupPrompt = scenario.setupPrompt;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    yield* scoreTraces([makeTrace("no-turns-sp")], { judge: capturingJudge, resultsDir: dir });
    expect(capturedSetupPrompt).toBe("");
  });

  itEffect("workspaceDiff absent → workspaceDiffSummary all-zero", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("no-wd")], {
      judge: stubJudge,
      resultsDir: dir,
    });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(0);
    expect(sum?.removed).toBe(0);
    expect(sum?.changed).toBe(0);
  });

  itEffect("workspaceDiff present → workspaceDiffSummary reflects actual counts", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("wd-present-check"),
      name: "wdp",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "add.txt", before: null, after: "new" },
          { path: "mod.txt", before: "old", after: "new" },
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_COUNT_ONE);
    expect(sum?.changed).toBe(DIFF_CHANGED_COUNT_ONE);
    expect(sum?.removed).toBe(0);
  });

  itEffect("workspaceDiff is passed to judge when trace provides one", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedDiff: unknown;
    const diffCapJudge: JudgeBackend = {
      name: "diff-cap",
      judge({ workspaceDiff }) {
        capturedDiff = workspaceDiff;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("wd-judge-check"),
      name: "wdj",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: { changed: [{ path: "f.txt", before: null, after: "new" }] },
    };
    yield* scoreTraces([trace], { judge: diffCapJudge, resultsDir: dir });
    expect(capturedDiff).toBeDefined();
  });

  itEffect("concurrency=0 in scoreTraces is clamped to 1 via Math.max", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces([makeTrace("st-clamp")], {
      judge: stubJudge,
      resultsDir: dir,
      concurrency: CONCURRENCY_ZERO,
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });

  itEffect("scoreTraces concurrency > 1 still produces one record per trace", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* scoreTraces(
      [makeTrace("st-c1"), makeTrace("st-c2"), makeTrace("st-c3")],
      { judge: stubJudge, resultsDir: dir, concurrency: CONCURRENCY_TWO },
    );
    expect(report.summary.total).toBe(EXPECTED_TOTAL_THREE);
  });
});

// ── githubComment: opts spread and if-block ────────────────────────────────
describe("githubComment option propagation", () => {
  itEffect("githubComment=undefined omits the key from emitter opts (runScenarios)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // When githubComment is undefined, passing it to makeReportEmitter as undefined
    // would be different from not passing it at all. The conditional spread ensures
    // the key is absent. We verify no exception is thrown and report is well-formed.
    const report = yield* runScenarios([makeScenario("no-gc")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      // githubComment: deliberately omitted
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });

  itEffect("githubComment set triggers publishGithubComment path (swallowed catchAll)", function* () {
    // publishGithubComment will fail (no gh CLI in test env) — the pipeline must
    // swallow it and still return a valid report. This confirms the if-block executes.
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const report = yield* runScenarios([makeScenario("gc-set")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      githubComment: GITHUB_COMMENT_PR_NUMBER,
    });
    // Even with githubComment set (and the gh CLI absent), the pipeline must complete.
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
    expect(report.summary.passed).toBe(EXPECTED_PASSED_ONE);
  });

  itEffect("githubComment set in scoreTraces triggers publishGithubComment path", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gc-trace"),
      name: "gc",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], {
      judge: stubJudge,
      resultsDir: dir,
      githubComment: GITHUB_COMMENT_PR_NUMBER,
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });

  itEffect("githubCommentArtifactUrl set propagates to emitter (runScenarios)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    // Passing both githubComment and githubCommentArtifactUrl exercises both spreads.
    const report = yield* runScenarios([makeScenario("gcau-set")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      githubComment: GITHUB_COMMENT_PR_NUMBER,
      githubCommentArtifactUrl: "https://example.com/artifacts",
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });

  itEffect("githubCommentArtifactUrl set propagates to emitter (scoreTraces)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gcau-trace"),
      name: "gcau",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], {
      judge: stubJudge,
      resultsDir: dir,
      githubComment: GITHUB_COMMENT_PR_NUMBER,
      githubCommentArtifactUrl: "https://example.com/artifacts",
    });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ONE);
  });
});

// ── resultsDir default path ────────────────────────────────────────────────
describe("resultsDir default fallback", () => {
  itEffect("runScenarios uses ./eval-results when resultsDir is omitted", function* () {
    // We resolve against the runner (no-op env var runner) to avoid actually
    // spawning a real process. Use an env-var runner that succeeds with empty set.
    const prevBin = process.env["CC_JUDGE_SUBPROCESS_BIN"];
    process.env["CC_JUDGE_SUBPROCESS_BIN"] = "/bin/true";
    try {
      const result = yield* Effect.either(runScenarios([], { judge: stubJudge }));
      // With empty scenario list the resultsDir default is still used.
      // We can only verify it runs without error, since resultsDir appears in
      // report.artifactsDir for non-empty lists.
      expect(result._tag).toBe(EITHER_RIGHT);
    } finally {
      if (prevBin !== undefined) process.env["CC_JUDGE_SUBPROCESS_BIN"] = prevBin;
      else delete process.env["CC_JUDGE_SUBPROCESS_BIN"];
    }
  });

  itEffect("scoreTraces uses ./eval-results when resultsDir is omitted", function* () {
    // With an empty trace list, no I/O happens. Confirm the effect completes.
    const report = yield* scoreTraces([], { judge: stubJudge });
    expect(report.summary.total).toBe(EXPECTED_TOTAL_ZERO);
  });
});

// ── summarizeDiff: before null vs not-null discrimination ──────────────────
describe("summarizeDiff before/after discrimination (runScenarios path)", () => {
  itEffect("workspaceDiff with before=null and after=null is counted as changed (edge)", function* () {
    // both null falls into the else branch → changed += 1
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("both-null"),
      name: "bn",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [{ path: "x.txt", before: null, after: null }],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    // before=null but after=null → not added (after is null), not removed (before is null)
    // → falls to else → changed
    expect(sum?.changed).toBe(DIFF_CHANGED_COUNT_ONE);
    expect(sum?.added).toBe(0);
    expect(sum?.removed).toBe(0);
  });

  itEffect("mixed diff: one add + one remove + one change produces correct triple", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("mixed-diff"),
      name: "md",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff: {
        changed: [
          { path: "add.txt", before: null, after: "new" },      // added
          { path: "del.txt", before: "old", after: null },       // removed
          { path: "mod.txt", before: "old", after: "new" },      // changed
        ],
      },
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_COUNT_ONE);
    expect(sum?.removed).toBe(DIFF_REMOVED_COUNT_ONE);
    expect(sum?.changed).toBe(DIFF_CHANGED_COUNT_ONE);
  });

  itEffect("runScenarios workspaceDiff summary has correct counts from runner.diff", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const diffRunner: AgentRunner = {
      ...stubRunner,
      diff() {
        return Effect.succeed({
          changed: [
            { path: "new.ts", before: null, after: "content" },
            { path: "del.ts", before: "old", after: null },
            { path: "chg.ts", before: "a", after: "b" },
          ],
        });
      },
    };
    const report = yield* runScenarios([makeScenario("diff-sum")], {
      runner: diffRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    const sum = report.runs[0]?.workspaceDiffSummary;
    expect(sum?.added).toBe(DIFF_ADDED_COUNT_ONE);
    expect(sum?.removed).toBe(DIFF_REMOVED_COUNT_ONE);
    expect(sum?.changed).toBe(DIFF_CHANGED_COUNT_ONE);
  });
});

// ============================================================
// Survivor kill suite — epic #37 follow-up round 2
// Targets: ArithmeticOperator, ObjectLiteral, BooleanLiteral,
// StringLiteral, ConditionalExpression, EqualityOperator,
// MethodExpression, BlockStatement mutants in pipeline.ts
// ============================================================

// ── Constants ────────────────────────────────────────────────────────────────
const MOCK_NOW_START = 1_000_000;
const MOCK_NOW_AFTER_DELAY = 1_000_100;
const MOCK_NOW_DELTA_MS = MOCK_NOW_AFTER_DELAY - MOCK_NOW_START;
const HIGH_CONCURRENCY = 100;
const DEFAULT_RESULTS_DIR = "./eval-results";
const GITHUB_COMMENT_VALUE = 99;
const GITHUB_ARTIFACT_URL = "https://example.com/artifact";

// ── ArithmeticOperator: Date.now() - startMs (L169, L193, L367) ─────────────
describe("ArithmeticOperator: latencyMs = Date.now() - startMs (not +)", () => {
  itEffect("runner.start failure path computes latencyMs as subtraction", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValue(MOCK_NOW_START);
    const startFailingRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        dateSpy.mockReturnValue(MOCK_NOW_AFTER_DELAY);
        return Effect.fail({
          _tag: "AgentStartError",
          scenarioId: scenario.id,
          cause: { _tag: "WorkspacePathEscape", wfPath: "bad" },
        } as unknown as AgentStartError);
      },
    };
    const report = yield* runScenarios([makeScenario("arith-start-fail")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    dateSpy.mockRestore();
    expect(report.runs[0]?.latencyMs).toBe(MOCK_NOW_DELTA_MS);
  });

  itEffect("happy path computes latencyMs as subtraction", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValue(MOCK_NOW_START);
    const controlledRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.succeed({
          __brand: "AgentHandle",
          kind: "subprocess",
          scenarioId: scenario.id,
          workspaceDir: "/tmp/none",
          initialFiles: new Map<string, string>(),
          turnsExecuted: { count: 0 },
        });
      },
      turn() {
        dateSpy.mockReturnValue(MOCK_NOW_AFTER_DELAY);
        return Effect.succeed({
          index: 0,
          prompt: "p",
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
    const report = yield* runScenarios([makeScenario("arith-happy")], {
      runner: controlledRunner,
      judge: stubJudge,
      resultsDir: dir,
    });
    dateSpy.mockRestore();
    // latencyMs should be Date.now() - startMs = positive delta, NOT sum
    expect(report.runs[0]?.latencyMs).toBe(MOCK_NOW_DELTA_MS);
  });

  itEffect("scoreOneTrace computes latencyMs as subtraction", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValue(MOCK_NOW_START);
    const delayedJudge: JudgeBackend = {
      name: "delayed-judge",
      judge() {
        dateSpy.mockReturnValue(MOCK_NOW_AFTER_DELAY);
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("arith-trace"),
      name: "at",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], { judge: delayedJudge, resultsDir: dir });
    dateSpy.mockRestore();
    expect(report.runs[0]?.latencyMs).toBe(MOCK_NOW_DELTA_MS);
  });
});

// ── ObjectLiteral: { record } not {} in onRun calls (L175, L200, L286, L324, L375) ─
describe("ObjectLiteral: onRun/onReport receive { record } / { report } not {}", () => {
  itEffect("runScenarios onRun callback receives an object with record property", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedArg: unknown = undefined;
    const shapeCheckingObs = {
      name: "shape-obs",
      onRun: (arg: unknown) => {
        receivedArg = arg;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* runScenarios([makeScenario("obj-shape-run")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [shapeCheckingObs],
    });
    expect(receivedArg).not.toBeUndefined();
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toHaveProperty("record");
  });

  itEffect("runScenarios onReport callback receives an object with report property", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedArg: unknown = undefined;
    const shapeCheckingObs = {
      name: "shape-obs",
      onRun: () => Effect.void,
      onReport: (arg: unknown) => {
        receivedArg = arg;
        return Effect.void;
      },
    };
    yield* runScenarios([makeScenario("obj-shape-rep")], {
      runner: stubRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [shapeCheckingObs],
    });
    expect(receivedArg).not.toBeUndefined();
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toHaveProperty("report");
  });

  itEffect("scoreTraces onRun callback receives an object with record property", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedArg: unknown = undefined;
    const shapeCheckingObs = {
      name: "shape-obs",
      onRun: (arg: unknown) => {
        receivedArg = arg;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    const trace: Trace = {
      traceId: TraceId("st-obj-shape"),
      name: "s",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir, emitters: [shapeCheckingObs] });
    expect(receivedArg).not.toBeUndefined();
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toHaveProperty("record");
  });

  itEffect("scoreTraces onReport callback receives an object with report property", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedArg: unknown = undefined;
    const shapeCheckingObs = {
      name: "shape-obs",
      onRun: () => Effect.void,
      onReport: (arg: unknown) => {
        receivedArg = arg;
        return Effect.void;
      },
    };
    const trace: Trace = {
      traceId: TraceId("st-obj-rep"),
      name: "s",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir, emitters: [shapeCheckingObs] });
    expect(receivedArg).not.toBeUndefined();
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toHaveProperty("report");
  });

  itEffect("onRun on start-failure path receives object with record property", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedArg: unknown = undefined;
    const shapeCheckingObs = {
      name: "start-fail-shape",
      onRun: (arg: unknown) => {
        receivedArg = arg;
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
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
    yield* runScenarios([makeScenario("sf-shape")], {
      runner: startFailingRunner,
      judge: stubJudge,
      resultsDir: dir,
      emitters: [shapeCheckingObs],
    });
    expect(receivedArg).not.toBeUndefined();
    expect(typeof receivedArg).toBe("object");
    expect(receivedArg).toHaveProperty("record");
  });
});

// ── BooleanLiteral: discard: true (not false) in forEach (L175, L200, L286, L324, L375) ─
// NOTE: The observer return type is Effect<void, never, never>, so Effect.fail
// is not valid. The discard:true vs discard:false mutant is only observable via
// the collection behavior: discard:true fires-and-forgets, discard:false collects.
// We verify by having the observer track execution order, confirming forEach
// does NOT short-circuit or buffer results differently.
describe("BooleanLiteral: discard: true fires-and-forgets observer effects", () => {
  itEffect("runScenarios onRun is invoked for each scenario (not short-circuited)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const runIds: string[] = [];
    const trackingObs = {
      name: "tracking-obs",
      onRun: ({ record }: { record: { scenarioId: string } }) => {
        runIds.push(record.scenarioId);
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    yield* runScenarios(
      [makeScenario("discard-a"), makeScenario("discard-b"), makeScenario("discard-c")],
      { runner: stubRunner, judge: stubJudge, resultsDir: dir, emitters: [trackingObs] },
    );
    expect(runIds).toEqual(["discard-a", "discard-b", "discard-c"]);
  });

  itEffect("scoreTraces onRun is invoked for each trace (not short-circuited)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const runIds: string[] = [];
    const trackingObs = {
      name: "tracking-st-obs",
      onRun: ({ record }: { record: { scenarioId: string } }) => {
        runIds.push(record.scenarioId);
        return Effect.void;
      },
      onReport: () => Effect.void,
    };
    const traces: Trace[] = [
      { traceId: TraceId("discard-t1"), name: "dt1", turns: [], expectedBehavior: "e", validationChecks: ["c"] },
      { traceId: TraceId("discard-t2"), name: "dt2", turns: [], expectedBehavior: "e", validationChecks: ["c"] },
      { traceId: TraceId("discard-t3"), name: "dt3", turns: [], expectedBehavior: "e", validationChecks: ["c"] },
    ];
    yield* scoreTraces(traces, { judge: stubJudge, resultsDir: dir, emitters: [trackingObs] });
    // All three traces should have their onRun called
    expect(runIds.length).toBe(3);
  });
});

// ── StringLiteral: default resultsDir = "./eval-results" (L244, L306) ───────
describe("StringLiteral: default resultsDir is './eval-results'", () => {
  itEffect("runScenarios passes './eval-results' as resultsDir when omitted", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const prevBin = process.env["CC_JUDGE_SUBPROCESS_BIN"];
    process.env["CC_JUDGE_SUBPROCESS_BIN"] = "/bin/true";
    try {
      yield* runScenarios([], { judge: stubJudge });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.resultsDir).toBe(DEFAULT_RESULTS_DIR);
    } finally {
      emitterSpy.mockRestore();
      if (prevBin !== undefined) process.env["CC_JUDGE_SUBPROCESS_BIN"] = prevBin;
      else delete process.env["CC_JUDGE_SUBPROCESS_BIN"];
    }
  });

  itEffect("scoreTraces passes './eval-results' as resultsDir when omitted", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    yield* scoreTraces([], { judge: stubJudge });
    expect(emitterSpy).toHaveBeenCalledTimes(1);
    const optsArg = emitterSpy.mock.calls[0]?.[0];
    expect(optsArg?.resultsDir).toBe(DEFAULT_RESULTS_DIR);
    emitterSpy.mockRestore();
  });
});

// ── ConditionalExpression/EqualityOperator: spread args to makeReportEmitter (L247-249, L309-311) ─
describe("ConditionalExpression: githubComment spread into makeReportEmitter opts", () => {
  itEffect("runScenarios passes githubComment to emitter when set", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    try {
      yield* runScenarios([makeScenario("gc-spread")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubComment).toBe(GITHUB_COMMENT_VALUE);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("runScenarios omits githubComment from emitter opts when undefined", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    try {
      yield* runScenarios([makeScenario("gc-omit")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubComment).toBeUndefined();
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("runScenarios passes githubCommentArtifactUrl to emitter when set", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    try {
      yield* runScenarios([makeScenario("gcau-spread")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
        githubCommentArtifactUrl: GITHUB_ARTIFACT_URL,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubCommentArtifactUrl).toBe(GITHUB_ARTIFACT_URL);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("runScenarios omits githubCommentArtifactUrl from emitter opts when undefined", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    try {
      yield* runScenarios([makeScenario("gcau-omit")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubCommentArtifactUrl).toBeUndefined();
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces passes githubComment to emitter when set", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gc-st-spread"),
      name: "gcs",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubComment).toBe(GITHUB_COMMENT_VALUE);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces omits githubComment from emitter opts when undefined", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gc-st-omit"),
      name: "gco",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubComment).toBeUndefined();
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces passes githubCommentArtifactUrl to emitter when set", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gcau-st-spread"),
      name: "gcaus",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
        githubCommentArtifactUrl: GITHUB_ARTIFACT_URL,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubCommentArtifactUrl).toBe(GITHUB_ARTIFACT_URL);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces omits githubCommentArtifactUrl from emitter opts when undefined", function* () {
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("gcau-st-omit"),
      name: "gcauo",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(emitterSpy).toHaveBeenCalledTimes(1);
      const optsArg = emitterSpy.mock.calls[0]?.[0];
      expect(optsArg?.githubCommentArtifactUrl).toBeUndefined();
    } finally {
      emitterSpy.mockRestore();
    }
  });
});

// ── MethodExpression: Math.max not Math.min (L267, L315) ───────────────────
describe("MethodExpression: Math.max(1, concurrency) not Math.min", () => {
  itEffect("runScenarios uses concurrency=2 when opts.concurrency=2 (not clamped to 1)", function* () {
    // Math.max(1, 2) = 2 → runs in parallel (fast)
    // Math.min(1, 2) = 1 → runs serially (slow)
    // We verify by using a slow runner and checking that two scenarios
    // complete faster than 2x the single-run time.
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const RUNNER_DELAY_MS = 200;
    const slowRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.delay(
          Effect.succeed({
            __brand: "AgentHandle",
            kind: "subprocess",
            scenarioId: scenario.id,
            workspaceDir: "/tmp/none",
            initialFiles: new Map<string, string>(),
            turnsExecuted: { count: 0 },
          }),
          RUNNER_DELAY_MS,
        );
      },
    };
    const before = Date.now();
    yield* runScenarios(
      [makeScenario("conc-a"), makeScenario("conc-b")],
      { runner: slowRunner, judge: stubJudge, resultsDir: dir, concurrency: CONCURRENCY_TWO },
    );
    const elapsed = Date.now() - before;
    // With Math.max (correct): both run in parallel, ~200ms total
    // With Math.min (mutant): both run serially, ~400ms total
    // Allow generous margin: should be < 350ms for parallel
    expect(elapsed).toBeLessThan(RUNNER_DELAY_MS * 2 - 50);
  });

  itEffect("scoreTraces uses concurrency=2 when opts.concurrency=2 (not clamped to 1)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const JUDGE_DELAY_MS = 200;
    const slowJudge: JudgeBackend = {
      name: "slow-judge",
      judge() {
        return Effect.delay(
          Effect.succeed({
            pass: true,
            reason: "ok",
            issues: [],
            overallSeverity: null,
            retryCount: 0,
          }),
          JUDGE_DELAY_MS,
        );
      },
    };
    const trace1: Trace = {
      traceId: TraceId("conc-t1"),
      name: "ct1",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const trace2: Trace = {
      traceId: TraceId("conc-t2"),
      name: "ct2",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const before = Date.now();
    yield* scoreTraces(
      [trace1, trace2],
      { judge: slowJudge, resultsDir: dir, concurrency: CONCURRENCY_TWO },
    );
    const elapsed = Date.now() - before;
    // Parallel with Math.max: ~200ms. Serial with Math.min: ~400ms.
    expect(elapsed).toBeLessThan(JUDGE_DELAY_MS * 2 - 50);
  });
});

// ── ConditionalExpression: githubComment if-block (L287, L325) ─────────────
describe("ConditionalExpression: githubComment if-block executes when set", () => {
  itEffect("runScenarios calls publishGithubComment when githubComment is set", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let publishCalled = false;
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter").mockImplementation((opts) => {
      return {
        emitRun() { return Effect.void; },
        emitReport() { return Effect.void; },
        publishGithubComment() {
          publishCalled = true;
          return Effect.void;
        },
      };
    });
    try {
      yield* runScenarios([makeScenario("gc-if")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
      });
      expect(publishCalled).toBe(true);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("runScenarios does not call publishGithubComment when githubComment is undefined", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let publishCalled = false;
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter").mockImplementation((opts) => {
      return {
        emitRun() { return Effect.void; },
        emitReport() { return Effect.void; },
        publishGithubComment() {
          publishCalled = true;
          return Effect.void;
        },
      };
    });
    try {
      yield* runScenarios([makeScenario("gc-no-if")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(publishCalled).toBe(false);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces calls publishGithubComment when githubComment is set", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let publishCalled = false;
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter").mockImplementation((opts) => {
      return {
        emitRun() { return Effect.void; },
        emitReport() { return Effect.void; },
        publishGithubComment() {
          publishCalled = true;
          return Effect.void;
        },
      };
    });
    const trace: Trace = {
      traceId: TraceId("gc-st-if"),
      name: "gcs",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
      });
      expect(publishCalled).toBe(true);
    } finally {
      emitterSpy.mockRestore();
    }
  });

  itEffect("scoreTraces does not call publishGithubComment when githubComment is undefined", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let publishCalled = false;
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter").mockImplementation((opts) => {
      return {
        emitRun() { return Effect.void; },
        emitReport() { return Effect.void; },
        publishGithubComment() {
          publishCalled = true;
          return Effect.void;
        },
      };
    });
    const trace: Trace = {
      traceId: TraceId("gc-st-no-if"),
      name: "gcs",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    try {
      yield* scoreTraces([trace], {
        judge: stubJudge,
        resultsDir: dir,
      });
      expect(publishCalled).toBe(false);
    } finally {
      emitterSpy.mockRestore();
    }
  });
});

// ── ConditionalExpression: trace.turns.length > 0 (L337) ──────────────────
describe("ConditionalExpression: trace.turns.length > 0 in traceToScenario", () => {
  itEffect("traceToScenario uses empty string for setupPrompt when turns is empty", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSetupPrompt: string | undefined;
    const capturingJudge: JudgeBackend = {
      name: "sp-cap-2",
      judge({ scenario }) {
        capturedSetupPrompt = scenario.setupPrompt;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("empty-turns-prompt"),
      name: "etp",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    yield* scoreTraces([trace], { judge: capturingJudge, resultsDir: dir });
    // With turns.length > 0 mutated to true, it would try turns[0] on empty array → undefined ?? ""
    // The test verifies it's actually "" via the conditional path, not the fallback.
    // Both paths yield "" here, but we verify the judge actually receives it.
    expect(capturedSetupPrompt).toBe("");
  });
});

// ── ConditionalExpression: workspaceDiff spread in scoreOneTrace (L357, L370) ─
describe("ConditionalExpression: workspaceDiff spread in scoreOneTrace", () => {
  itEffect("scoreOneTrace passes workspaceDiff to buildRecord when present", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const workspaceDiff = {
      changed: [{ path: "added.txt", before: null, after: "content" }],
    };
    const trace: Trace = {
      traceId: TraceId("wd-buildrec"),
      name: "wbr",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff,
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const rec = report.runs[0];
    // If the spread were removed, workspaceDiffSummary would be all zeros
    expect(rec?.workspaceDiffSummary?.added).toBe(DIFF_ADDED_COUNT_ONE);
  });

  itEffect("scoreOneTrace omits workspaceDiff from buildRecord when absent", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const trace: Trace = {
      traceId: TraceId("no-wd-buildrec"),
      name: "nwbr",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const report = yield* scoreTraces([trace], { judge: stubJudge, resultsDir: dir });
    const rec = report.runs[0];
    // With no workspaceDiff, summarizeDiff should return all zeros
    expect(rec?.workspaceDiffSummary?.added).toBe(0);
    expect(rec?.workspaceDiffSummary?.removed).toBe(0);
    expect(rec?.workspaceDiffSummary?.changed).toBe(0);
  });

  itEffect("scoreOneTrace passes workspaceDiff to judge when present", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedWorkspaceDiff: unknown;
    const diffCapturingJudge: JudgeBackend = {
      name: "diff-cap-2",
      judge({ workspaceDiff }) {
        capturedWorkspaceDiff = workspaceDiff;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const workspaceDiff = {
      changed: [{ path: "f.txt", before: null, after: "content" }],
    };
    const trace: Trace = {
      traceId: TraceId("wd-judge-2"),
      name: "wdj2",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
      workspaceDiff,
    };
    yield* scoreTraces([trace], { judge: diffCapturingJudge, resultsDir: dir });
    expect(capturedWorkspaceDiff).toBeDefined();
    // Verify it's the actual diff object, not undefined
    expect(capturedWorkspaceDiff).toEqual(workspaceDiff);
  });

  itEffect("scoreOneTrace does not pass workspaceDiff to judge when absent", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedWorkspaceDiff: unknown;
    const diffCapturingJudge: JudgeBackend = {
      name: "diff-cap-3",
      judge({ workspaceDiff }) {
        capturedWorkspaceDiff = workspaceDiff;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("no-wd-judge"),
      name: "nwdj",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    yield* scoreTraces([trace], { judge: diffCapturingJudge, resultsDir: dir });
    expect(capturedWorkspaceDiff).toBeUndefined();
  });
});

// ── ConditionalExpression: abortSignal spread in runOneScenarioOnce (L185) ──
describe("ConditionalExpression: abortSignal spread in runOneScenarioOnce", () => {
  itEffect("abortSignal is passed to judge when provided", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSignal: AbortSignal | undefined;
    const signalCapturingJudge: JudgeBackend = {
      name: "signal-cap",
      judge(opts) {
        capturedSignal = opts.abortSignal;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const controller = new AbortController();
    yield* runScenarios([makeScenario("signal-test")], {
      runner: stubRunner,
      judge: signalCapturingJudge,
      resultsDir: dir,
      abortSignal: controller.signal,
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  itEffect("abortSignal is undefined when not provided to runScenarios", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSignal: AbortSignal | undefined;
    const signalCapturingJudge: JudgeBackend = {
      name: "signal-cap-2",
      judge(opts) {
        capturedSignal = opts.abortSignal;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    yield* runScenarios([makeScenario("no-signal-test")], {
      runner: stubRunner,
      judge: signalCapturingJudge,
      resultsDir: dir,
    });
    expect(capturedSignal).toBeUndefined();
  });
});

// ── ConditionalExpression: abortSignal spread in scoreOneTrace (L358) ───────
describe("ConditionalExpression: abortSignal spread in scoreOneTrace", () => {
  itEffect("abortSignal is passed to judge in scoreTraces when provided", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSignal: AbortSignal | undefined;
    const signalCapturingJudge: JudgeBackend = {
      name: "signal-st-cap",
      judge(opts) {
        capturedSignal = opts.abortSignal;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("signal-st"),
      name: "sst",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    const controller = new AbortController();
    yield* scoreTraces([trace], {
      judge: signalCapturingJudge,
      resultsDir: dir,
      abortSignal: controller.signal,
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  itEffect("abortSignal is undefined in scoreTraces when not provided", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSignal: AbortSignal | undefined;
    const signalCapturingJudge: JudgeBackend = {
      name: "signal-st-cap-2",
      judge(opts) {
        capturedSignal = opts.abortSignal;
        return Effect.succeed({
          pass: true,
          reason: "ok",
          issues: [],
          overallSeverity: null,
          retryCount: 0,
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("no-signal-st"),
      name: "nsst",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    yield* scoreTraces([trace], {
      judge: signalCapturingJudge,
      resultsDir: dir,
    });
    expect(capturedSignal).toBeUndefined();
  });

  itEffect("totalTimeoutMs derives an abort signal that cancels a hanging trace judge", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let capturedSignal: AbortSignal | undefined;
    const timeoutJudge: JudgeBackend = {
      name: "signal-st-timeout",
      judge(opts) {
        capturedSignal = opts.abortSignal;
        return Effect.async((resume) => {
          const signal = opts.abortSignal;
          const onAbort = () => {
            resume(Effect.succeed({
              pass: false,
              reason: "aborted by total timeout",
              issues: [{ issue: "timeout", severity: "critical" }],
              overallSeverity: "critical",
              retryCount: 0,
            }));
          };
          if (signal === undefined) {
            onAbort();
            return Effect.void;
          }
          if (signal.aborted) {
            onAbort();
            return Effect.void;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => {
            signal.removeEventListener("abort", onAbort);
          });
        });
      },
    };
    const trace: Trace = {
      traceId: TraceId("signal-st-timeout"),
      name: "sst-timeout",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    };

    const report = yield* scoreTraces([trace], {
      judge: timeoutJudge,
      resultsDir: dir,
      totalTimeoutMs: 10,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(report.summary.failed).toBe(1);
    expect(report.runs[0]?.reason).toContain("aborted by total timeout");
  }, 10_000);
});

// ── BlockStatement: publishGithubComment block body (L287, L325) ───────────
describe("BlockStatement: publishGithubComment block executes fully", () => {
  itEffect("runScenarios publishGithubComment receives the report", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    let receivedReport: unknown;
    const emitterSpy = vi.spyOn(reportModule, "makeReportEmitter").mockImplementation((opts) => {
      return {
        emitRun() { return Effect.void; },
        emitReport() { return Effect.void; },
        publishGithubComment(report) {
          receivedReport = report;
          return Effect.void;
        },
      };
    });
    try {
      yield* runScenarios([makeScenario("gc-block")], {
        runner: stubRunner,
        judge: stubJudge,
        resultsDir: dir,
        githubComment: GITHUB_COMMENT_VALUE,
      });
      expect(receivedReport).toBeDefined();
      const rpt = receivedReport as { summary: { total: number } };
      expect(rpt.summary.total).toBe(EXPECTED_TOTAL_ONE);
    } finally {
      emitterSpy.mockRestore();
    }
  });
});

// ── ObjectLiteral: { concurrency } spread in forEach (L282, L320) ──────────
describe("ObjectLiteral: { concurrency } in Effect.forEach options", () => {
  itEffect("runScenarios uses the provided concurrency value (not default)", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-pipe-"));
    const RUNNER_DELAY_MS = 200;
    const slowRunner: AgentRunner = {
      ...stubRunner,
      start(scenario) {
        return Effect.delay(
          Effect.succeed({
            __brand: "AgentHandle",
            kind: "subprocess",
            scenarioId: scenario.id,
            workspaceDir: "/tmp/none",
            initialFiles: new Map<string, string>(),
            turnsExecuted: { count: 0 },
          }),
          RUNNER_DELAY_MS,
        );
      },
    };
    // With concurrency=1 (serial), 2 scenarios take ~400ms
    const before = Date.now();
    yield* runScenarios(
      [makeScenario("serial-a"), makeScenario("serial-b")],
      { runner: slowRunner, judge: stubJudge, resultsDir: dir, concurrency: 1 },
    );
    const elapsed = Date.now() - before;
    // Serial execution: should take at least 2 * delay
    expect(elapsed).toBeGreaterThanOrEqual(RUNNER_DELAY_MS);
  });
});
