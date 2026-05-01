// Property-based tests for the pure helpers extracted into
// src/judge/helpers.ts. These cover the prompt-rendering and verdict-
// coercion code that judge/index.ts used to inline. PBT here pays
// well because each helper is shape-only — no SDK, no retry — and
// its input domain is well-defined.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  DEFAULT_AGENT_NAME,
  DIFF_PREFIX,
  EVENT_PREFIX,
  PROMPT_NO_DIFF,
  TURN_LABEL,
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
  turnHeader,
} from "../src/judge/helpers.js";
import {
  AgentId,
  ISSUE_SEVERITY,
  ProjectId,
  RunId,
  ScenarioId,
  TRACE_EVENT_TYPE,
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
    expect(renderDiff(undefined)).toBe(PROMPT_NO_DIFF);
    expect(renderDiff({ changed: [] })).toBe(PROMPT_NO_DIFF);
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
    const path = "x.txt";
    const after = "abc";
    expect(renderDiff({ changed: [{ path, before: null, after }] }))
      .toBe(`${DIFF_PREFIX.Added} ${path} (${after.length} bytes)`);
  });

  it("a removed entry uses '- removed'", () => {
    const path = "x.txt";
    expect(renderDiff({ changed: [{ path, before: "abc", after: null }] }))
      .toBe(`${DIFF_PREFIX.Removed} ${path}`);
  });

  it("a modified entry uses '~ modified'", () => {
    const path = "x.txt";
    expect(renderDiff({ changed: [{ path, before: "a", after: "b" }] }))
      .toBe(`${DIFF_PREFIX.Modified} ${path}`);
  });

  it("an entry with both halves null falls through to '~ modified'", () => {
    // Documents the actual fall-through semantics — both-null is the
    // catch-all branch, same as in summarizeDiff (pipeline.ts).
    const path = "x.txt";
    expect(renderDiff({ changed: [{ path, before: null, after: null }] }))
      .toBe(`${DIFF_PREFIX.Modified} ${path}`);
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
          expect(out).toContain(turnHeader(t.index));
          expect(out).toContain(`${TURN_LABEL.User}: ${t.prompt}`);
          expect(out).toContain(`${TURN_LABEL.Assistant}: ${t.response}`);
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
    const from = "alice";
    const to = "bob";
    const channel = "chat";
    const text = "hello";
    const ts = 0;
    const iso = new Date(ts).toISOString();
    const event: TraceEvent = { type: TRACE_EVENT_TYPE.Message, from, to, channel, text, ts };
    expect(renderEvents([event])).toBe(`[${iso}] [${channel}] ${from}${EVENT_PREFIX.MessageArrow}${to}: ${text}`);
  });

  it("a message event without `to` omits the arrow segment", () => {
    const from = "alice";
    const channel = "chat";
    const text = "hello";
    const ts = 0;
    const iso = new Date(ts).toISOString();
    const event: TraceEvent = { type: TRACE_EVENT_TYPE.Message, from, channel, text, ts };
    const out = renderEvents([event]);
    expect(out).toBe(`[${iso}] [${channel}] ${from}: ${text}`);
    expect(out).not.toContain(EVENT_PREFIX.MessageArrow);
  });

  it("a phase event renders PHASE: with optional round suffix", () => {
    const phase = "p1";
    const round = 3;
    expect(renderEvents([{ type: TRACE_EVENT_TYPE.Phase, phase, ts: 0 }]))
      .toContain(`${EVENT_PREFIX.Phase} ${phase}`);
    expect(renderEvents([{ type: TRACE_EVENT_TYPE.Phase, phase, round, ts: 0 }]))
      .toContain(`${EVENT_PREFIX.Phase} ${phase} (round ${round})`);
  });

  it("an action event renders ACTION:", () => {
    const agent = "alice";
    const action = "read";
    expect(
      renderEvents([{ type: TRACE_EVENT_TYPE.Action, agent, action, channel: "tool", ts: 0 }]),
    ).toContain(`${agent} ${EVENT_PREFIX.Action} ${action}`);
  });

  it("a state event renders STATE: <json>", () => {
    const snapshot = { x: 1 };
    expect(renderEvents([{ type: TRACE_EVENT_TYPE.State, snapshot, ts: 0 }]))
      .toContain(`${EVENT_PREFIX.State} ${JSON.stringify(snapshot)}`);
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
    const id = "a";
    const name = "A";
    const role = "judge";
    expect(renderAgents([{ id, name }])).toBe(`- ${name} (${id})`);
    expect(renderAgents([{ id, name, role }])).toBe(`- ${name} (${id}) role=${role}`);
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
        expect(events[0]?.type).toBe(TRACE_EVENT_TYPE.Message);
        expect(events[1]?.type).toBe(TRACE_EVENT_TYPE.Message);
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
    expect(first?.type).toBe(TRACE_EVENT_TYPE.Message);
    if (first?.type === TRACE_EVENT_TYPE.Message) {
      expect(first.to).toBe(DEFAULT_AGENT_NAME);
    }
  });

  it("uses agent ID as the name when ID is set but not in the map", () => {
    const phantomId = "phantom";
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
      agentId: AgentId(phantomId),
    };
    const events = turnEntryToEvents(entry, new Map([["other", "Other"]]));
    const first = events[0];
    if (first?.type === TRACE_EVENT_TYPE.Message) {
      expect(first.to).toBe(phantomId);
    }
  });

  it("response event's ts is prompt ts + latencyMs", () => {
    const latencyMs = 250;
    const entry: AgentTurn = {
      turn: {
        index: 0,
        prompt: "p",
        response: "r",
        startedAt: "2026-04-29T00:00:00.000Z",
        latencyMs,
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
      expect(events[1].ts - events[0].ts).toBe(latencyMs);
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
    const agentId = "a";
    const agentName = "Alpha";
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
        agents: [{ id: agentId, name: agentName }],
        turns: [{ turn, agentId: AgentId(agentId) }],
      }),
    );
    const first = result?.[0];
    if (first?.type === TRACE_EVENT_TYPE.Message) {
      expect(first.to).toBe(agentName);
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
    const json = JSON.stringify({ x: 1 });
    expect(extractJsonText("```json\n" + json + "\n```")).toBe(json);
  });

  it("strips a leading ``` fence (no language tag)", () => {
    const json = JSON.stringify({ x: 1 });
    expect(extractJsonText("```\n" + json + "\n```")).toBe(json);
  });

  it("strips trailing whitespace", () => {
    const json = JSON.stringify({ x: 1 });
    expect(extractJsonText("  " + json + "  \n")).toBe(json);
  });

  it("returns empty string for whitespace-only input", () => {
    expect(extractJsonText("   \n  ")).toBe("");
    expect(extractJsonText("")).toBe("");
  });

  it("output is always a string", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Type narrowing: confirm extractJsonText returns a string by exercising
        // a string-only method on the result without relying on a hardcoded type tag.
        expect(extractJsonText(text).length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── coerceSeverity ──────────────────────────────────────────────────────────

describe("coerceSeverity (PBT)", () => {
  it("returns the value for the three valid severities", () => {
    expect(coerceSeverity(ISSUE_SEVERITY.Minor)).toBe(ISSUE_SEVERITY.Minor);
    expect(coerceSeverity(ISSUE_SEVERITY.Significant)).toBe(ISSUE_SEVERITY.Significant);
    expect(coerceSeverity(ISSUE_SEVERITY.Critical)).toBe(ISSUE_SEVERITY.Critical);
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
