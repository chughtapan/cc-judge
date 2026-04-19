import { describe, expect } from "vitest";
import { Effect } from "effect";
import { DefaultRunCoordinator, PromptWorkspaceHarness, type AgentRuntime, type RuntimeHandle } from "../src/runner/index.js";
import {
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type RunPlan,
  type Turn,
  type WorkspaceDiff,
} from "../src/core/types.js";
import { itEffect } from "./support/effect.js";

function makePlan(): RunPlan {
  const agents: readonly [AgentDeclaration, AgentDeclaration] = [
    {
      id: AgentId("agent-1"),
      name: "Agent One",
      artifact: { _tag: "DockerImageArtifact", image: "repo/agent-one:latest" },
      promptInputs: {},
    },
    {
      id: AgentId("agent-2"),
      name: "Agent Two",
      artifact: { _tag: "DockerImageArtifact", image: "repo/agent-two:latest" },
      promptInputs: {},
    },
  ];
  return {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId("multi-agent"),
    name: "multi-agent",
    description: "multi-agent prompt harness",
    agents,
    requirements: {
      expectedBehavior: "both agents respond",
      validationChecks: ["each agent emits one response"],
    },
  };
}

class FakeRuntime implements AgentRuntime {
  readonly kind = "docker" as const;
  readonly stopped: string[] = [];

  prepare(agent: AgentDeclaration): Effect.Effect<RuntimeHandle, never, never> {
    const diff: WorkspaceDiff = {
      changed: [{ path: `${agent.id}.txt`, before: null, after: agent.name }],
    };
    return Effect.succeed({
      agent,
      kind: "docker",
      workspaceDir: `/tmp/${agent.id}`,
      writeWorkspace() {
        return Effect.void;
      },
      executePrompt(prompt: string): Effect.Effect<Turn, never, never> {
        const startedAt = agent.id === "agent-1"
          ? "2026-04-19T00:00:02.000Z"
          : "2026-04-19T00:00:01.000Z";
        return Effect.succeed({
          index: 0,
          prompt,
          response: `${agent.name} handled ${prompt}`,
          startedAt,
          latencyMs: 10,
          toolCallCount: 0,
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      },
      diffWorkspace() {
        return Effect.succeed(diff);
      },
    });
  }

  stop(handle: RuntimeHandle): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.stopped.push(handle.agent.id);
    });
  }
}

describe("DefaultRunCoordinator + PromptWorkspaceHarness", () => {
  itEffect("coordinates a multi-agent run and emits a normalized bundle", function* () {
    const runtime = new FakeRuntime();
    const coordinator = new DefaultRunCoordinator(runtime);
    const harness = new PromptWorkspaceHarness({
      prompts: ["solve"],
      workspace: [{ path: "README.md", content: "seed" }],
    });

    const bundle = yield* coordinator.execute(makePlan(), harness);

    expect(bundle.agents).toHaveLength(2);
    expect(bundle.outcomes).toHaveLength(2);
    expect(bundle.turns).toHaveLength(2);
    expect(bundle.events).toHaveLength(4);
    const expectedEventTimestamps = [
      Date.parse("2026-04-19T00:00:01.000Z"),
      Date.parse("2026-04-19T00:00:01.000Z") + 10,
      Date.parse("2026-04-19T00:00:02.000Z"),
      Date.parse("2026-04-19T00:00:02.000Z") + 10,
    ];
    expect(bundle.events?.map((event) => event.ts)).toEqual([
      ...expectedEventTimestamps,
    ]);
    expect(bundle.context).toMatchObject({
      workspaceDiffByAgent: {
        "agent-1": { changed: [{ path: "agent-1.txt", before: null, after: "Agent One" }] },
        "agent-2": { changed: [{ path: "agent-2.txt", before: null, after: "Agent Two" }] },
      },
    });
    expect(runtime.stopped.sort()).toEqual(["agent-1", "agent-2"]);
  });
});
