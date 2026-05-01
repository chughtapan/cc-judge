// Targeted formatter tests for `formatInspectReport`.
//
// Two layers:
//   1. PBT (fast-check): structural properties that hold across the
//      InspectReport input domain — header shape, gap-line bookkeeping,
//      event count, outcome-branch invariants. PBT kills the branch /
//      equality / off-by-one mutations.
//   2. Example tests: pin the exact user-facing strings and the per-kind
//      summary formats. Examples kill StringLiteral mutations that PBT
//      would happily survive.
//
// Together they cover formatInspectReport without re-introducing
// substring asserts in the business-logic test files.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  INSPECT_SOURCE,
  formatInspectReport,
  type InspectOutcomeView,
  type InspectReport,
  type InspectSource,
} from "../src/app/inspect.js";
import { WAL_LINE_KIND, type WalLine, type WalLineKind } from "../src/emit/wal.js";

const PROPERTY_RUNS = 100;

const TS_FIXED = 1_704_067_200_000; // 2024-01-01T00:00:00.000Z
const ISO_FIXED = "2024-01-01T00:00:00.000Z";
const RUN_ID = "fmt-run";

function event(seq: number, kind: WalLineKind, payload: unknown): WalLine {
  return { v: 1, runId: RUN_ID, seq, ts: TS_FIXED, kind, payload };
}

function emptyReport(overrides: Partial<InspectReport> = {}): InspectReport {
  return {
    runId: RUN_ID,
    source: INSPECT_SOURCE.Inflight,
    events: [],
    outcome: null,
    gaps: [],
    ...overrides,
  };
}

// ── arbitraries ────────────────────────────────────────────────────────────

// runIds restricted to a printable ASCII subset so the runId can be embedded
// directly into a string the test compares against — no regex escaping needed.
const runIdArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[A-Za-z0-9._:-]+$/u.test(s));

const sourceArb: fc.Arbitrary<InspectSource> = fc.constantFrom(
  INSPECT_SOURCE.Inflight,
  INSPECT_SOURCE.Completed,
);

// Outcome and Orphaned are filtered out of report.events upstream — never
// included here so the PBT property "events count = event-line count" holds.
const kindArb: fc.Arbitrary<WalLineKind> = fc.constantFrom(
  WAL_LINE_KIND.Phase,
  WAL_LINE_KIND.Turn,
  WAL_LINE_KIND.Event,
  WAL_LINE_KIND.Context,
  WAL_LINE_KIND.WorkspaceDiff,
);

const eventArb: fc.Arbitrary<WalLine> = fc.record({
  v: fc.constant(1 as const),
  runId: fc.constant(RUN_ID),
  seq: fc.nat({ max: 9999 }),
  ts: fc.constant(TS_FIXED),
  kind: kindArb,
  payload: fc.option(
    fc.record({
      name: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      index: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
      type: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    }, { requiredKeys: [] }),
    { nil: null },
  ),
});

// Status / reason strings excluded from special chars so direct
// containment assertions stay safe (no embedded ')' that would confuse
// the parens-presence test below).
const safeText = fc.string({ minLength: 1, maxLength: 30 })
  .filter((s) => !s.includes("\n") && !s.includes("(") && !s.includes(")"));

const outcomeViewArb: fc.Arbitrary<InspectOutcomeView | null> = fc.option(
  fc.record({
    status: fc.option(safeText, { nil: null }),
    reason: fc.option(safeText, { nil: null }),
  }),
  { nil: null },
);

const reportArb: fc.Arbitrary<InspectReport> = fc.record({
  runId: runIdArb,
  source: sourceArb,
  events: fc.array(eventArb, { maxLength: 15 }),
  outcome: outcomeViewArb,
  gaps: fc.array(fc.nat({ max: 9999 }), { maxLength: 8 }),
});

// ── PBT: header invariants ────────────────────────────────────────────────

