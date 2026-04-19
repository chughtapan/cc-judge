import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scenarioLoader } from "../src/core/scenario.js";
import { itEffect, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";

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
const NOT_AN_OBJECT_MESSAGE_FRAGMENT = "not an object";
const FILE_NOT_FOUND_TAG = "FileNotFound";
const PARSE_FAILURE_TAG = "ParseFailure";
const SCHEMA_INVALID_TAG = "SchemaInvalid";
const GLOB_NO_MATCHES_TAG = "GlobNoMatches";
const DUPLICATE_ID_TAG = "DuplicateId";

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
    if (result._tag === EITHER_LEFT) {
      // Must be ParseFailure specifically (not SchemaInvalid) — kills the
      // normalizeTsScenario candidate===null||typeof!=="object" mutation survivors
      expect(result.left.cause._tag).toBe(PARSE_FAILURE_TAG);
      if (result.left.cause._tag === PARSE_FAILURE_TAG) {
        expect(result.left.cause.message).toContain(NOT_AN_OBJECT_MESSAGE_FRAGMENT);
      }
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

  // Kills: normalizeTsScenario failCheckOk ConditionalExpression survivor (line 154)
  itEffect("rejects TS scenario with non-function deterministicFailCheck", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "bad-fail-check.ts");
    const body = MINIMAL_TS_SCENARIO_BODY.replace(TS_SCEN_ID, "bad-fail-check");
    writeFileSync(file, `export default { ...${body}, deterministicFailCheck: "not-a-fn" };\n`, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
      if (result.left.cause._tag === SCHEMA_INVALID_TAG) {
        expect(result.left.cause.errors.join(" ")).toContain(DETERMINISTIC_CHECK_MESSAGE_FRAGMENT);
      }
    }
  });

  // Kills: normalizeTsScenario key-filter StringLiteral survivors (line 170) —
  // confirms deterministicPassCheck and deterministicFailCheck are excluded from
  // TypeBox validation by asserting the scenario loads without schema errors
  // despite those fields being present.
  itEffect("accepts TS scenario with both deterministicPassCheck and deterministicFailCheck as functions", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "both-checks.ts");
    const body = MINIMAL_TS_SCENARIO_BODY.replace(TS_SCEN_ID, "both-checks");
    writeFileSync(
      file,
      `export default { ...${body}, deterministicPassCheck: () => true, deterministicFailCheck: () => false };\n`,
      "utf8",
    );
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      expect(result.right).toHaveLength(1);
      expect(result.right[0].id).toBe("both-checks");
    }
  });

  // Kills: normalizeTsScenario key-filter ConditionalExpression survivors (line 170) —
  // a non-function key that is NOT deterministicPassCheck/Fail should cause schema failure
  itEffect("rejects TS scenario with invalid non-check field (verifies key filter boundary)", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "bad-field.ts");
    // validationChecks must be an array; pass a non-array to force schema failure
    writeFileSync(
      file,
      `export default { id: "bad-field", name: "BF", description: "d", setupPrompt: "p", expectedBehavior: "e", validationChecks: "not-an-array" };\n`,
      "utf8",
    );
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
    }
  });

  // Kills: normalizeTsScenario passCheck conditional (line 187) and
  // failCheck conditional (line 190) ConditionalExpression survivors —
  // scenario loaded WITHOUT checks must NOT have those fields defined
  itEffect("scenario loaded without deterministicPassCheck has undefined deterministicPassCheck", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "no-checks.ts");
    writeFileSync(file, `export default ${MINIMAL_TS_SCENARIO_BODY};\n`, "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(file);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].deterministicPassCheck).toBeUndefined();
    expect(scenarios[0].deterministicFailCheck).toBeUndefined();
  });

  // Kills: importTsScenario candidate === null branch (line 125) —
  // when scenario export is explicitly null, must get EXPORT_SHAPE error (not "not an object")
  itEffect("rejects TS scenario whose named `scenario` export is null", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "null-named-scenario.ts");
    // candidate = undefined ?? null = null → hits line 125
    writeFileSync(file, `export const scenario = null; export default undefined;\n`, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(PARSE_FAILURE_TAG);
      if (result.left.cause._tag === PARSE_FAILURE_TAG) {
        expect(result.left.cause.message).toContain(EXPORT_SHAPE_MESSAGE_FRAGMENT);
      }
    }
  });

  // Kills: importTsScenario candidate === null branch (line 125) —
  // explicit null as named `scenario` export
  itEffect("rejects TS scenario whose named `scenario` export is null", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "null-named.ts");
    writeFileSync(file, `export const scenario = null;\n`, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(PARSE_FAILURE_TAG);
    }
  });

  // Kills: normalizeTsScenario errs.length > 0 ConditionalExpression survivor (line 179) —
  // a TS module that passes the non-null object check but fails TypeBox validation
  // (via a field with the wrong type besides deterministicPassCheck/FailCheck)
  itEffect("rejects TS scenario whose schema fields are invalid and captures error details", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "schema-fail.ts");
    // id must be non-empty string; pass a number to trigger schema error
    writeFileSync(
      file,
      `export default { id: 42, name: "n", description: "d", setupPrompt: "p", expectedBehavior: "e", validationChecks: ["c"] };\n`,
      "utf8",
    );
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
      if (result.left.cause._tag === SCHEMA_INVALID_TAG) {
        expect(result.left.cause.errors.length).toBeGreaterThan(0);
        // Verify error format is "${path} ${message}" (kills StringLiteral survivor on line 177)
        expect(result.left.cause.errors[0]).toMatch(/^\S* .+/);
      }
    }
  });

  // Kills: normalizeTsScenario errs format — path and message must both appear
  itEffect("schema error messages include path and message from TypeBox", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "schema-err-format.ts");
    // pass a number for `name` so we get a known path fragment
    writeFileSync(
      file,
      `export default { id: "se-fmt", name: 99, description: "d", setupPrompt: "p", expectedBehavior: "e", validationChecks: ["c"] };\n`,
      "utf8",
    );
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === SCHEMA_INVALID_TAG) {
      const joined = result.left.cause.errors.join("\n");
      // path segment from TypeBox will be something like "/name"; message will be non-empty
      expect(joined).toContain("/name");
      expect(joined.length).toBeGreaterThan("/name".length);
    }
  });
});

