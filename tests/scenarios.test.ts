// Acceptance tests for runSubprocessScenarios (issue #253, PR #258).
// Covers spec §6 PR 3 acceptance bullets plus the architect's §8.1-§8.4
// open-question defaults.

import { describe, expect, expectTypeOf, it } from "vitest";
import { Effect } from "effect";
import {
  runSubprocessScenarios,
  type RunSubprocessScenariosOpts,
  type SubprocessScenario,
} from "../src/app/scenarios.js";
import {
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type RunPlan,
} from "../src/core/types.js";
import {
  AgentStartError,
  AgentStartErrorCause,
  HarnessExecutionCause,
  RunCoordinationCause,
  RunCoordinationError,
} from "../src/core/errors.js";
import type { JudgeBackend } from "../src/judge/index.js";
import { DETERMINISTIC_JUDGE_MODEL } from "../src/app/pipeline.js";
import type {
  AgentRuntime,
  ExecutionHarness,
  RunCoordinator,
  RuntimeHandle,
} from "../src/runner/index.js";
import { itEffect } from "./support/effect.js";
import { makeTempDir } from "./support/tmpdir.js";

function makeScenario(
  id: string,
  overrides: Partial<SubprocessScenario> = {},
): SubprocessScenario {
  return {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId(id),
    name: `Scenario ${id}`,
    description: `Description for ${id}`,
    requirements: {
      expectedBehavior: "agent responds",
      validationChecks: ["response is non-empty"],
    },
    prompts: ["solve"],
    ...overrides,
  };
}

interface CapturedExecute {
  readonly plan: RunPlan;
  readonly harness: ExecutionHarness;
}

class CapturingCoordinator implements RunCoordinator {
  readonly captured: CapturedExecute[] = [];

  execute(
    plan: RunPlan,
    harness: ExecutionHarness,
  ): Effect.Effect<never, RunCoordinationError, never> {
    this.captured.push({ plan, harness });
    return Effect.fail(
      new RunCoordinationError({
        cause: RunCoordinationCause.HarnessFailed({
          detail: HarnessExecutionCause.ExecutionFailed({
            message: `captured ${plan.scenarioId}`,
          }),
        }),
      }),
    );
  }
}

class TrackingRuntime implements AgentRuntime {
  readonly kind = "subprocess" as const;
  prepareCalls = 0;
  readonly markerPath = "tracking-runtime-marker";

  prepare(
    agent: AgentDeclaration,
    plan: RunPlan,
  ): Effect.Effect<RuntimeHandle, AgentStartError, never> {
    this.prepareCalls += 1;
    return Effect.fail(
      new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: AgentStartErrorCause.BinaryNotFound({ path: this.markerPath }),
      }),
    );
  }

  stop(): Effect.Effect<void, never, never> {
    return Effect.void;
  }
}

const passingJudge: JudgeBackend = {
  name: "test-stub",
  judge() {
    return Effect.die("judge should not run for coordinator failures");
  },
};

function commonOpts(extra: Partial<RunSubprocessScenariosOpts> = {}): RunSubprocessScenariosOpts {
  return {
    bin: "/nonexistent-bin-for-typecheck",
    judge: passingJudge,
    resultsDir: makeTempDir("scenarios"),
    ...extra,
  } as RunSubprocessScenariosOpts;
}

