import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scenarioLoader } from "../src/core/scenario.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

const SCENARIO_ID_HELLO_WORLD = "hello-world";
const VALIDATION_CHECK_SAYS_HELLO = "says hello";
const SCENARIO_IDS_AB = ["scen-a", "scen-b"] as const;
const TS_SCEN_ID = "ts-scen";
const MTS_SCEN_ID = "mts-scen";
const JS_SCEN_ID = "js-scen";
const MJS_SCEN_ID = "mjs-scen";
const NO_EXPORTS_MESSAGE_FRAGMENT = "no exports";
const EXPORT_SHAPE_MESSAGE_FRAGMENT = "must export `default` or `scenario`";
const DETERMINISTIC_CHECK_MESSAGE_FRAGMENT = "must be functions";
const UNSUPPORTED_EXT_FRAGMENT = "unsupported extension";
const LOAD_ERROR_TAG = "LoadError";

function tmpScenarioDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-judge-scenario-"));
}

const MINIMAL_TS_SCENARIO_BODY = `{
  id: "${TS_SCEN_ID}",
  name: "TS",
  description: "a ts scenario",
  setupPrompt: "p",
  expectedBehavior: "e",
  validationChecks: ["c"],
}`;

const YAML_MINIMAL = (id: string) => `
id: ${id}
name: ${id}
description: d
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
`;

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

  itEffect("fails with FileNotFound on a non-glob non-existent path", function* () {
    const missing = path.join(os.tmpdir(), `cc-judge-missing-${Date.now()}.yaml`);
    const result = yield* Effect.either(scenarioLoader.loadFromPath(missing));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(LOAD_ERROR_TAG);
      expect(result.left.cause._tag).toBe("FileNotFound");
    }
  });

  itEffect("loads a single YAML file when given an absolute file path (not a directory)", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "single.yaml");
    writeFileSync(file, YAML_MINIMAL("single-scen"), "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(file);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe("single-scen");
  });

  itEffect("rejects files with unsupported extensions", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "scen.txt");
    writeFileSync(file, "id: foo", "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("ParseFailure");
      if (result.left.cause._tag === "ParseFailure") {
        expect(result.left.cause.message).toContain(UNSUPPORTED_EXT_FRAGMENT);
      }
    }
  });

  itEffect("loads a TS scenario via default export", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "scen.ts");
    writeFileSync(file, `export default ${MINIMAL_TS_SCENARIO_BODY};\n`, "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(file);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe(TS_SCEN_ID);
  });

  itEffect("loads a TS scenario via named `scenario` export", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "named.ts");
    const body = MINIMAL_TS_SCENARIO_BODY.replace(TS_SCEN_ID, "named-ts-scen");
    writeFileSync(file, `export const scenario = ${body};\n`, "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(file);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe("named-ts-scen");
  });

  itEffect("carries through function-valued deterministicPassCheck/failCheck fields", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "checks.ts");
    const body = MINIMAL_TS_SCENARIO_BODY.replace(TS_SCEN_ID, "checks-ts");
    writeFileSync(
      file,
      `export default { ...${body}, deterministicPassCheck: () => true, deterministicFailCheck: () => false };\n`,
      "utf8",
    );
    const scenarios = yield* scenarioLoader.loadFromPath(file);
    expect(typeof scenarios[0].deterministicPassCheck).toBe("function");
    expect(typeof scenarios[0].deterministicFailCheck).toBe("function");
  });

  itEffect("rejects TS module with no exports (empty module)", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "empty.ts");
    writeFileSync(file, "export {};\n", "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "ParseFailure") {
      expect(result.left.cause.message).toContain(EXPORT_SHAPE_MESSAGE_FRAGMENT);
    }
  });

  itEffect("rejects TS scenario whose export is not an object", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "str.ts");
    writeFileSync(file, `export default "not-an-object";\n`, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "ParseFailure") {
      expect(result.left.cause.message).toContain("not an object");
    }
  });

  itEffect("rejects TS scenario with non-function deterministicPassCheck", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "bad-check.ts");
    const body = MINIMAL_TS_SCENARIO_BODY.replace(TS_SCEN_ID, "bad-check");
    writeFileSync(file, `export default { ...${body}, deterministicPassCheck: 42 };\n`, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.join(" ")).toContain(DETERMINISTIC_CHECK_MESSAGE_FRAGMENT);
    }
  });
});