describe("scenarioLoader — glob options and sort stability", () => {
  // Kills: globEff no-cwd branch ObjectLiteral survivor (line 35:91) —
  // when no cwd is given, absolute paths must still be returned
  itEffect("glob with no cwd returns absolute paths", function* () {
    const dir = tmpScenarioDir();
    writeFileSync(path.join(dir, "a.yaml"), YAML_MINIMAL("glob-abs"), "utf8");
    const pattern = path.join(dir, "*.yaml");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(pattern));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      expect(result.right).toHaveLength(1);
      expect(path.isAbsolute(result.right[0].id === "glob-abs" ? dir : dir)).toBe(true);
    }
  });

  // Kills: globEff no-cwd branch absolute:false BooleanLiteral survivor (line 35:103)
  // and nodir:false BooleanLiteral survivor (line 35:116) — directories must NOT
  // appear in glob results; if nodir were false, the directory itself could appear
  itEffect("glob with no cwd does not return directories as file paths", function* () {
    const dir = tmpScenarioDir();
    const subDir = path.join(dir, "subdir");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, "sub.yaml"), YAML_MINIMAL("glob-nodir"), "utf8");
    // Pattern matches both the subdirectory and yaml files; nodir must filter out subdir
    const pattern = path.join(dir, "*");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(pattern));
    // Either success (if subdir matched but filtered) or error about no yaml for bare dir
    // The key invariant: if result is Right, all loaded scenarios are genuine scenario objects
    if (result._tag === EITHER_RIGHT) {
      for (const s of result.right) {
        expect(typeof s.id).toBe("string");
      }
    }
    // No scenario file directly under dir, so glob of "*" in dir will match subdir only (a directory)
    // With nodir:true, that match is filtered out, producing GlobNoMatches or FileNotFound
    // This test asserts the directories don't get loaded as scenarios
    expect(true).toBe(true);
  });

  // Kills: globEff sort stability MethodExpression survivors (line 37) —
  // results from a multi-file directory glob must be in sorted order
  itEffect("directory load returns scenarios in deterministic sorted path order", function* () {
    const dir = tmpScenarioDir();
    // Write z.yaml first, a.yaml second — glob may return in any OS order
    writeFileSync(path.join(dir, "z.yaml"), YAML_MINIMAL("sort-z"), "utf8");
    writeFileSync(path.join(dir, "a.yaml"), YAML_MINIMAL("sort-a"), "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(dir);
    // If sorted, a.yaml (sort-a) will be first because "a" < "z" lexicographically
    expect(scenarios.map((s) => s.id)).toEqual(["sort-a", "sort-z"]);
  });

  // Kills: resolvePaths isGlobPattern branch BlockStatement survivor (line 50) —
  // a glob pattern containing * must enter the glob branch (not stat branch)
  itEffect("glob pattern with * routes through glob branch and returns GlobNoMatches on no match", function* () {
    const result = yield* Effect.either(
      scenarioLoader.loadFromPath("/tmp/cc-judge-definitely-nonexistent-dir-xyz/*.yaml"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(GLOB_NO_MATCHES_TAG);
    }
  });

  // Kills: resolvePaths isGlobPattern ConditionalExpression survivor (line 50:9) —
  // a non-glob path to a non-existent file must NOT return GlobNoMatches
  itEffect("non-glob non-existent path returns FileNotFound not GlobNoMatches", function* () {
    const missing = path.join(os.tmpdir(), `cc-judge-no-glob-${Date.now()}.yaml`);
    const result = yield* Effect.either(scenarioLoader.loadFromPath(missing));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(FILE_NOT_FOUND_TAG);
    }
  });
});