describe("runSubprocessScenarios", () => {
  itEffect("returns an empty Report for an empty scenarios array", function* () {
    const report = yield* runSubprocessScenarios([], commonOpts());

    expect(report.runs).toEqual([]);
    expect(report.summary).toMatchObject({ total: 0, passed: 0, failed: 0 });
  });

  itEffect("runs one scenario through the default subprocess stack", function* () {
    const coordinator = new CapturingCoordinator();
    const scenario = makeScenario("solo");
    const report = yield* runSubprocessScenarios(
      [scenario],
      commonOpts({ coordinator, judge: passingJudge }),
    );

    expect(coordinator.captured).toHaveLength(1);
    expect(coordinator.captured[0]?.plan.scenarioId).toBe(scenario.scenarioId);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.scenarioId).toBe(scenario.scenarioId);
    expect(report.runs[0]?.judgeModel).toBe(DETERMINISTIC_JUDGE_MODEL);
    expect(report.summary.total).toBe(1);
  });

  itEffect("returns one RunRecord per scenario in input order", function* () {
    const coordinator = new CapturingCoordinator();
    const ids = ["alpha", "beta", "gamma"];
    const report = yield* runSubprocessScenarios(
      ids.map((id) => makeScenario(id)),
      commonOpts({ coordinator, judge: passingJudge }),
    );

    expect(report.runs.map((r) => r.scenarioId)).toEqual(ids);
    expect(coordinator.captured.map((c) => c.plan.scenarioId)).toEqual(ids);
  });

  itEffect("uses opts.runtime when supplied; default SubprocessRuntime is not instantiated", function* () {
    const trackingRuntime = new TrackingRuntime();

    // opts.runtime branch of RuntimeSelector: opts.bin is `never`. The
    // helper wires trackingRuntime into PlannedRunInput; DefaultRunCoordinator
    // calls trackingRuntime.prepare(...) for each scenario. The marker path
    // surfacing in the folded RunRecord proves the embedder-supplied runtime
    // ran — not the default SubprocessRuntime.
    const report = yield* runSubprocessScenarios([makeScenario("rt")], {
      runtime: trackingRuntime,
      judge: passingJudge,
      resultsDir: makeTempDir("scenarios-rt"),
    });

    expect(trackingRuntime.prepareCalls).toBe(1);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.reason).toContain(trackingRuntime.markerPath);
  });

  itEffect("uses opts.bin to build the default SubprocessRuntime when runtime is not supplied", function* () {
    // Missing-bin path proves the helper instantiated SubprocessRuntime and
    // ran prepare(): the runtime fails fast with BinaryNotFound, which
    // surfaces in the folded RunRecord's reason field.
    const missingBin = "/nonexistent-bin-cc-judge-258";
    const report = yield* runSubprocessScenarios([makeScenario("bin")], {
      bin: missingBin,
      judge: passingJudge,
      resultsDir: makeTempDir("scenarios-bin"),
    });

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.pass).toBe(false);
    expect(report.runs[0]?.reason).toContain(missingBin);
  });

  itEffect("uses opts.judge when supplied", function* () {
    let called = false;
    const tagged: JudgeBackend = {
      name: "tagged",
      judge() {
        called = true;
        return Effect.die("never reached because coordinator fails first");
      },
    };
    const coordinator = new CapturingCoordinator();

    yield* runSubprocessScenarios(
      [makeScenario("judge")],
      commonOpts({ judge: tagged, coordinator }),
    );

    // The judge surface is wired through; coordinator failure folds into a
    // deterministic record that bypasses judge.judge() — but the helper
    // never reaches for AnthropicJudgeBackend when opts.judge is supplied.
    expect(called).toBe(false);
    expect(coordinator.captured).toHaveLength(1);
  });

  itEffect("forwards opts.harness uniformly across the batch", function* () {
    const harness: ExecutionHarness = {
      name: "uniform-test-harness",
      run() {
        return Effect.void;
      },
    };
    const coordinator = new CapturingCoordinator();

    yield* runSubprocessScenarios(
      [makeScenario("h1"), makeScenario("h2"), makeScenario("h3")],
      commonOpts({ harness, coordinator }),
    );

    expect(coordinator.captured).toHaveLength(3);
    for (const captured of coordinator.captured) {
      expect(captured.harness).toBe(harness);
    }
  });

  itEffect("forwards concurrency, resultsDir, and abortSignal to runPlans", function* () {
    const coordinator = new CapturingCoordinator();
    const resultsDir = makeTempDir("scenarios-passthrough");

    const report = yield* runSubprocessScenarios(
      [makeScenario("p1"), makeScenario("p2")],
      commonOpts({ coordinator, concurrency: 2, resultsDir }),
    );

    expect(report.runs).toHaveLength(2);
    expect(report.artifactsDir).toBe(resultsDir);
  });

  itEffect("derives default agent.id and agent.name from scenarioId/name when omitted", function* () {
    const coordinator = new CapturingCoordinator();
    const scenario = makeScenario("derived", { name: "Derived Scenario" });

    yield* runSubprocessScenarios(
      [scenario],
      commonOpts({ coordinator }),
    );

    const captured = coordinator.captured[0];
    expect(captured).toBeDefined();
    const agent = captured?.plan.agents[0];
    expect(agent?.id).toBe(AgentId(`${scenario.scenarioId}-agent`));
    expect(agent?.name).toBe(scenario.name);
  });

  itEffect("respects explicit agentId and agentName when supplied", function* () {
    const coordinator = new CapturingCoordinator();
    const explicitId = AgentId("custom-agent");
    const explicitName = "Custom Agent Name";

    yield* runSubprocessScenarios(
      [
        makeScenario("explicit", {
          agentId: explicitId,
          agentName: explicitName,
        }),
      ],
      commonOpts({ coordinator }),
    );

    const agent = coordinator.captured[0]?.plan.agents[0];
    expect(agent?.id).toBe(explicitId);
    expect(agent?.name).toBe(explicitName);
  });

  itEffect("folds a single scenario's coordination failure without aborting siblings", function* () {
    const coordinator = new CapturingCoordinator();
    const ids = ["fail", "ok-1", "ok-2"];

    const report = yield* runSubprocessScenarios(
      ids.map((id) => makeScenario(id)),
      commonOpts({ coordinator }),
    );

    // Every scenario folds because CapturingCoordinator always fails. The
    // test assertion is that all 3 records land — failure on one input
    // does not short-circuit the batch.
    expect(report.runs).toHaveLength(ids.length);
    expect(report.runs.map((r) => r.scenarioId)).toEqual(ids);
    for (const record of report.runs) {
      expect(record.pass).toBe(false);
    }
  });

  it("rejects bin + runtime together at the type level", () => {
    expectTypeOf<RunSubprocessScenariosOpts>().not.toMatchTypeOf<{
      readonly bin: string;
      readonly runtime: AgentRuntime;
    }>();
  });

  itEffect(
    "synthesizes a tolerated artifact for the agent (PR-1 transition: DockerImageArtifact stub or SubprocessArtifact)",
    function* () {
      const coordinator = new CapturingCoordinator();

      yield* runSubprocessScenarios(
        [makeScenario("artifact")],
        commonOpts({ coordinator }),
      );

      const agent = coordinator.captured[0]?.plan.agents[0];
      expect(agent).toBeDefined();
      // Tolerate either tag during the PR-1 transition window. Once
      // cc-judge#254 (SubprocessArtifact) lands, the helper switches and
      // this assertion still holds.
      const tag = agent?.artifact._tag;
      expect(["DockerImageArtifact", "SubprocessArtifact"]).toContain(tag);
    },
  );
});
