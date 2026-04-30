// Property-based tests for the pure pipeline helpers in src/app/pipeline.ts.
// These functions are small and structural — ideal PBT targets where one
// property kills many mutants in arithmetic and conditional logic.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  bundleModelName,
  buildReport,
  renderAgentStartCause,
  renderBundleBuildFailureCause,
  renderHarnessFailureCause,
  sumAgentTurns,
  sumTurns,
  summarizeDiff,
} from "../src/app/pipeline.js";
import {
  AGENT_START_CAUSE,
  type AgentStartErrorCause,
  type BundleBuildCause,
  type HarnessExecutionCause,
} from "../src/core/errors.js";
import type {
  AgentTurn,
  JudgmentBundle,
  Turn,
  WorkspaceFileChange,
} from "../src/core/types.js";
import {
  AgentId,
  ProjectId,
  RunId,
  RunNumber,
  RUN_SOURCE,
  ScenarioId,
} from "../src/core/types.js";
import type { RunRecord } from "../src/core/schema.js";

const RUNS = 200;

// ── arbitraries ─────────────────────────────────────────────────────────────

const stringOrNull = fc.option(fc.string(), { nil: null });

const fileChangeArb: fc.Arbitrary<WorkspaceFileChange> = fc.record({
  path: fc.string({ minLength: 1 }),
  before: stringOrNull,
  after: stringOrNull,
});

const turnArb: fc.Arbitrary<Turn> = fc.record({
  index: fc.nat(),
  prompt: fc.string(),
  response: fc.string(),
  startedAt: fc.constant("2026-04-29T00:00:00.000Z"),
  latencyMs: fc.nat(),
  toolCallCount: fc.nat({ max: 1000 }),
  inputTokens: fc.nat({ max: 1_000_000 }),
  outputTokens: fc.nat({ max: 1_000_000 }),
  cacheReadTokens: fc.nat({ max: 1_000_000 }),
  cacheWriteTokens: fc.nat({ max: 1_000_000 }),
});

const agentTurnArb: fc.Arbitrary<AgentTurn> = fc.record(
  { turn: turnArb, agentId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }) },
  { requiredKeys: ["turn"] },
).map((t) =>
  t.agentId === undefined ? { turn: t.turn } : { turn: t.turn, agentId: AgentId(t.agentId) },
);

// Minimal RunRecord shaped for buildReport's inputs (only `pass` and
// `latencyMs` are read; everything else is structural padding).
const runRecordArb: fc.Arbitrary<RunRecord> = fc.record({
  pass: fc.boolean(),
  latencyMs: fc.nat({ max: 1_000_000 }),
}).map((partial) => ({
  source: RUN_SOURCE.Bundle,
  scenarioId: ScenarioId("scn"),
  runNumber: RunNumber(1),
  modelName: "m",
  judgeModel: "j",
  startedAt: "2026-04-29T00:00:00.000Z",
  latencyMs: partial.latencyMs,
  pass: partial.pass,
  reason: "",
  issues: [],
  overallSeverity: null,
  judgeConfidence: null,
  retryCount: 0,
  toolCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptPath: "",
  workspaceDiffSummary: { changed: 0, added: 0, removed: 0 },
}));

// ── summarizeDiff ───────────────────────────────────────────────────────────