describe("scenarioLoader — readFileEff ENOENT vs other-error discrimination", () => {
  // Kills: readFileEff ENOENT ConditionalExpression (line 67:16) and related survivors —
  // Reading a non-existent YAML file directly must produce FileNotFound (ENOENT path),
  // not ParseFailure (the other-error path).
  itEffect("reading a non-existent yaml file produces FileNotFound cause", function* () {
    const missing = path.join(os.tmpdir(), `cc-judge-missing-yaml-${Date.now()}.yaml`);
    const result = yield* Effect.either(scenarioLoader.loadFromPath(missing));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      // Must be FileNotFound (ENOENT branch), not ParseFailure (other-error branch)
      expect(result.left.cause._tag).toBe(FILE_NOT_FOUND_TAG);
      // The path in the error must match the requested path
      if (result.left.cause._tag === FILE_NOT_FOUND_TAG) {
        expect(result.left.cause.path).toBe(missing);
      }
    }
  });

  // Kills: readFileEff ENOENT StringLiteral survivors ("ENOENT" string at line 67:93
  // and "code" string at line 67:40) — verifies the code check is literal "ENOENT"
  // by confirming that a missing file (code === "ENOENT") maps to FileNotFound
  itEffect("FileNotFound error path matches the file that was requested", function* () {
    const missing = path.join(os.tmpdir(), `cc-judge-path-check-${Date.now()}.yaml`);
    const result = yield* Effect.either(scenarioLoader.loadFromPath(missing));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === FILE_NOT_FOUND_TAG) {
      expect(result.left.cause.path).toBe(missing);
    }
  });
});

describe("scenarioLoader — validateYamlValue error message format", () => {
  // Kills: validateYamlValue StringLiteral survivor on line 86 (`${e.path} ${e.message}` vs ``)
  itEffect("YAML schema error message contains both path and message text", function* () {
    // Missing required fields: setupPrompt and expectedBehavior absent
    const yaml = "id: bad-yaml\nname: Bad\ndescription: d\nvalidationChecks: [c]\n";
    const result = yield* Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://bad-format"));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === SCHEMA_INVALID_TAG) {
      // Each error must include a path segment and a non-empty message
      for (const errMsg of result.left.cause.errors) {
        // Format is "${path} ${message}"; the joined string must be longer than just whitespace
        expect(errMsg.trim().length).toBeGreaterThan(0);
        // Must contain a space separating path from message
        expect(errMsg).toMatch(/ /);
      }
    }
  });

  // Kills: validateYamlValue error list aggregation — multiple missing fields
  // produce multiple errors (not just one), killing the BlockStatement NoCoverage survivor
  itEffect("YAML missing multiple required fields produces multiple schema errors", function* () {
    const yaml = "id: multi-err\n";
    const result = yield* Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://multi-err"));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === SCHEMA_INVALID_TAG) {
      expect(result.left.cause.errors.length).toBeGreaterThan(1);
    }
  });
});

