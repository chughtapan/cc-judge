import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SubprocessRunner } from "../src/runner/index.js";
import { ScenarioId } from "../src/core/types.js";
import type { Scenario } from "../src/core/schema.js";

function makeScenario(): Scenario {
  return {
    id: ScenarioId("runner-verbose-flag"),
    name: "runner-verbose-flag",
    description: "test",
    setupPrompt: "noop",
    expectedBehavior: "noop",
    validationChecks: [],
  };
}

describe("SubprocessRunner default args", () => {
  it("includes --verbose in the spawned command", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario();
    const handle = await Effect.runPromise(runner.start(scenario));
    const turn = await Effect.runPromise(runner.turn(handle, "PROMPT-X", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toContain("--verbose");
    expect(turn.response).toContain("-p");
    expect(turn.response).toContain("--output-format");
    expect(turn.response).toContain("stream-json");
    expect(turn.response).toContain("PROMPT-X");
  });
});
