import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, vi } from "vitest";

const { randomUUIDMock } = vi.hoisted(() => ({
  randomUUIDMock: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));
import { Effect } from "effect";
import { runWithHarness } from "../src/app/pipeline.js";
import {
  AgentStartErrorCause,
  HarnessExecutionCause,
  RunCoordinationCause,
  RunCoordinationError,
} from "../src/core/errors.js";
import type { JudgeBackend } from "../src/judge/index.js";
import {
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type RunPlan,
} from "../src/core/types.js";
import { itEffect } from "./support/effect.js";

function makePlan(): RunPlan {
  const agents: readonly [AgentDeclaration, AgentDeclaration] = [
    {
      id: AgentId("alpha"),
      name: "Alpha",
      artifact: { _tag: "DockerImageArtifact", image: "repo/alpha:latest" },
      promptInputs: {},
    },
    {
      id: AgentId("beta"),
      name: "Beta",
      artifact: { _tag: "DockerImageArtifact", image: "repo/beta:latest" },
      promptInputs: {},
    },
  ];
  return {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId("planned-failure"),
    name: "planned-failure",
    description: "planned failure path",
    agents,
    requirements: {
      expectedBehavior: "fold failures deterministically",
      validationChecks: ["no judge call on coordinator failure"],
    },
  };
}

const unusedHarness = {
  name: "unused",
  run() {
    return Effect.void;
  },
};

describe("runWithHarness failure folding", () => {
  itEffect("folds agent-start failure deterministically without invoking the judge", function* () {
    let judgeCalled = false;
    const judge: JudgeBackend = {
      name: "should-not-run",
      judge() {
        judgeCalled = true;
        return Effect.die("judge should not run for coordinator failures");
      },
    };
    const coordinator = {
      execute() {
        return Effect.fail(
          new RunCoordinationError({
            cause: RunCoordinationCause.AgentStartFailed({
              agentId: "alpha",
              detail: AgentStartErrorCause.BuildContextMissing({
                path: "/tmp/missing-context",
              }),
            }),
          }),
        );
      },
    };

    const report = yield* runWithHarness(makePlan(), unusedHarness, {
      coordinator,
      judge,
      resultsDir: mkdtempSync(path.join(os.tmpdir(), "cc-judge-fold-start-")),
    });

    expect(judgeCalled).toBe(false);
    expect(report.summary.failed).toBe(1);
    expect(report.runs[0]?.judgeModel).toBe("deterministic/coordinator");
    expect(report.runs[0]?.reason).toContain("alpha failed_to_start");
    expect(report.runs[0]?.reason).toContain("beta cancelled");
  });

  itEffect("preserves cancelled status when the run is aborted", function* () {
    const abortController = new AbortController();
    abortController.abort();
    const judge: JudgeBackend = {
      name: "should-not-run",
      judge() {
        return Effect.die("judge should not run for cancelled coordinator failures");
      },
    };
    const coordinator = {
      execute() {
        return Effect.fail(
          new RunCoordinationError({
            cause: RunCoordinationCause.HarnessFailed({
              detail: HarnessExecutionCause.ExecutionFailed({
                message: "aborted",
              }),
            }),
          }),
        );
      },
    };

    const report = yield* runWithHarness(makePlan(), unusedHarness, {
      coordinator,
      judge,
      abortSignal: abortController.signal,
      resultsDir: mkdtempSync(path.join(os.tmpdir(), "cc-judge-fold-cancel-")),
    });

    expect(report.summary.failed).toBe(1);
    expect(report.runs[0]?.reason).toContain("alpha cancelled");
    expect(report.runs[0]?.reason).toContain("beta cancelled");
    expect(report.runs[0]?.reason).not.toContain("runtime_error");
  });

  itEffect("uses a unique runId for each deterministic failure bundle", function* () {
    const judge: JudgeBackend = {
      name: "should-not-run",
      judge() {
        return Effect.die("judge should not run for coordinator failures");
      },
    };
    const coordinator = {
      execute() {
        return Effect.fail(
          new RunCoordinationError({
            cause: RunCoordinationCause.HarnessFailed({
              detail: HarnessExecutionCause.ExecutionFailed({
                message: "aborted",
              }),
            }),
          }),
        );
      },
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_726_000_000_000);
    randomUUIDMock.mockReturnValueOnce("run-one").mockReturnValueOnce("run-two");
    try {
      yield* runWithHarness(makePlan(), unusedHarness, {
        coordinator,
        judge,
        resultsDir: mkdtempSync(path.join(os.tmpdir(), "cc-judge-fold-runid-1-")),
      });
      yield* runWithHarness(makePlan(), unusedHarness, {
        coordinator,
        judge,
        resultsDir: mkdtempSync(path.join(os.tmpdir(), "cc-judge-fold-runid-2-")),
      });
      expect(randomUUIDMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      nowSpy.mockRestore();
      randomUUIDMock.mockReset();
    }
  });
});