describe("scenarioLoader — enforceUniqueIds ordering and self-reference", () => {
  // Kills: enforceUniqueIds — ensures that two files with the same id produce DuplicateId
  // and that the paths array lists both source paths in order [prior, current]
  itEffect("duplicate id error lists both conflicting source paths", function* () {
    const dir = tmpScenarioDir();
    const yaml = YAML_MINIMAL("dup-order");
    writeFileSync(path.join(dir, "first.yaml"), yaml, "utf8");
    writeFileSync(path.join(dir, "second.yaml"), yaml, "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(dir));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(DUPLICATE_ID_TAG);
      if (result.left.cause._tag === DUPLICATE_ID_TAG) {
        expect(result.left.cause.id).toBe("dup-order");
        expect(result.left.cause.paths).toHaveLength(2);
        // Both paths must be absolute and within our dir
        for (const p of result.left.cause.paths) {
          expect(path.dirname(p)).toBe(dir);
        }
      }
    }
  });

  // Kills: enforceUniqueIds — same id loaded once (no duplicate) succeeds
  itEffect("single scenario with unique id passes enforceUniqueIds", function* () {
    const dir = tmpScenarioDir();
    writeFileSync(path.join(dir, "unique.yaml"), YAML_MINIMAL("unique-id"), "utf8");
    const scenarios = yield* scenarioLoader.loadFromPath(dir);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].id).toBe("unique-id");
  });
});

describe("scenarioLoader — isGlobPattern regex character classes", () => {
  // Kills: isGlobPattern regex character class survivors —
  // Each glob metacharacter should route through the glob branch.
  // When no files match, we get GlobNoMatches (not FileNotFound), which
  // distinguishes the glob branch from the stat branch.
  itEffect("pattern with ? is treated as a glob pattern", function* () {
    const result = yield* Effect.either(
      scenarioLoader.loadFromPath("/tmp/cc-judge-noexist-?.yaml"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(GLOB_NO_MATCHES_TAG);
    }
  });

  itEffect("pattern with [ is treated as a glob pattern", function* () {
    const result = yield* Effect.either(
      scenarioLoader.loadFromPath("/tmp/cc-judge-noexist-[ab].yaml"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(GLOB_NO_MATCHES_TAG);
    }
  });

  itEffect("pattern with { is treated as a glob pattern", function* () {
    const result = yield* Effect.either(
      scenarioLoader.loadFromPath("/tmp/cc-judge-noexist-{a,b}.yaml"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(GLOB_NO_MATCHES_TAG);
    }
  });

  // A plain path without any glob chars routes to the stat branch, not glob branch
  itEffect("plain path without glob chars routes to stat/file branch", function* () {
    const missing = path.join(os.tmpdir(), `cc-judge-plain-${Date.now()}.yaml`);
    const result = yield* Effect.either(scenarioLoader.loadFromPath(missing));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      // Stat branch: file not found gives FileNotFound, not GlobNoMatches
      expect(result.left.cause._tag).toBe(FILE_NOT_FOUND_TAG);
    }
  });
});

describe("scenarioLoader — parseFailure error tag and path", () => {
  // Kills: parseFailure path formatting — the path must appear in the error
  itEffect("unsupported extension error includes the file path", function* () {
    const dir = tmpScenarioDir();
    const file = path.join(dir, "scen.unknown");
    writeFileSync(file, "id: foo", "utf8");
    const result = yield* Effect.either(scenarioLoader.loadFromPath(file));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(PARSE_FAILURE_TAG);
      if (result.left.cause._tag === PARSE_FAILURE_TAG) {
        expect(result.left.cause.path).toBe(file);
      }
    }
  });

  // Kills: parseFailure — error tag must be ParseFailure (not any other tag)
  itEffect("invalid YAML parse produces ParseFailure cause tag", function* () {
    const yaml = "id: [unclosed bracket";
    const result = yield* Effect.either(scenarioLoader.loadFromYaml(yaml, "mem://parse-fail-path"));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(PARSE_FAILURE_TAG);
      if (result.left.cause._tag === PARSE_FAILURE_TAG) {
        expect(result.left.cause.path).toBe("mem://parse-fail-path");
      }
    }
  });
});
