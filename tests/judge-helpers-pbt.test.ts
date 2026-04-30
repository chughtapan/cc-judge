// Property-based tests for the pure helpers extracted into
// src/judge/helpers.ts. These cover the prompt-rendering and verdict-
// coercion code that judge/index.ts used to inline. PBT here pays
// well because each helper is shape-only — no SDK, no retry — and
// its input domain is well-defined.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  bundleTurnsToEvents,
  coerceConfidence,
  coerceIssues,
  coerceSeverity,
  extractJsonText,
  renderAgents,
  renderDiff,
  renderEvents,
  renderTurns,
  turnEntryToEvents,
} from "../src/judge/helpers.js";
import {
  AgentId,
  ProjectId,
  RunId,
  ScenarioId,
  type AgentRef,
  type AgentTurn,
  type JudgmentBundle,
  type TraceEvent,
  type Turn,
  type WorkspaceFileChange,
} from "../src/core/types.js";

const RUNS = 100;

// ── arbitraries ─────────────────────────────────────────────────────────────

const stringOrNull = fc.option(fc.string(), { nil: null });

const fileChangeArb: fc.Arbitrary<WorkspaceFileChange> = fc.record({
  path: fc.string({ minLength: 1, maxLength: 50 }),
  before: stringOrNull,
  after: stringOrNull,
});

const turnArb: fc.Arbitrary<Turn> = fc.record({
  index: fc.nat(),
  prompt: fc.string({ maxLength: 100 }),
  response: fc.string({ maxLength: 100 }),
  startedAt: fc.constant("2026-04-29T00:00:00.000Z"),
  latencyMs: fc.nat({ max: 1_000_000 }),
  toolCallCount: fc.nat({ max: 100 }),
  inputTokens: fc.nat({ max: 100_000 }),
  outputTokens: fc.nat({ max: 100_000 }),
  cacheReadTokens: fc.nat({ max: 100_000 }),
  cacheWriteTokens: fc.nat({ max: 100_000 }),
});

const agentRefArb: fc.Arbitrary<AgentRef> = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 30 }),
    name: fc.string({ minLength: 1, maxLength: 30 }),
    role: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
  },
  { requiredKeys: ["id", "name"] },
);

const traceEventArb: fc.Arbitrary<TraceEvent> = fc.oneof(
  fc.record({
    type: fc.constant("message" as const),
    from: fc.string({ minLength: 1, maxLength: 30 }),
    to: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    channel: fc.string({ minLength: 1, maxLength: 30 }),
    text: fc.string({ maxLength: 100 }),
    ts: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  }, { requiredKeys: ["type", "from", "channel", "text", "ts"] }),
  fc.record({
    type: fc.constant("phase" as const),
    phase: fc.string({ minLength: 1, maxLength: 30 }),
    round: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
    ts: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  }, { requiredKeys: ["type", "phase", "ts"] }),
  fc.record({
    type: fc.constant("action" as const),
    agent: fc.string({ minLength: 1, maxLength: 30 }),
    action: fc.string({ minLength: 1, maxLength: 30 }),
    channel: fc.string({ minLength: 1, maxLength: 30 }),
    ts: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  }),
  fc.record({
    type: fc.constant("state" as const),
    snapshot: fc.dictionary(fc.string(), fc.jsonValue()),
    ts: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  }),
);

// ── renderDiff ──────────────────────────────────────────────────────────────

