import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scenarioLoader } from "../src/core/scenario.js";

function tmpScenarioDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-judge-scenario-"));
}

describe("scenarioLoader.loadFromYaml", () => {
  it("decodes a valid YAML scenario", async () => {
    const yaml = `
id: hello-world
name: Hello World
description: Agent prints hello world
setupPrompt: Say hello to the world
expectedBehavior: The agent responds with a greeting
validationChecks:
  - says hello
`;
    const scenario = await Effect.runPromise(scenarioLoader.loadFromYaml(yaml, "mem://hello"));
    expect(scenario.id).toBe("hello-world");
    expect(scenario.validationChecks).toEqual(["says hello"]);
  });

  it("rejects YAML missing required fields", async () => {
    const yaml = "id: foo\nname: Foo\n";
    const result = await Effect.runPromise(
      Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://bad")),
    );
    expect(result._tag).toBe("Left");
  });
});

describe("scenarioLoader.loadFromPath", () => {
  it("loads a directory of YAML scenarios and enforces unique ids", async () => {
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
    const scenarios = await Effect.runPromise(scenarioLoader.loadFromPath(dir));
    expect(scenarios.map((s) => s.id).sort()).toEqual(["scen-a", "scen-b"]);
  });

  it("rejects duplicate scenario ids across files", async () => {
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
    const result = await Effect.runPromise(Effect.either(scenarioLoader.loadFromPath(dir)));
    expect(result._tag).toBe("Left");
  });

  it("fails with GlobNoMatches on an empty pattern", async () => {
    const result = await Effect.runPromise(
      Effect.either(scenarioLoader.loadFromPath("/tmp/cc-judge-nonexistent-*.yaml")),
    );
    expect(result._tag).toBe("Left");
  });
});
