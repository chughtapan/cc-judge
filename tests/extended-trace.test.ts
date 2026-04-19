import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { canonicalTraceAdapter } from "../src/emit/trace-adapter.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

const TRACE_ID = "trace-1";
const TURN_COUNT_ONE = 1;

describe("extended canonical trace (events, phases, agents, context)", () => {
  const baseTrace = {
    traceId: TRACE_ID,
    name: "multi-agent-game",
    turns: [],
    expectedBehavior: "game completes",
    validationChecks: ["all players participate"],
  };

  itEffect("decodes trace with events", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      events: [
        { type: "message", from: "Agent-1", channel: "town_square", text: "Hello", ts: 1000 },
        { type: "phase", phase: "night", round: 1, ts: 2000 },
        { type: "action", agent: "Agent-3", action: "/kill target:Agent-1", channel: "werewolf_den", ts: 3000 },
        { type: "state", snapshot: { alive: ["Agent-1", "Agent-2"] }, ts: 4000 },
      ],
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://events");
    expect(trace.events).toBeDefined();
    expect(trace.events!.length).toBe(4);
    expect(trace.events![0]?.type).toBe("message");
    expect(trace.events![1]?.type).toBe("phase");
    expect(trace.events![2]?.type).toBe("action");
    expect(trace.events![3]?.type).toBe("state");
  });

  itEffect("decodes trace with phases", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      phases: [
        { id: "night-1", name: "Night 1", tsStart: 1000, tsEnd: 5000 },
        { id: "day-1", name: "Day 1 Discussion", tsStart: 5000 },
      ],
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://phases");
    expect(trace.phases).toBeDefined();
    expect(trace.phases!.length).toBe(2);
    expect(trace.phases![0]?.tsEnd).toBe(5000);
    expect(trace.phases![1]?.tsEnd).toBeUndefined();
  });

  itEffect("decodes trace with agents", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      agents: [
        { id: "a1", name: "Agent-1", role: "werewolf" },
        { id: "a2", name: "Agent-2", role: "villager", metadata: { model: "gpt-5.4" } },
      ],
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://agents");
    expect(trace.agents).toBeDefined();
    expect(trace.agents!.length).toBe(2);
    expect(trace.agents![0]?.role).toBe("werewolf");
    expect(trace.agents![1]?.metadata).toEqual({ model: "gpt-5.4" });
  });

  itEffect("decodes trace with context", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      context: {
        winner: "werewolves",
        rounds: 3,
        playerCount: 4,
      },
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://ctx");
    expect(trace.context).toBeDefined();
    expect(trace.context!.winner).toBe("werewolves");
  });

  itEffect("decodes trace with judgeRubric", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      judgeRubric: "Evaluate whether the werewolf deceived successfully.",
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://rubric");
    expect(trace.judgeRubric).toBe("Evaluate whether the werewolf deceived successfully.");
  });

  itEffect("decodes trace with all extended fields at once", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      events: [{ type: "message", from: "A", channel: "dm", text: "hi", ts: 1 }],
      phases: [{ id: "p1", name: "Phase 1", tsStart: 0 }],
      agents: [{ id: "a1", name: "Agent 1" }],
      context: { key: "value" },
      judgeRubric: "Be strict.",
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://full");
    expect(trace.events!.length).toBe(1);
    expect(trace.phases!.length).toBe(1);
    expect(trace.agents!.length).toBe(1);
    expect(trace.context).toEqual({ key: "value" });
    expect(trace.judgeRubric).toBe("Be strict.");
  });

  itEffect("backward compat: existing trace without extended fields still decodes", function* () {
    const payload = JSON.stringify(baseTrace);
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://compat");
    expect(trace.events).toBeUndefined();
    expect(trace.phases).toBeUndefined();
    expect(trace.agents).toBeUndefined();
    expect(trace.context).toBeUndefined();
    expect(trace.judgeRubric).toBeUndefined();
  });

  itEffect("rejects events with invalid type", function* () {
    const payload = JSON.stringify({
      ...baseTrace,
      events: [{ type: "invalid", ts: 1 }],
    });
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode(payload, "mem://bad-event"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });
});