describe("renderDiff (PBT)", () => {
  it("returns the no-changes placeholder for undefined or empty diff", () => {
    expect(renderDiff(undefined)).toBe("(no workspace changes)");
    expect(renderDiff({ changed: [] })).toBe("(no workspace changes)");
  });

  it("emits one line per change", () => {
    fc.assert(
      fc.property(fc.array(fileChangeArb, { minLength: 1, maxLength: 20 }), (changes) => {
        const out = renderDiff({ changed: changes });
        expect(out.split("\n").length).toBe(changes.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("an added entry uses '+ added' and includes the byte count", () => {
    expect(renderDiff({ changed: [{ path: "x.txt", before: null, after: "abc" }] }))
      .toBe("+ added x.txt (3 bytes)");
  });

  it("a removed entry uses '- removed'", () => {
    expect(renderDiff({ changed: [{ path: "x.txt", before: "abc", after: null }] }))
      .toBe("- removed x.txt");
  });

  it("a modified entry uses '~ modified'", () => {
    expect(renderDiff({ changed: [{ path: "x.txt", before: "a", after: "b" }] }))
      .toBe("~ modified x.txt");
  });

  it("an entry with both halves null falls through to '~ modified'", () => {
    // Documents the actual fall-through semantics — both-null is the
    // catch-all branch, same as in summarizeDiff (pipeline.ts).
    expect(renderDiff({ changed: [{ path: "x.txt", before: null, after: null }] }))
      .toBe("~ modified x.txt");
  });

  it("classification is exhaustive and exclusive", () => {
    fc.assert(
      fc.property(fc.array(fileChangeArb, { minLength: 1, maxLength: 20 }), (changes) => {
        const out = renderDiff({ changed: changes });
        for (const line of out.split("\n")) {
          // Each line starts with one of the three discriminators.
          const head = line.charAt(0);
          expect(["+", "-", "~"]).toContain(head);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ── renderTurns ─────────────────────────────────────────────────────────────

describe("renderTurns (PBT)", () => {
  it("returns empty string for empty input", () => {
    expect(renderTurns([])).toBe("");
  });

  it("emits exactly 3 lines per turn", () => {
    fc.assert(
      fc.property(fc.array(turnArb, { minLength: 1, maxLength: 5 }), (turns) => {
        const lines = renderTurns(turns).split("\n");
        expect(lines.length).toBe(turns.length * 3);
      }),
      { numRuns: RUNS },
    );
  });

  it("each turn block contains the index, prompt, and response", () => {
    fc.assert(
      fc.property(fc.array(turnArb, { minLength: 1, maxLength: 5 }), (turns) => {
        const out = renderTurns(turns);
        for (const t of turns) {
          expect(out).toContain(`--- Turn ${String(t.index)} ---`);
          expect(out).toContain(`USER: ${t.prompt}`);
          expect(out).toContain(`ASSISTANT: ${t.response}`);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ── renderEvents ────────────────────────────────────────────────────────────

describe("renderEvents (PBT)", () => {
  it("returns empty string for empty input", () => {
    expect(renderEvents([])).toBe("");
  });

  it("emits exactly one line per event", () => {
    fc.assert(
      fc.property(fc.array(traceEventArb, { minLength: 1, maxLength: 10 }), (events) => {
        // Some events (state with multi-line snapshot, message with newline
        // text) can technically contain "\n" in their rendered form. Filter
        // for the simple cases where line count is one-per-event.
        const safe = events.filter(
          (e) => !(e.type === "message" && e.text.includes("\n")) &&
                 !(e.type === "phase" && e.phase.includes("\n")) &&
                 !(e.type === "action" && (e.action.includes("\n") || e.agent.includes("\n"))),
        );
        if (safe.length === 0) return;
        const lines = renderEvents(safe).split("\n");
        expect(lines.length).toBe(safe.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("a message event starts with [iso] [channel] from", () => {
    const event: TraceEvent = {
      type: "message",
      from: "alice",
      to: "bob",
      channel: "chat",
      text: "hello",
      ts: 0,
    };
    const out = renderEvents([event]);
    expect(out).toBe("[1970-01-01T00:00:00.000Z] [chat] alice -> bob: hello");
  });

  it("a message event without `to` omits the arrow segment", () => {
    const event: TraceEvent = {
      type: "message",
      from: "alice",
      channel: "chat",
      text: "hello",
      ts: 0,
    };
    const out = renderEvents([event]);
    expect(out).toBe("[1970-01-01T00:00:00.000Z] [chat] alice: hello");
    expect(out).not.toContain(" -> ");
  });

  it("a phase event renders PHASE: with optional round suffix", () => {
    expect(renderEvents([{ type: "phase", phase: "p1", ts: 0 }])).toContain("PHASE: p1");
    expect(renderEvents([{ type: "phase", phase: "p1", round: 3, ts: 0 }])).toContain(
      "PHASE: p1 (round 3)",
    );
  });

  it("an action event renders ACTION:", () => {
    expect(
      renderEvents([{ type: "action", agent: "alice", action: "read", channel: "tool", ts: 0 }]),
    ).toContain("alice ACTION: read");
  });

  it("a state event renders STATE: <json>", () => {
    expect(renderEvents([{ type: "state", snapshot: { x: 1 }, ts: 0 }]))
      .toContain('STATE: {"x":1}');
  });
});

// ── renderAgents ────────────────────────────────────────────────────────────

describe("renderAgents (PBT)", () => {
  it("emits one line per agent", () => {
    fc.assert(
      fc.property(fc.array(agentRefArb, { minLength: 1, maxLength: 5 }), (agents) => {
        const lines = renderAgents(agents).split("\n");
        expect(lines.length).toBe(agents.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("includes role suffix iff role is defined", () => {
    expect(renderAgents([{ id: "a", name: "A" }])).toBe("- A (a)");
    expect(renderAgents([{ id: "a", name: "A", role: "judge" }])).toBe("- A (a) role=judge");
  });

  it("returns empty string for empty input", () => {
    expect(renderAgents([])).toBe("");
  });
});

// ── turnEntryToEvents ───────────────────────────────────────────────────────

describe("turnEntryToEvents (PBT)", () => {
  it("emits exactly two events per turn (prompt + response)", () => {
    fc.assert(
      fc.property(turnArb, (turn) => {
        const entry: AgentTurn = { turn, agentId: AgentId("a") };
        const map = new Map([["a", "Alice"]]);
        const events = turnEntryToEvents(entry, map);
        expect(events.length).toBe(2);
        expect(events[0]?.type).toBe("message");
        expect(events[1]?.type).toBe("message");
      }),
      { numRuns: RUNS },
    );
  });

  it("uses 'assistant' as the agent name when entry.agentId is undefined", () => {
    const entry: AgentTurn = {
      turn: {
        index: 0,
        prompt: "p",
        response: "r",
        startedAt: "2026-04-29T00:00:00.000Z",
        latencyMs: 100,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    const events = turnEntryToEvents(entry, new Map());
    const first = events[0];
    expect(first?.type).toBe("message");
    if (first?.type === "message") {
      expect(first.to).toBe("assistant");
    }
  });

  it("uses agent ID as the name when ID is set but not in the map", () => {
    const entry: AgentTurn = {
      turn: {
        index: 0,
        prompt: "p",
        response: "r",
        startedAt: "2026-04-29T00:00:00.000Z",
        latencyMs: 100,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      agentId: AgentId("phantom"),
    };
    const events = turnEntryToEvents(entry, new Map([["other", "Other"]]));
    const first = events[0];
    if (first?.type === "message") {
      expect(first.to).toBe("phantom");
    }
  });

  it("response event's ts is prompt ts + latencyMs", () => {
    const entry: AgentTurn = {
      turn: {
        index: 0,
        prompt: "p",
        response: "r",
        startedAt: "2026-04-29T00:00:00.000Z",
        latencyMs: 250,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    const events = turnEntryToEvents(entry, new Map());
    expect(events.length).toBe(2);
    if (events[0] !== undefined && events[1] !== undefined) {
      expect(events[1].ts - events[0].ts).toBe(250);
    }
  });
});

// ── bundleTurnsToEvents ─────────────────────────────────────────────────────

function makeBundle(overrides: Partial<JudgmentBundle> = {}): JudgmentBundle {
  return {
    runId: RunId("r"),
    project: ProjectId("p"),
    scenarioId: ScenarioId("s"),
    name: "n",
    description: "d",
    requirements: { expectedBehavior: "x", validationChecks: [] },
    agents: [{ id: "a", name: "A" }],
    outcomes: [{ agentId: AgentId("a"), status: "completed", endedAt: "2026-04-29T00:00:00.000Z" }],
    ...overrides,
  };
}

describe("bundleTurnsToEvents (PBT)", () => {
  it("returns bundle.events directly when present and non-empty", () => {
    const events: ReadonlyArray<TraceEvent> = [
      { type: "phase", phase: "kickoff", ts: 0 },
    ];
    const result = bundleTurnsToEvents(makeBundle({ events }));
    expect(result).toBe(events);
  });

  it("returns undefined when no events and no turns", () => {
    expect(bundleTurnsToEvents(makeBundle())).toBeUndefined();
  });

  it("returns undefined when events is empty array and no turns", () => {
    expect(bundleTurnsToEvents(makeBundle({ events: [] }))).toBeUndefined();
  });

  it("synthesizes events from turns when bundle.events is empty/missing", () => {
    const turn: Turn = {
      index: 0,
      prompt: "p",
      response: "r",
      startedAt: "2026-04-29T00:00:00.000Z",
      latencyMs: 100,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const result = bundleTurnsToEvents(
      makeBundle({ turns: [{ turn, agentId: AgentId("a") }] }),
    );
    // Two events per turn (prompt + response).
    expect(result?.length).toBe(2);
  });

  it("synthesized events use the agent name from the bundle.agents map", () => {
    const turn: Turn = {
      index: 0,
      prompt: "p",
      response: "r",
      startedAt: "2026-04-29T00:00:00.000Z",
      latencyMs: 100,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const result = bundleTurnsToEvents(
      makeBundle({
        agents: [{ id: "a", name: "Alpha" }],
        turns: [{ turn, agentId: AgentId("a") }],
      }),
    );
    const first = result?.[0];
    if (first?.type === "message") {
      expect(first.to).toBe("Alpha");
    }
  });
});

// ── extractJsonText ─────────────────────────────────────────────────────────

describe("extractJsonText (PBT)", () => {
  it("returns input unchanged when no fences present", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Avoid pathological cases: strings that themselves look like fences.
        if (text.includes("```")) return;
        expect(extractJsonText(text)).toBe(text.trim());
      }),
      { numRuns: RUNS },
    );
  });

  it("strips a leading ```json fence", () => {
    expect(extractJsonText("```json\n{\"x\":1}\n```")).toBe('{"x":1}');
  });

  it("strips a leading ``` fence (no language tag)", () => {
    expect(extractJsonText("```\n{\"x\":1}\n```")).toBe('{"x":1}');
  });

  it("strips trailing whitespace", () => {
    expect(extractJsonText("  {\"x\":1}  \n")).toBe('{"x":1}');
  });

  it("returns empty string for whitespace-only input", () => {
    expect(extractJsonText("   \n  ")).toBe("");
    expect(extractJsonText("")).toBe("");
  });

  it("output is always a string", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(typeof extractJsonText(text)).toBe("string");
      }),
      { numRuns: RUNS },
    );
  });
});

// ── coerceSeverity ──────────────────────────────────────────────────────────

describe("coerceSeverity (PBT)", () => {
  it("returns the value for the three valid severities", () => {
    expect(coerceSeverity("minor")).toBe("minor");
    expect(coerceSeverity("significant")).toBe("significant");
    expect(coerceSeverity("critical")).toBe("critical");
  });

  it("returns null for any other input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.integer(),
          fc.string().filter((s) => s !== "minor" && s !== "significant" && s !== "critical"),
          fc.constant({}),
        ),
        (v) => {
          expect(coerceSeverity(v)).toBeNull();
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── coerceIssues ────────────────────────────────────────────────────────────

describe("coerceIssues (PBT)", () => {
  it("returns empty array for non-array input", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(), fc.constant({})),
        (v) => {
          expect(coerceIssues(v)).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("filters out entries that are not objects", () => {
    expect(coerceIssues([null, undefined, 42, "x"])).toEqual([]);
  });

  it("filters out entries whose issue is not a string", () => {
    expect(coerceIssues([{ issue: 42, severity: "minor" }])).toEqual([]);
    expect(coerceIssues([{ severity: "minor" }])).toEqual([]);
  });

  it("filters out entries with invalid severity", () => {
    expect(coerceIssues([{ issue: "x", severity: "wat" }])).toEqual([]);
    expect(coerceIssues([{ issue: "x" }])).toEqual([]);
  });

  it("preserves valid entries", () => {
    expect(coerceIssues([{ issue: "x", severity: "minor" }, { issue: "y", severity: "critical" }]))
      .toEqual([
        { issue: "x", severity: "minor" },
        { issue: "y", severity: "critical" },
      ]);
  });

  it("mixed input: keeps only valid entries", () => {
    expect(
      coerceIssues([
        { issue: "ok", severity: "minor" },
        { issue: 42, severity: "minor" },
        { issue: "ok2", severity: "wat" },
        null,
        { issue: "ok3", severity: "critical" },
      ]),
    ).toEqual([
      { issue: "ok", severity: "minor" },
      { issue: "ok3", severity: "critical" },
    ]);
  });
});

// ── coerceConfidence ────────────────────────────────────────────────────────

describe("coerceConfidence (PBT)", () => {
  it("returns undefined for non-numbers and NaN", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.boolean(),
          fc.constant(NaN),
        ),
        (v) => {
          expect(coerceConfidence(v)).toBeUndefined();
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("clamps to [0, 1]", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true }), (n) => {
        const out = coerceConfidence(n);
        expect(out).toBeDefined();
        if (out !== undefined) {
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("returns the value unchanged for inputs already in [0, 1]", () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 1, noNaN: true }), (n) => {
        expect(coerceConfidence(n)).toBe(n);
      }),
      { numRuns: RUNS },
    );
  });

  it("clamps negatives to 0 and >1 to 1", () => {
    expect(coerceConfidence(-0.5)).toBe(0);
    expect(coerceConfidence(-100)).toBe(0);
    expect(coerceConfidence(1.5)).toBe(1);
    expect(coerceConfidence(999)).toBe(1);
  });
});
