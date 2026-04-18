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
axis: principle-3-typed-errors
setupPrompt: Say hello to the world
expectedBehavior: The agent responds with a greeting
validationChecks:
  - says hello
`;
    const scenario = await Effect.runPromise(scenarioLoader.loadFromYaml(yaml, "mem://hello"));
    expect(scenario.id).toBe("hello-world");
    expect(scenario.axis).toBe("principle-3-typed-errors");
    expect(scenario.validationChecks).toEqual(["says hello"]);
  });

  it("rejects YAML missing required fields", async () => {
    const yaml = "id: foo\nname: Foo\n";
    const result = await Effect.runPromise(
      Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://bad")),
    );
    expect(result._tag).toBe("Left");
  });

  it("rejects YAML missing the required axis field", async () => {
    const yaml = `
id: no-axis
name: NoAxis
description: missing axis
setupPrompt: do it
expectedBehavior: done
validationChecks: [done]
`;
    const result = await Effect.runPromise(
      Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://no-axis")),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.cause._tag).toBe("SchemaInvalid");
    }
  });

  it("rejects YAML whose axis value is not in the enumerated set", async () => {
    const cases = [
      "principle-9-nonexistent",
      "principle-3",
      "Principle-3-typed-errors",
      "routing",
      "",
    ];
    for (const badAxis of cases) {
      const yaml = `
id: bad-axis-${Buffer.from(badAxis).toString("hex").slice(0, 8) || "empty"}
name: BadAxis
description: invalid axis value
axis: ${JSON.stringify(badAxis)}
setupPrompt: do it
expectedBehavior: done
validationChecks: [done]
`;
      const result = await Effect.runPromise(
        Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://bad-axis")),
      );
      expect(result._tag, `expected Left for axis=${badAxis}`).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.cause._tag).toBe("SchemaInvalid");
      }
    }
  });

  it("accepts every enumerated axis literal", async () => {
    const axes = [
      "principle-1-types-beat-tests",
      "principle-2-validate-at-boundaries",
      "principle-3-typed-errors",
      "principle-4-exhaustiveness",
      "principle-5-junior-dev-rule",
      "principle-6-budget-gate",
      "principle-7-brake",
      "principle-8-ratchet",
      "modality-routing",
      "artifact-discipline",
      "debt-multiplier",
    ];
    for (const axis of axes) {
      const yaml = `
id: ok-${axis}
name: OK
description: valid axis
axis: ${axis}
setupPrompt: do it
expectedBehavior: done
validationChecks: [done]
`;
      const scenario = await Effect.runPromise(scenarioLoader.loadFromYaml(yaml, "mem://ok"));
      expect(scenario.axis).toBe(axis);
    }
  });
});

describe("scenarioLoader.loadFromPath", () => {
  it("loads a directory of YAML scenarios and enforces unique ids", async () => {
    const dir = tmpScenarioDir();
    const a = `
id: scen-a
name: A
description: first
axis: principle-1-types-beat-tests
setupPrompt: do A
expectedBehavior: produces A
validationChecks:
  - A produced
`;
    const b = `
id: scen-b
name: B
description: second
axis: modality-routing
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
axis: debt-multiplier
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

  it("rejects workspace paths that are absolute or contain .. segments", async () => {
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
axis: artifact-discipline
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
workspace:
  - path: ${JSON.stringify(badPath)}
    content: "x"
`;
      const result = await Effect.runPromise(
        Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://wp")),
      );
      expect(result._tag, `expected Left for ${badPath}`).toBe("Left");
    }
  });

  it("fails with GlobNoMatches on an empty pattern", async () => {
    const result = await Effect.runPromise(
      Effect.either(scenarioLoader.loadFromPath("/tmp/cc-judge-nonexistent-*.yaml")),
    );
    expect(result._tag).toBe("Left");
  });
});
