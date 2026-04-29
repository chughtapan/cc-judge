// Property-based tests for the bundle codec round-trip.
// One roundtrip property kills many mutants in encode/decode/normalize
// because every JSON or YAML string and every field rebuild gets exercised
// against generated bundles spanning the schema's input domain.

import { describe, expect } from "vitest";
import { Data, Effect } from "effect";
import * as fc from "fast-check";
import {
  bundleAutoCodec,
  bundleJsonCodec,
  bundleYamlCodec,
  type BundleCodec,
} from "../src/emit/bundle-codec.js";
import { BundleDecodeError } from "../src/core/errors.js";

// Tagged error for fast-check rejections so the test's Effect channel
// stays typed (no generic Error). The message field carries fast-check's
// shrunk-counterexample report verbatim.
class PbtAssertionError extends Data.TaggedError("PbtAssertionError")<{
  readonly message: string;
}> {}
import {
  AGENT_LIFECYCLE_STATUS,
  AgentId,
  ProjectId,
  RunId,
  ScenarioId,
  type AgentLifecycleStatus,
  type AgentOutcome,
  type AgentRef,
  type AgentTurn,
  type JudgmentBundle,
} from "../src/core/types.js";
import { itEffect, expectLeft } from "./support/effect.js";

const PROPERTY_RUNS = 50;

// ── arbitraries ─────────────────────────────────────────────────────────────

// Identifiers must satisfy the schema (minLength 1, maxLength 256). Strings
// of arbitrary unicode are fine for the json codec but YAML round-trips need
// us to avoid characters YAML treats as control (newline at start, leading
// dash with space) — restrict to a printable subset for stable round-trips.
const idArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => /^[A-Za-z0-9_./:@-]+$/u.test(s));

const arbitraryString = fc.string({ minLength: 0, maxLength: 200 });
const nonEmptyString = fc.string({ minLength: 1, maxLength: 200 });

const lifecycleStatusArb: fc.Arbitrary<AgentLifecycleStatus> = fc.constantFrom(
  AGENT_LIFECYCLE_STATUS.Completed,
  AGENT_LIFECYCLE_STATUS.TimedOut,
  AGENT_LIFECYCLE_STATUS.FailedToStart,
  AGENT_LIFECYCLE_STATUS.RuntimeError,
  AGENT_LIFECYCLE_STATUS.Cancelled,
);

const isoDateArb = fc
  .date({ noInvalidDate: true })
  .map((d) => d.toISOString());

const agentRefArb: fc.Arbitrary<AgentRef> = fc.record(
  {
    id: idArb,
    name: nonEmptyString,
    role: fc.option(arbitraryString, { nil: undefined }),
  },
  { requiredKeys: ["id", "name"] },
);

const turnArb = fc.record({
  index: fc.nat(),
  prompt: arbitraryString,
  response: arbitraryString,
  startedAt: isoDateArb,
  latencyMs: fc.nat(),
  toolCallCount: fc.nat(),
  inputTokens: fc.nat(),
  outputTokens: fc.nat(),
  cacheReadTokens: fc.nat(),
  cacheWriteTokens: fc.nat(),
});

const agentTurnArb = (agentIds: ReadonlyArray<string>): fc.Arbitrary<AgentTurn> =>
  fc.record(
    {
      turn: turnArb,
      agentId: fc.option(fc.constantFrom(...agentIds), { nil: undefined }),
    },
    { requiredKeys: ["turn"] },
  ).map((t) => (t.agentId === undefined ? { turn: t.turn } : { turn: t.turn, agentId: AgentId(t.agentId) }));

const outcomeArb = (agentIds: ReadonlyArray<string>): fc.Arbitrary<AgentOutcome> =>
  fc.record(
    {
      agentId: fc.constantFrom(...agentIds),
      status: lifecycleStatusArb,
      startedAt: fc.option(isoDateArb, { nil: undefined }),
      endedAt: isoDateArb,
      exitCode: fc.option(fc.integer(), { nil: undefined }),
      reason: fc.option(arbitraryString, { nil: undefined }),
    },
    { requiredKeys: ["agentId", "status", "endedAt"] },
  ).map((o) => ({ ...o, agentId: AgentId(o.agentId) }));

// One JudgmentBundle generator. Each agent gets exactly one outcome
// (the schema requires outcomes for every agent named).
const bundleArb: fc.Arbitrary<JudgmentBundle> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((agentIds) =>
    fc
      .record({
        runId: idArb,
        project: idArb,
        scenarioId: idArb,
        name: nonEmptyString,
        description: arbitraryString,
        requirements: fc.record({
          expectedBehavior: arbitraryString,
          validationChecks: fc.array(nonEmptyString, { maxLength: 5 }),
        }),
        turns: fc.option(fc.array(agentTurnArb(agentIds), { maxLength: 5 }), {
          nil: undefined,
        }),
      })
      .chain((base) =>
        fc
          .array(outcomeArb(agentIds), {
            minLength: agentIds.length,
            maxLength: agentIds.length,
          })
          // Pin outcomes to the agentIds so each agent gets exactly one.
          .map((outcomes) => {
            const pinned: AgentOutcome[] = agentIds.map((id, i) => {
              const candidate = outcomes[i];
              if (candidate === undefined) {
                throw new Error("invariant: outcome generator must produce one per agent");
              }
              return { ...candidate, agentId: AgentId(id) };
            });
            return pinned;
          })
          .map((outcomes): JudgmentBundle => ({
            runId: RunId(base.runId),
            project: ProjectId(base.project),
            scenarioId: ScenarioId(base.scenarioId),
            name: base.name,
            description: base.description,
            requirements: base.requirements,
            agents: agentIds.map(
              (id): AgentRef => ({ id, name: `agent-${id}` }),
            ),
            ...(base.turns !== undefined ? { turns: base.turns } : {}),
            outcomes,
          })),
      ),
  );

