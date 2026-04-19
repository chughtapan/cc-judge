import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scenarioLoader } from "../src/core/scenario.js";
import { itEffect } from "./support/effect.js";

const EITHER_LEFT = "Left" as const;
const SCENARIO_ID_HELLO_WORLD = "hello-world";
const VALIDATION_CHECK_SAYS_HELLO = "says hello";
const SCENARIO_IDS_AB = ["scen-a", "scen-b"] as const;

function tmpScenarioDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-judge-scenario-"));
}

describe("scenarioLoader.loadFromYaml", () => {
  itEffect("decodes a valid YAML scenario", function* () {
    const yaml = `
id: hello-world
name: Hello World
description: Agent prints hello world
setupPrompt: Say hello to the world
expectedBehavior: The agent responds with a greeting
validationChecks:
  - says hello
`;
    const scenario = yield* scenarioLoader.loadFromYaml(yaml, "mem://hello");
    expect(scenario.id).toBe(SCENARIO_ID_HELLO_WORLD);
    expect(scenario.validationChecks).toEqual([VALIDATION_CHECK_SAYS_HELLO]);
  });

  itEffect("rejects YAML missing required fields", function* () {
    const yaml = "id: foo\nname: Foo\n";
    const result = yield* Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://bad"));
    expect(result._tag).toBe(EITHER_LEFT);
  });
});

describe("scenarioLoader.loadFromPath", () => {
  itEffect("loads a directory of YAML scenarios and enforces unique ids", function* () {
    const dir = tmpScenarioDir();
    const a = `
id: scen-a
name: A
description: first
setupPrompt: do A
expectedBehavior: produces A
validationChecks:
  - A produced
`;
    const b = `
id: scen-b
name: B
description: second
setupPrompt: do B
expectedBehavior: produces B
validationChecks:
  - B produced
`;
    writeFileSync(path.join(dir, "a.yaml"), a, "utf8");
    writeFileSync(path.join(dir, "b.yaml"), b, "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(dir);
    expect(scenarios.map((s) => s.id).sort()).toEqual([...SCENARIO_IDS_AB]);
  });

  itEffect("rejects duplicate scenario ids across files", function* () {
    const dir = tmpScenarioDir();
    const yaml = `
id: dup
name: Dup
description: d
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
`;
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "a.yaml"), yaml, "utf8");
    writeFileSync(path.join(dir, "sub", "b.yaml"), yaml, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(dir));
    expect(result._tag).toBe(EITHER_LEFT);
  });

  itEffect("rejects workspace paths that are absolute or contain .. segments", function* () {
    const cases = [
      "/etc/passwd",
      "../../etc/passwd",
      "src/../../../etc/passwd",
      "foo/../bar",
    ];
    for (const badPath of cases) {
      const yaml = `
id: wp-${Buffer.from(badPath).toString("hex").slice(0, 8)}
name: wp
description: d
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
workspace:
  - path: ${JSON.stringify(badPath)}
    content: "x"
`;
      const result = yield* Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://wp"));
      expect(result._tag, `expected Left for ${badPath}`).toBe(EITHER_LEFT);
    }
  });

  itEffect("fails with GlobNoMatches on an empty pattern", function* () {
    const result = yield* Effect.either(
      scenarioLoader.loadFromPath("/tmp/cc-judge-nonexistent-*.yaml"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });
});
