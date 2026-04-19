import { describe, it } from "vitest";
import * as fc from "fast-check";
import * as YAML from "yaml";
import { Value } from "@sinclair/typebox/value";
import {
  ScenarioYamlSchema,
  RunRecordSchema,
  WORKSPACE_PATH_PATTERN,
} from "../../src/core/schema.js";

// ── Arbitraries ────────────────────────────────────────────────────────────

const idArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,40}$/);

// YAML round-trips cleanly for ASCII printable text that avoids YAML-special
// leading characters (|, >, {, [, etc.) and leading/trailing whitespace.
const safeStrArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _.,?!:;-]{0,50}$/);

const scenarioYamlArb = fc.record({
  id: idArb,
  name: safeStrArb,
  description: safeStrArb,
  setupPrompt: safeStrArb,
  expectedBehavior: safeStrArb,
  validationChecks: fc.array(safeStrArb, { minLength: 1, maxLength: 3 }),
});

const severityArb = fc.constantFrom(
  "minor" as const,
  "significant" as const,
  "critical" as const,
);

const issueArb = fc.record({
  issue: fc.string({ minLength: 1 }),
  severity: severityArb,
});

const runRecordArb = fc.record({
  source: fc.constantFrom("scenario" as const, "trace" as const),
  scenarioId: idArb,
  runNumber: fc.integer({ min: 1 }),
  modelName: fc.string(),
  judgeModel: fc.string(),
  startedAt: fc.string(),
  latencyMs: fc.integer({ min: 0 }),
  pass: fc.boolean(),
  reason: fc.string(),
  issues: fc.array(issueArb),
  overallSeverity: fc.oneof(severityArb, fc.constant(null)),
  judgeConfidence: fc.oneof(
    fc.nat(100).map((n) => n / 100),
    fc.constant(null),
  ),
  retryCount: fc.integer({ min: 0 }),
  toolCallCount: fc.integer({ min: 0 }),
  inputTokens: fc.integer({ min: 0 }),
  outputTokens: fc.integer({ min: 0 }),
  cacheReadTokens: fc.integer({ min: 0 }),
  cacheWriteTokens: fc.integer({ min: 0 }),
  transcriptPath: fc.string(),
  workspaceDiffSummary: fc.record({
    changed: fc.integer({ min: 0 }),
    added: fc.integer({ min: 0 }),
    removed: fc.integer({ min: 0 }),
  }),
});

const wppRegex = new RegExp(WORKSPACE_PATH_PATTERN);

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkErrors(schema: Parameters<typeof Value.Errors>[0], value: unknown): string | null {
  const errs = [...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`);
  return errs.length > 0 ? errs.join("; ") : null;
}

// ── Properties ─────────────────────────────────────────────────────────────

describe("property: schema invariants", () => {
  it("Property 1: ScenarioYamlSchema accepts arbitrary valid-shaped objects", () => {
    fc.assert(
      fc.property(scenarioYamlArb, (raw) => {
        const err = checkErrors(ScenarioYamlSchema, raw);
        if (err !== null) {
          throw new Error(
            `Valid-shaped scenario rejected by schema: ${err}\nInput: ${JSON.stringify(raw)}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Property 2: ScenarioYamlSchema YAML round-trip preserves required fields", () => {
    fc.assert(
      fc.property(scenarioYamlArb, (raw) => {
        const yamlStr = YAML.stringify(raw);
        const reparsed: unknown = YAML.parse(yamlStr);
        const err = checkErrors(ScenarioYamlSchema, reparsed);
        if (err !== null) {
          throw new Error(`Round-tripped scenario rejected by schema: ${err}`);
        }
        const s = reparsed as typeof raw;
        if (
          s.id !== raw.id ||
          s.name !== raw.name ||
          s.setupPrompt !== raw.setupPrompt ||
          s.expectedBehavior !== raw.expectedBehavior
        ) {
          throw new Error(
            `Round-trip mutated required field(s):\n` +
              `  id: ${JSON.stringify(raw.id)} → ${JSON.stringify(s.id)}\n` +
              `  name: ${JSON.stringify(raw.name)} → ${JSON.stringify(s.name)}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 3: RunRecord schema encodes non-negative numeric constraints (latencyMs, runNumber, tokens)", () => {
    fc.assert(
      fc.property(runRecordArb, (rec) => {
        if (checkErrors(RunRecordSchema, rec) !== null) return;
        if (rec.latencyMs < 0) throw new Error(`latencyMs=${rec.latencyMs} is negative`);
        if (rec.runNumber < 1) throw new Error(`runNumber=${rec.runNumber} < 1`);
        if (rec.retryCount < 0) throw new Error(`retryCount=${rec.retryCount} is negative`);
        if (rec.toolCallCount < 0) throw new Error(`toolCallCount=${rec.toolCallCount} is negative`);
        if (rec.inputTokens < 0) throw new Error(`inputTokens=${rec.inputTokens} is negative`);
        if (rec.outputTokens < 0) throw new Error(`outputTokens=${rec.outputTokens} is negative`);
        if (rec.cacheReadTokens < 0) throw new Error(`cacheReadTokens=${rec.cacheReadTokens} is negative`);
        if (rec.cacheWriteTokens < 0) throw new Error(`cacheWriteTokens=${rec.cacheWriteTokens} is negative`);
        if (rec.workspaceDiffSummary.changed < 0)
          throw new Error(`workspaceDiffSummary.changed=${rec.workspaceDiffSummary.changed} is negative`);
        if (rec.workspaceDiffSummary.added < 0)
          throw new Error(`workspaceDiffSummary.added=${rec.workspaceDiffSummary.added} is negative`);
        if (rec.workspaceDiffSummary.removed < 0)
          throw new Error(`workspaceDiffSummary.removed=${rec.workspaceDiffSummary.removed} is negative`);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 4: RunRecord schema rejects negative latencyMs (timestamp ordering invariant)", () => {
    fc.assert(
      fc.property(runRecordArb, fc.integer({ min: -100_000, max: -1 }), (rec, badLatency) => {
        const invalid = { ...rec, latencyMs: badLatency };
        if (checkErrors(RunRecordSchema, invalid) === null) {
          throw new Error(`Schema accepted negative latencyMs=${badLatency}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 5: WORKSPACE_PATH_PATTERN — matching paths have no absolute prefix, no traversal, no backslash", () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        if (!wppRegex.test(p)) return;

        if (p.startsWith("/"))
          throw new Error(`Matched path has absolute unix prefix: ${JSON.stringify(p)}`);

        if (/^[A-Za-z]:/.test(p))
          throw new Error(`Matched path has Windows drive letter: ${JSON.stringify(p)}`);

        if (p.includes("\\"))
          throw new Error(`Matched path contains backslash: ${JSON.stringify(p)}`);

        if (/(^|\/)\.\.(?:\/|$)/.test(p))
          throw new Error(`Matched path contains traversal sequence: ${JSON.stringify(p)}`);
      }),
      { numRuns: 200 },
    );
  });
});