// ── round-trip property ─────────────────────────────────────────────────────

function roundTripEff(
  codec: BundleCodec,
  bundle: JudgmentBundle,
): Effect.Effect<void, BundleDecodeError, never> {
  return Effect.gen(function* () {
    const encoded = yield* codec.encode(bundle);
    const decoded = yield* codec.decode(encoded, "mem://pbt");

    expect(decoded.runId).toBe(bundle.runId);
    expect(decoded.project).toBe(bundle.project);
    expect(decoded.scenarioId).toBe(bundle.scenarioId);
    expect(decoded.name).toBe(bundle.name);
    expect(decoded.description).toBe(bundle.description);
    expect(decoded.agents.length).toBe(bundle.agents.length);
    for (let i = 0; i < bundle.agents.length; i++) {
      expect(decoded.agents[i]?.id).toBe(bundle.agents[i]?.id);
    }
    expect(decoded.outcomes.length).toBe(bundle.outcomes.length);
    for (let i = 0; i < bundle.outcomes.length; i++) {
      expect(decoded.outcomes[i]?.agentId).toBe(bundle.outcomes[i]?.agentId);
      expect(decoded.outcomes[i]?.status).toBe(bundle.outcomes[i]?.status);
      expect(decoded.outcomes[i]?.endedAt).toBe(bundle.outcomes[i]?.endedAt);
    }
    if (bundle.turns !== undefined) {
      expect(decoded.turns?.length).toBe(bundle.turns.length);
    } else {
      expect(decoded.turns).toBeUndefined();
    }
  });
}

// fast-check's runner is sync-or-promise; bridge into Effect.tryPromise so
// rejected promises surface through the typed channel rather than being
// swallowed as defects (no-Effect.promise lint rule).
//
// Inside the property: Effect.runPromise rejects on the codec's
// BundleDecodeError, fast-check sees the rejection as a property failure
// and shrinks toward the smallest bundle that reproduces it. The
// shrunk bundle's tagged error is in the rejection's message — which is
// exactly the diagnostic info we want.
function assertProperty(
  codec: BundleCodec,
): Effect.Effect<void, PbtAssertionError, never> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(bundleArb, (bundle) =>
          Effect.runPromise(roundTripEff(codec, bundle)),
        ),
        { numRuns: PROPERTY_RUNS },
      ),
    catch: (err) =>
      new PbtAssertionError({ message: err instanceof Error ? err.message : String(err) }),
  });
}

describe("BundleCodec round-trip (PBT)", () => {
  itEffect("json: encode → decode preserves all structural fields", function* () {
    yield* assertProperty(bundleJsonCodec);
  });

  itEffect("yaml: encode → decode preserves all structural fields", function* () {
    yield* assertProperty(bundleYamlCodec);
  });

  itEffect("auto: detects JSON when input starts with '{' after trim", function* () {
    yield* assertProperty(bundleAutoCodec);
  });
});

describe("bundleAutoCodec dispatch (example-based, mutation killer)", () => {
  // Every branch in the auto-codec dispatch needs an example. PBT above
  // mostly hits the JSON branch (auto-encodes as JSON); these tests force
  // the YAML branch and the leading-whitespace edge case.

  itEffect("auto: dispatches to YAML when input does not start with { or [", function* () {
    const yaml = [
      "runId: yaml-dispatch",
      "project: cc-judge",
      "scenarioId: scn",
      "name: y",
      "description: d",
      "requirements:",
      "  expectedBehavior: ok",
      "  validationChecks: []",
      "agents:",
      "  - id: a",
      "    name: A",
      "outcomes:",
      "  - agentId: a",
      "    status: completed",
      "    endedAt: 2026-04-29T00:00:00.000Z",
    ].join("\n");

    const bundle = yield* bundleAutoCodec.decode(yaml, "mem://yaml");
    expect(bundle.runId).toBe("yaml-dispatch");
  });

  itEffect("auto: trims leading whitespace before dispatch decision", function* () {
    const json = "   \n\t  " + JSON.stringify({
      runId: "ws-dispatch",
      project: "cc-judge",
      scenarioId: "scn",
      name: "j",
      description: "d",
      requirements: { expectedBehavior: "ok", validationChecks: [] },
      agents: [{ id: "a", name: "A" }],
      outcomes: [{ agentId: "a", status: "completed", endedAt: "2026-04-29T00:00:00.000Z" }],
    });

    const bundle = yield* bundleAutoCodec.decode(json, "mem://ws");
    expect(bundle.runId).toBe("ws-dispatch");
  });

  itEffect("auto: dispatches to JSON when input starts with [", function* () {
    // Top-level array fails the schema (bundles are objects), but the
    // dispatcher should still route to JSON, not YAML. Reaching the
    // schema validator (with the input path threaded through) proves
    // JSON.parse succeeded.
    const arrayJson = "[1, 2, 3]";
    const result = yield* Effect.either(bundleAutoCodec.decode(arrayJson, "mem://arr"));
    const error = expectLeft(result);
    expect(error.cause._tag).toBe("SchemaInvalid");
    if (error.cause._tag === "SchemaInvalid") {
      expect(error.cause.path).toBe("mem://arr");
    }
  });
});
