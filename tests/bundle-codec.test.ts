import { describe, expect } from "vitest";
import { Effect } from "effect";
import { bundleAutoCodec } from "../src/emit/bundle-codec.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

describe("bundleAutoCodec", () => {
  itEffect("decodes a normalized YAML bundle", function* () {
    const payload = [
      "runId: bundle-run-1",
      "project: cc-judge",
      "scenarioId: bundle-scenario",
      "name: bundle",
      "description: normalized bundle",
      "requirements:",
      "  expectedBehavior: judge the bundle",
      "  validationChecks:",
      "    - bundle reaches the judge",
      "agents:",
      "  - id: agent-1",
      "    name: Agent One",
      "outcomes:",
      "  - agentId: agent-1",
      "    status: completed",
      "    endedAt: 2026-04-19T00:01:40.000Z",
    ].join("\n");

    const bundle = yield* bundleAutoCodec.decode(payload, "mem://bundle.yaml");

    expect(bundle.runId).toBe("bundle-run-1");
    expect(bundle.project).toBe("cc-judge");
    expect(bundle.outcomes[0]?.agentId).toBe("agent-1");
  });

  itEffect("rejects malformed bundles", function* () {
    const payload = JSON.stringify({
      runId: "bundle-run-1",
      project: "cc-judge",
      scenarioId: "bundle-scenario",
      name: "bundle",
      description: "missing outcomes",
      requirements: {
        expectedBehavior: "judge the bundle",
        validationChecks: ["bundle reaches the judge"],
      },
      agents: [{ id: "agent-1", name: "Agent One" }],
    });

    const result = yield* Effect.either(bundleAutoCodec.decode(payload, "mem://broken.json"));

    expect(result._tag).toBe(EITHER_LEFT);
  });
});