describe("formatInspectReport PBT — header", () => {
  it("stdout always begins with 'cc-judge inspect: run <runId> [<source>]\\n\\n'", () => {
    fc.assert(
      fc.property(reportArb, (r) => {
        const out = formatInspectReport(r);
        const expected = `cc-judge inspect: run ${r.runId} [${r.source}]\n\n`;
        expect(out.stdout.startsWith(expected)).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("source token is exactly one of the two known values", () => {
    fc.assert(
      fc.property(reportArb, (r) => {
        const out = formatInspectReport(r);
        const inflight = out.stdout.includes(`[${INSPECT_SOURCE.Inflight}]`);
        const completed = out.stdout.includes(`[${INSPECT_SOURCE.Completed}]`);
        // Exactly one of the two source tokens must be present in the header.
        expect(inflight || completed).toBe(true);
        expect(inflight && completed).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── PBT: gap warnings (stderr) ────────────────────────────────────────────

describe("formatInspectReport PBT — gap warnings", () => {
  it("stderr line count equals report.gaps.length", () => {
    fc.assert(
      fc.property(reportArb, (r) => {
        const out = formatInspectReport(r);
        const lines = out.stderr.length === 0
          ? []
          : out.stderr.split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(r.gaps.length);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("every gap value appears at least once in stderr", () => {
    fc.assert(
      fc.property(reportArb, (r) => {
        const out = formatInspectReport(r);
        for (const g of r.gaps) {
          expect(out.stderr).toContain(`missing seq ${String(g)}`);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("stderr lines preserve report.gaps order", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.gaps.length >= 2), (r) => {
        const out = formatInspectReport(r);
        let cursor = 0;
        for (const g of r.gaps) {
          const tok = `missing seq ${String(g)}`;
          const idx = out.stderr.indexOf(tok, cursor);
          expect(idx).toBeGreaterThanOrEqual(cursor);
          cursor = idx + tok.length;
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("gaps=[] ⇒ stderr is exactly the empty string", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.gaps.length === 0), (r) => {
        expect(formatInspectReport(r).stderr).toBe("");
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── PBT: empty-timeline early return ──────────────────────────────────────

describe("formatInspectReport PBT — empty timeline", () => {
  it("no events AND no outcome ⇒ stdout = header + '  no events, no outcome\\n'", () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.events.length === 0 && r.outcome === null),
        (r) => {
          const out = formatInspectReport(r);
          expect(out.stdout).toBe(
            `cc-judge inspect: run ${r.runId} [${r.source}]\n\n  no events, no outcome\n`,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("no events AND no outcome ⇒ stdout never contains 'outcome:'", () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.events.length === 0 && r.outcome === null),
        (r) => {
          expect(formatInspectReport(r).stdout).not.toContain("outcome:");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── PBT: event line count + format ────────────────────────────────────────

describe("formatInspectReport PBT — event lines", () => {
  it("event line count equals report.events.length", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.events.length > 0), (r) => {
        const out = formatInspectReport(r);
        // An event line: 2-space indent, padded numeric seq, 2 spaces, ISO ts.
        const lines = out.stdout
          .split("\n")
          .filter((l) => /^ +\d+ {2}\d{4}-\d{2}-\d{2}T/u.test(l));
        expect(lines.length).toBe(r.events.length);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("ISO timestamp appears once per event line", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.events.length > 0), (r) => {
        const out = formatInspectReport(r);
        const matches = out.stdout.split(ISO_FIXED).length - 1;
        expect(matches).toBe(r.events.length);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("each event's kind appears in its line", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.events.length > 0), (r) => {
        const out = formatInspectReport(r);
        for (const e of r.events) {
          expect(out.stdout).toContain(e.kind);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── PBT: outcome rendering branches ───────────────────────────────────────

describe("formatInspectReport PBT — outcome rendering", () => {
  it("outcome present ⇒ stdout contains exactly one 'outcome:' token", () => {
    fc.assert(
      fc.property(reportArb.filter((r) => r.outcome !== null), (r) => {
        const out = formatInspectReport(r);
        const matches = out.stdout.split("outcome:").length - 1;
        expect(matches).toBe(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("outcome.status non-null ⇒ status appears verbatim after 'outcome: '", () => {
    fc.assert(
      fc.property(
        reportArb.filter(
          (r) => r.outcome !== null && r.outcome.status !== null,
        ),
        (r) => {
          // r.outcome.status is non-null per the filter above.
          const status = r.outcome?.status;
          if (status === null || status === undefined) return;
          expect(formatInspectReport(r).stdout).toContain(`outcome: ${status}`);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("outcome.status null ⇒ falls back to 'outcome: unknown'", () => {
    fc.assert(
      fc.property(
        reportArb.filter(
          (r) => r.outcome !== null && r.outcome.status === null,
        ),
        (r) => {
          expect(formatInspectReport(r).stdout).toContain("outcome: unknown");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("outcome.reason non-null ⇒ reason wrapped in '(<reason>)'", () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.outcome !== null && r.outcome.reason !== null),
        (r) => {
          const reason = r.outcome?.reason;
          if (reason === null || reason === undefined) return;
          expect(formatInspectReport(r).stdout).toContain(`(${reason})`);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("outcome.reason null ⇒ no parens in the outcome line", () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.outcome !== null && r.outcome.reason === null),
        (r) => {
          const out = formatInspectReport(r);
          const tail = out.stdout.slice(out.stdout.indexOf("outcome:"));
          expect(tail).not.toContain("(");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("outcome null + at least one event ⇒ '(none — ...)' trailer", () => {
    fc.assert(
      fc.property(
        reportArb.filter((r) => r.outcome === null && r.events.length > 0),
        (r) => {
          expect(formatInspectReport(r).stdout).toContain("outcome: (none — ");
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── exact-string pins (for StringLiteral mutation kill) ───────────────────

describe("formatInspectReport: exact strings (mutation pins)", () => {
  it("inflight + no outcome but events present ⇒ '(none — run still in flight)'", () => {
    const out = formatInspectReport(
      emptyReport({
        source: INSPECT_SOURCE.Inflight,
        events: [event(0, WAL_LINE_KIND.Phase, { name: "p" })],
      }),
    );
    expect(out.stdout).toContain("\n  outcome: (none — run still in flight)\n");
  });

  it("completed + no outcome but events present ⇒ '(none — no outcome line found)'", () => {
    const out = formatInspectReport(
      emptyReport({
        source: INSPECT_SOURCE.Completed,
        events: [event(0, WAL_LINE_KIND.Phase, { name: "p" })],
      }),
    );
    expect(out.stdout).toContain("\n  outcome: (none — no outcome line found)\n");
  });

  it("gap warning prefix is exactly 'cc-judge inspect: warning: missing seq '", () => {
    const out = formatInspectReport(emptyReport({ gaps: [3] }));
    expect(out.stderr).toBe("cc-judge inspect: warning: missing seq 3\n");
  });

  it("event line padding: kind column is 14 chars wide", () => {
    const out = formatInspectReport(
      emptyReport({
        events: [event(0, WAL_LINE_KIND.Phase, { name: "kickoff" })],
        outcome: { status: "completed", reason: null },
      }),
    );
    expect(out.stdout).toContain(`phase${" ".repeat(9)}  name=kickoff`);
  });

  it("seq is right-padded to the largest seq's width", () => {
    const out = formatInspectReport(
      emptyReport({
        events: [
          event(0, WAL_LINE_KIND.Phase, { name: "a" }),
          event(10, WAL_LINE_KIND.Phase, { name: "b" }),
        ],
        outcome: { status: "completed", reason: null },
      }),
    );
    expect(out.stdout).toContain(`   0  ${ISO_FIXED}`);
    expect(out.stdout).toContain(`  10  ${ISO_FIXED}`);
  });

  it("event line summary 'name=<n>' for phase", () => {
    const out = formatInspectReport(
      emptyReport({
        events: [event(0, WAL_LINE_KIND.Phase, { name: "kickoff" })],
        outcome: { status: "completed", reason: null },
      }),
    );
    expect(out.stdout).toContain("name=kickoff");
  });
});

describe("formatInspectReport: summaryForPayload per kind (exact pins)", () => {
  function summaryFor(kind: WalLineKind, payload: unknown): string {
    return formatInspectReport(
      emptyReport({
        events: [event(0, kind, payload)],
        outcome: { status: "completed", reason: null },
      }),
    ).stdout;
  }

  it("turn: 'index=<n>' when payload.index is a number", () => {
    expect(summaryFor(WAL_LINE_KIND.Turn, { index: 7 })).toContain("index=7");
  });

  it("turn: empty summary when index is non-number", () => {
    expect(summaryFor(WAL_LINE_KIND.Turn, { index: "seven" })).not.toContain("index=");
  });

  it("event: 'type=<type>' when payload.type is a string", () => {
    expect(summaryFor(WAL_LINE_KIND.Event, { type: "tool_use" })).toContain("type=tool_use");
  });

  it("event: empty summary when type is non-string", () => {
    expect(summaryFor(WAL_LINE_KIND.Event, { type: 42 })).not.toContain("type=");
  });

  it("phase: empty summary when name is non-string", () => {
    expect(summaryFor(WAL_LINE_KIND.Phase, { name: 42 })).not.toContain("name=");
  });

  it("outcome inline: 'status=<s>' alone when reason is missing", () => {
    expect(summaryFor(WAL_LINE_KIND.Outcome, { status: "completed" }))
      .toContain("status=completed");
  });

  it("outcome inline: 'status=<s> reason=<r>' when both present", () => {
    expect(summaryFor(WAL_LINE_KIND.Outcome, { status: "failed", reason: "boom" }))
      .toContain("status=failed reason=boom");
  });

  it("orphaned: '(orphaned)' literal", () => {
    expect(summaryFor(WAL_LINE_KIND.Orphaned, {})).toContain("(orphaned)");
  });

  it("non-object payload ⇒ empty summary", () => {
    expect(summaryFor(WAL_LINE_KIND.Phase, "just a string")).not.toContain("name=");
  });

  it("null payload ⇒ empty summary", () => {
    expect(summaryFor(WAL_LINE_KIND.Phase, null)).not.toContain("name=");
  });
});