describe("summarizeDiff (PBT)", () => {
  it("returns all-zero counts when input is undefined", () => {
    expect(summarizeDiff(undefined)).toEqual({ changed: 0, added: 0, removed: 0 });
  });

  it("counts add/remove/change buckets matching the before/after rule", () => {
    fc.assert(
      fc.property(fc.array(fileChangeArb, { maxLength: 30 }), (changes) => {
        const summary = summarizeDiff({ changed: changes });

        const expectedAdded = changes.filter((c) => c.before === null && c.after !== null).length;
        const expectedRemoved = changes.filter((c) => c.before !== null && c.after === null).length;
        const expectedChanged = changes.length - expectedAdded - expectedRemoved;

        expect(summary.added).toBe(expectedAdded);
        expect(summary.removed).toBe(expectedRemoved);
        expect(summary.changed).toBe(expectedChanged);
      }),
      { numRuns: RUNS },
    );
  });

  it("sum of buckets equals the input length", () => {
    fc.assert(
      fc.property(fc.array(fileChangeArb, { maxLength: 50 }), (changes) => {
        const { changed, added, removed } = summarizeDiff({ changed: changes });
        expect(changed + added + removed).toBe(changes.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("never returns negative counts", () => {
    fc.assert(
      fc.property(fc.array(fileChangeArb, { maxLength: 30 }), (changes) => {
        const s = summarizeDiff({ changed: changes });
        expect(s.changed).toBeGreaterThanOrEqual(0);
        expect(s.added).toBeGreaterThanOrEqual(0);
        expect(s.removed).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("an entry with both null halves classifies as changed (not added or removed)", () => {
    // Documents the actual fall-through semantics — both-null falls
    // through the if/else-if into the changed bucket.
    expect(
      summarizeDiff({
        changed: [{ path: "x", before: null, after: null }],
      }),
    ).toEqual({ changed: 1, added: 0, removed: 0 });
  });
});

// ── sumTurns / sumAgentTurns ────────────────────────────────────────────────

describe("sumTurns (PBT)", () => {
  it("returns all-zero counts on empty input", () => {
    expect(sumTurns([])).toEqual({
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("each field is the field-wise sum across all input turns", () => {
    fc.assert(
      fc.property(fc.array(turnArb, { maxLength: 20 }), (turns) => {
        const out = sumTurns(turns);
        const expected = {
          toolCallCount: turns.reduce((s, t) => s + t.toolCallCount, 0),
          inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
          outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
          cacheReadTokens: turns.reduce((s, t) => s + t.cacheReadTokens, 0),
          cacheWriteTokens: turns.reduce((s, t) => s + t.cacheWriteTokens, 0),
        };
        expect(out).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it("is order-independent (commutative reduce)", () => {
    fc.assert(
      fc.property(fc.array(turnArb, { maxLength: 20 }), (turns) => {
        const reversed = [...turns].reverse();
        expect(sumTurns(turns)).toEqual(sumTurns(reversed));
      }),
      { numRuns: RUNS },
    );
  });
});

describe("sumAgentTurns (PBT)", () => {
  it("returns the zero aggregate when input is undefined", () => {
    expect(sumAgentTurns(undefined)).toEqual(sumTurns([]));
  });

  it("matches sumTurns over the unwrapped turn entries", () => {
    fc.assert(
      fc.property(fc.array(agentTurnArb, { maxLength: 20 }), (entries) => {
        const out = sumAgentTurns(entries);
        const expected = sumTurns(entries.map((e) => e.turn));
        expect(out).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── bundleModelName ─────────────────────────────────────────────────────────

describe("bundleModelName (PBT)", () => {
  function bundleWithMetadata(metadata: Record<string, unknown> | undefined): JudgmentBundle {
    return {
      runId: RunId("r"),
      project: ProjectId("p"),
      scenarioId: ScenarioId("s"),
      name: "n",
      description: "d",
      requirements: { expectedBehavior: "x", validationChecks: [] },
      agents: [{ id: "a", name: "A" }],
      outcomes: [
        { agentId: AgentId("a"), status: "completed", endedAt: "2026-04-29T00:00:00.000Z" },
      ],
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  it("returns the metadata.modelName string when present and non-empty", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (modelName) => {
        const bundle = bundleWithMetadata({ modelName });
        expect(bundleModelName(bundle)).toBe(modelName);
      }),
      { numRuns: RUNS },
    );
  });

  it("falls back to `${project}/bundle` when metadata.modelName is missing, empty, or non-string", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant({}),
          fc.constant({ modelName: "" }),
          fc.constant({ modelName: 123 }),
          fc.constant({ modelName: null }),
        ),
        (metadata) => {
          const bundle = bundleWithMetadata(metadata as Record<string, unknown> | undefined);
          expect(bundleModelName(bundle)).toBe("p/bundle");
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── buildReport ─────────────────────────────────────────────────────────────

describe("buildReport (PBT)", () => {
  it("returns zero summary when runs is empty", () => {
    const report = buildReport([], undefined);
    expect(report.summary).toEqual({ total: 0, passed: 0, failed: 0, avgLatencyMs: 0 });
    expect(report.runs).toEqual([]);
    expect(report.artifactsDir).toBeUndefined();
  });

  it("preserves the runs array reference content", () => {
    fc.assert(
      fc.property(fc.array(runRecordArb, { maxLength: 20 }), (runs) => {
        const report = buildReport(runs, undefined);
        expect(report.runs).toBe(runs);
      }),
      { numRuns: RUNS },
    );
  });

  it("total === runs.length and passed + failed === total", () => {
    fc.assert(
      fc.property(fc.array(runRecordArb, { maxLength: 20 }), (runs) => {
        const report = buildReport(runs, undefined);
        expect(report.summary.total).toBe(runs.length);
        expect(report.summary.passed + report.summary.failed).toBe(runs.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("passed equals the count of pass=true runs", () => {
    fc.assert(
      fc.property(fc.array(runRecordArb, { maxLength: 20 }), (runs) => {
        const report = buildReport(runs, undefined);
        expect(report.summary.passed).toBe(runs.filter((r) => r.pass).length);
      }),
      { numRuns: RUNS },
    );
  });

  it("avgLatencyMs equals total/count for non-empty input", () => {
    fc.assert(
      fc.property(fc.array(runRecordArb, { minLength: 1, maxLength: 20 }), (runs) => {
        const report = buildReport(runs, undefined);
        const expected = runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length;
        expect(report.summary.avgLatencyMs).toBeCloseTo(expected, 6);
      }),
      { numRuns: RUNS },
    );
  });

  it("includes artifactsDir in the result iff it is defined", () => {
    fc.assert(
      fc.property(
        fc.array(runRecordArb, { maxLength: 5 }),
        fc.option(fc.string(), { nil: undefined }),
        (runs, artifactsDir) => {
          const report = buildReport(runs, artifactsDir);
          if (artifactsDir === undefined) {
            expect(report).not.toHaveProperty("artifactsDir");
          } else {
            expect(report.artifactsDir).toBe(artifactsDir);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── renderAgentStartCause ───────────────────────────────────────────────────

describe("renderAgentStartCause (example, all branches)", () => {
  // One example per discriminator forces every switch arm to be walked
  // and kills the StringLiteral mutants on each rendered template.
  it.each([
    [{ _tag: AGENT_START_CAUSE.BuildContextMissing, path: "/ctx" } as const, "/ctx"],
    [{ _tag: AGENT_START_CAUSE.DockerBuildFailed, message: "boom" } as const, "boom"],
    [{ _tag: AGENT_START_CAUSE.ImageMissing, image: "img:1" } as const, "img:1"],
    [
      { _tag: AGENT_START_CAUSE.ImagePullFailed, image: "img:1", message: "rate" } as const,
      "img:1",
    ],
    [{ _tag: AGENT_START_CAUSE.ContainerStartFailed, message: "nope" } as const, "nope"],
    [{ _tag: AGENT_START_CAUSE.BinaryNotFound, path: "/bin/x" } as const, "/bin/x"],
    [{ _tag: AGENT_START_CAUSE.WorkspacePathEscape, wfPath: "../etc" } as const, "../etc"],
    [{ _tag: AGENT_START_CAUSE.WorkspaceSetupFailed, message: "perm" } as const, "perm"],
  ])("renders %s containing %s", (cause, expectedFragment) => {
    const out = renderAgentStartCause(cause as AgentStartErrorCause);
    expect(out).toContain(expectedFragment);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("renderHarnessFailureCause (example, all branches)", () => {
  it.each([
    [{ _tag: "MissingRuntimeHandle", agentId: "a1" } as const, "a1"],
    [{ _tag: "InvalidPlanMetadata", message: "meta" } as const, "meta"],
    [{ _tag: "ExecutionFailed", message: "exec" } as const, "exec"],
  ])("renders %s containing %s", (cause, fragment) => {
    expect(renderHarnessFailureCause(cause as HarnessExecutionCause)).toContain(fragment);
  });
});

describe("renderBundleBuildFailureCause (example, all branches)", () => {
  it.each([
    [{ _tag: "DuplicateOutcome", agentId: "a1" } as const, "a1"],
    [{ _tag: "MissingOutcomes", agentIds: ["a", "b"] } as const, "a, b"],
    [{ _tag: "UnknownAgent", agentId: "a1" } as const, "a1"],
    [
      { _tag: "EventOrderViolation", previousTs: 100, nextTs: 50 } as const,
      "100",
    ],
    [{ _tag: "SchemaInvalid", errors: ["e1", "e2"] } as const, "e1; e2"],
  ])("renders %s containing %s", (cause, fragment) => {
    expect(renderBundleBuildFailureCause(cause as BundleBuildCause)).toContain(fragment);
  });
});
