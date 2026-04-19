import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect } from "vitest";
import { Effect } from "effect";
import { scoreBundles } from "../src/app/pipeline.js";
import type { JudgeBackend } from "../src/judge/index.js";
import type { JudgeResult } from "../src/core/schema.js";
import { AgentId, ProjectId, RunId, ScenarioId, type JudgmentBundle } from "../src/core/types.js";
import { itEffect } from "./support/effect.js";

const stubJudge: JudgeBackend = {
  name: "bundle-judge",
  judge() {
    const result: JudgeResult = {
      pass: true,
      reason: "bundle pass",
      issues: [],
      overallSeverity: null,
      retryCount: 0,
    };
    return Effect.succeed(result);
  },
};

function makeBundle(): JudgmentBundle {
  return {
    runId: RunId("bundle-run-1"),
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId("bundle-scenario"),
    name: "bundle",
    description: "normalized bundle",
    requirements: {
      expectedBehavior: "judge the bundle",
      validationChecks: ["bundle reaches the judge"],
    },
    agents: [{ id: "agent-1", name: "Agent One" }],
    events: [
      {
        type: "message",
        from: "Agent One",
        channel: "response",
        text: "done",
        ts: 1_744_998_100_000,
      },
    ],
    outcomes: [
      {
        agentId: AgentId("agent-1"),
        status: "completed",
        endedAt: "2026-04-19T00:01:40.000Z",
      },
    ],
    metadata: {
      modelName: "bundle-model",
    },
  };
}

describe("scoreBundles", () => {
  itEffect("scores normalized bundles without a runner", function* () {
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-bundle-"));
    const report = yield* scoreBundles([makeBundle()], {
      judge: stubJudge,
      resultsDir,
    });

    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.runs[0]?.source).toBe("bundle");
    expect(report.runs[0]?.modelName).toBe("bundle-model");
  });
});
