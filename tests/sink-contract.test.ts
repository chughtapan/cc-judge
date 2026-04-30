// Tests for the makeNormalizedBundleSink contract — the buffer the
// harness writes through to record turns/events/phases/outcomes that
// later become a JudgmentBundle. These cover the defenses against a
// misbehaving harness (UnknownAgent, DuplicateOutcome, MissingOutcomes)
// that the happy-path coordinator tests don't exercise.

import { describe, expect } from "vitest";
import { Effect } from "effect";
import { makeNormalizedBundleSink } from "../src/runner/index.js";
import {
  AGENT_LIFECYCLE_STATUS,
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type AgentOutcome,
  type AgentTurn,
  type RunPlan,
} from "../src/core/types.js";
import { itEffect, expectLeft, expectCauseTag } from "./support/effect.js";

const AGENT_A = AgentId("agent-a");
const AGENT_B = AgentId("agent-b");
const PHANTOM = AgentId("phantom-not-in-plan");

function makeAgent(id: AgentId, name: string): AgentDeclaration {
  return {
    id,
    name,
    artifact: { _tag: "DockerImageArtifact", image: "img:t" },
    promptInputs: {},
  };
}

function makePlan(agentIds: ReadonlyArray<AgentId> = [AGENT_A]): RunPlan {
  const agents = agentIds.map((id) => makeAgent(id, id));
  if (agents.length === 0) {
    throw new Error("plan requires at least one agent");
  }
  return {
    project: ProjectId("p"),
    scenarioId: ScenarioId("s"),
    name: "n",
    description: "d",
    agents: agents as readonly [AgentDeclaration, ...AgentDeclaration[]],
    requirements: { expectedBehavior: "x", validationChecks: [] },
  };
}

function makeOutcome(agentId: AgentId): AgentOutcome {
  return {
    agentId,
    status: AGENT_LIFECYCLE_STATUS.Completed,
    endedAt: "2026-04-29T00:00:00.000Z",
  };
}

function makeAgentTurn(agentId: AgentId | undefined): AgentTurn {
  const turn = {
    index: 0,
    prompt: "p",
    response: "r",
    startedAt: "2026-04-29T00:00:00.000Z",
    latencyMs: 1,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return agentId !== undefined ? { turn, agentId } : { turn };
}

describe("makeNormalizedBundleSink: harness contract", () => {
  // ── recordTurn ────────────────────────────────────────────────────────────

  itEffect("recordTurn rejects an unknown agentId with UnknownAgent", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-1");
    const result = yield* Effect.either(sink.recordTurn(makeAgentTurn(PHANTOM)));
    const cause = expectCauseTag(expectLeft(result).cause, "UnknownAgent");
    expect(cause.agentId).toBe(PHANTOM);
  });

  itEffect("recordTurn accepts a known agentId", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-1");
    yield* sink.recordTurn(makeAgentTurn(AGENT_A));
  });

  itEffect("recordTurn accepts a turn with no agentId at all (orphan turn)", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-1");
    yield* sink.recordTurn(makeAgentTurn(undefined));
  });

  // ── recordOutcome ─────────────────────────────────────────────────────────

  itEffect("recordOutcome rejects an unknown agentId with UnknownAgent", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-1");
    const result = yield* Effect.either(sink.recordOutcome(makeOutcome(PHANTOM)));
    const cause = expectCauseTag(expectLeft(result).cause, "UnknownAgent");
    expect(cause.agentId).toBe(PHANTOM);
  });

  itEffect("recordOutcome rejects a second outcome for the same agent", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-1");
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const result = yield* Effect.either(sink.recordOutcome(makeOutcome(AGENT_A)));
    const cause = expectCauseTag(expectLeft(result).cause, "DuplicateOutcome");
    expect(cause.agentId).toBe(AGENT_A);
  });

  // ── finalize ─────────────────────────────────────────────────────────────

  itEffect("finalize rejects when one or more agents have no outcome", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A, AGENT_B]), "run-1");
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const result = yield* Effect.either(sink.finalize());
    const cause = expectCauseTag(expectLeft(result).cause, "MissingOutcomes");
    expect(cause.agentIds).toEqual([AGENT_B]);
  });

  itEffect(
    "finalize lists every missing agent (multiple), preserving plan order",
    function* () {
      const sink = makeNormalizedBundleSink(makePlan([AGENT_A, AGENT_B]), "run-1");
      const result = yield* Effect.either(sink.finalize());
      const cause = expectCauseTag(expectLeft(result).cause, "MissingOutcomes");
      expect(cause.agentIds).toEqual([AGENT_A, AGENT_B]);
    },
  );

  itEffect("finalize succeeds when every agent has exactly one outcome", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A, AGENT_B]), "run-1");
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    yield* sink.recordOutcome(makeOutcome(AGENT_B));
    const bundle = yield* sink.finalize();
    expect(bundle.runId).toBe("run-1");
    expect(bundle.outcomes).toHaveLength(2);
    expect(bundle.agents.map((a) => a.id)).toEqual([AGENT_A, AGENT_B]);
  });

  itEffect("finalize omits empty optional fields (turns/events/phases/context)", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-bare");
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const bundle = yield* sink.finalize();
    expect(bundle.turns).toBeUndefined();
    expect(bundle.events).toBeUndefined();
    expect(bundle.phases).toBeUndefined();
    expect(bundle.workspaceDiff).toBeUndefined();
  });

  itEffect("finalize includes turns when at least one was recorded", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-with-turn");
    yield* sink.recordTurn(makeAgentTurn(AGENT_A));
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const bundle = yield* sink.finalize();
    expect(bundle.turns).toHaveLength(1);
  });

  itEffect("finalize includes phases when at least one was recorded", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-with-phase");
    yield* sink.recordPhase({ id: "p1", name: "kickoff", tsStart: 0 });
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const bundle = yield* sink.finalize();
    expect(bundle.phases).toEqual([{ id: "p1", name: "kickoff", tsStart: 0 }]);
  });

  itEffect("finalize includes events when at least one was recorded", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-with-event");
    yield* sink.recordEvent({
      type: "message",
      from: "user",
      channel: "chat",
      text: "hi",
      ts: 1,
    });
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const bundle = yield* sink.finalize();
    expect(bundle.events).toHaveLength(1);
  });

  itEffect("finalize includes workspaceDiff when set", function* () {
    const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-with-diff");
    yield* sink.setWorkspaceDiff({
      changed: [{ path: "x.txt", before: null, after: "v" }],
    });
    yield* sink.recordOutcome(makeOutcome(AGENT_A));
    const bundle = yield* sink.finalize();
    expect(bundle.workspaceDiff?.changed).toHaveLength(1);
  });

  itEffect(
    "finalize merges multiple recordContextPatch calls (later wins per key)",
    function* () {
      const sink = makeNormalizedBundleSink(makePlan([AGENT_A]), "run-ctx");
      yield* sink.recordContextPatch({ a: 1, b: 2 });
      yield* sink.recordContextPatch({ b: 99, c: 3 });
      yield* sink.recordOutcome(makeOutcome(AGENT_A));
      const bundle = yield* sink.finalize();
      expect(bundle.context).toMatchObject({ a: 1, b: 99, c: 3 });
    },
  );
});
