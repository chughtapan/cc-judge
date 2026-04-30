import { afterEach, describe, expect, vi } from "vitest";
import { Effect } from "effect";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeTempDir } from "./support/tmpdir.js";
import * as YAML from "yaml";
import { main } from "../src/app/cli.js";
import {
  PlanFilePath,
  compilePlannedHarnessDocuments,
  decodePlannedHarnessDocument,
  loadPlannedHarnessPath,
  runPlannedHarnessPath,
} from "../src/plans/index.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";
import { installDefaultEnvVar } from "./support/env.js";
import { captureStream } from "./support/streams.js";

installDefaultEnvVar("ANTHROPIC_API_KEY", "test-anthropic-api-key");

let capturedPlannedInputs: ReadonlyArray<unknown> | null = null;
let capturedHarnessRunOpts: Record<string, unknown> | null = null;

vi.mock("../src/app/pipeline.js", () => ({
  runPlans: vi.fn((inputs: ReadonlyArray<unknown>, opts: Record<string, unknown>) => {
    capturedPlannedInputs = inputs;
    capturedHarnessRunOpts = opts;
    return Effect.succeed({
      runs: [],
      summary: { total: inputs.length, passed: inputs.length, failed: 0, avgLatencyMs: 0 },
    });
  }),
}));

const EXIT_SUCCESS = 0;
const EXIT_FATAL = 2;

function writeHarnessModule(dir: string): string {
  const modulePath = path.join(dir, "fixture-harness.mjs");
  writeFileSync(
    modulePath,
    [
      "import { Effect } from 'effect';",
      "",
      "const fixtureHarness = {",
      "  load(args) {",
      "    return Effect.succeed({",
      "      plan: {",
      "        project: args.plan.project,",
      "        scenarioId: args.plan.scenarioId,",
      "        name: args.plan.name,",
      "        description: args.plan.description,",
      "        requirements: args.plan.requirements,",
      "        ...(args.plan.metadata !== undefined ? { metadata: args.plan.metadata } : {}),",
      "        agents: [",
      "          {",
      "            id: 'alpha',",
      "            name: 'Alpha',",
      "            artifact: { _tag: 'DockerImageArtifact', image: 'repo/alpha:latest' },",
      "            promptInputs: { payload: args.payload },",
      "          },",
      "        ],",
      "      },",
      "      harness: {",
      "        name: 'fixture-harness',",
      "        run: () => Effect.void,",
      "      },",
      "    });",
      "  },",
      "};",
      "",
      "export default fixtureHarness;",
      "export { fixtureHarness };",
      "",
    ].join("\n"),
    "utf8",
  );
  return modulePath;
}

function planYaml(harnessModulePath: string, overrides: {
  readonly scenarioId?: string;
  readonly exportName?: string;
} = {}): string {
  return YAML.stringify({
    project: "cc-judge",
    scenarioId: overrides.scenarioId ?? "planned-harness-smoke",
    name: "planned-harness-smoke",
    description: "exercise planned harness ingress",
    requirements: {
      expectedBehavior: "complete one prompt",
      validationChecks: ["summary should be emitted"],
    },
    harness: {
      module: harnessModulePath,
      ...(overrides.exportName !== undefined ? { export: overrides.exportName } : {}),
      payload: {
        prompts: ["Fix the failing test"],
      },
    },
  });
}

function writePlanFile(dir: string, name: string, yaml: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, yaml, "utf8");
  return filePath;
}

afterEach(() => {
  capturedPlannedInputs = null;
  capturedHarnessRunOpts = null;
});

describe("planned harness schema", () => {
  itEffect("decodes one planned-harness document from YAML", function* () {
    const decoded = yield* decodePlannedHarnessDocument(
      YAML.parse(
        planYaml("./fixture-harness.mjs"),
      ),
      PlanFilePath("mem://planned-harness.yaml"),
    );

    expect(decoded.project).toBe("cc-judge");
    expect(decoded.scenarioId).toBe("planned-harness-smoke");
    expect(decoded.harness.module).toBe("./fixture-harness.mjs");
    expect(decoded.harness.export).toBeUndefined();
  });

  itEffect("rejects non-document roots with TopLevelNotDocument", function* () {
    const result = yield* Effect.either(
      decodePlannedHarnessDocument(
        [YAML.parse(planYaml("./fixture-harness.mjs"))],
        PlanFilePath("mem://array-root.yaml"),
      ),
    );

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("TopLevelNotDocument");
      expect(result.left.cause.path).toBe("mem://array-root.yaml");
    }
  });
});

describe("planned harness loader", () => {
  itEffect("returns FileNotFound for a missing non-glob path", function* () {
    const result = yield* Effect.either(
      loadPlannedHarnessPath(path.join(os.tmpdir(), `cc-judge-missing-plan-${Date.now()}.yaml`)),
    );

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("FileNotFound");
    }
  });

  itEffect("returns GlobNoMatches for an unmatched glob", function* () {
    const result = yield* Effect.either(
      loadPlannedHarnessPath(path.join(os.tmpdir(), "cc-judge-no-plans-*.yaml")),
    );

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("GlobNoMatches");
    }
  });

  itEffect("rejects duplicate scenario ids across matched files", function* () {
    const dir = makeTempDir("plans-dup");
    const harnessModulePath = writeHarnessModule(dir);
    writePlanFile(dir, "a.yaml", planYaml(harnessModulePath, { scenarioId: "duplicate-scenario" }));
    writePlanFile(dir, "b.yaml", planYaml(harnessModulePath, { scenarioId: "duplicate-scenario" }));

    const result = yield* Effect.either(loadPlannedHarnessPath(path.join(dir, "*.yaml")));

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("DuplicateScenarioId");
      expect(result.left.cause.scenarioId).toBe("duplicate-scenario");
      expect(result.left.cause.paths[0]).toContain(path.join(dir, "a.yaml"));
      expect(result.left.cause.paths[1]).toContain(path.join(dir, "b.yaml"));
    }
  });
});

describe("planned harness compiler + cli ingress", () => {
  itEffect("compiles loaded documents into planned run inputs", function* () {
    const dir = makeTempDir("plans-compile");
    const harnessModulePath = writeHarnessModule(dir);
    const sourcePath = writePlanFile(dir, "compiled.yaml", planYaml(harnessModulePath));
    const documents = yield* loadPlannedHarnessPath(sourcePath);
    const compiled = yield* compilePlannedHarnessDocuments(documents);

    expect(compiled[0]?.sourcePath).toBe(sourcePath);
    expect(compiled[0]?.input.plan.scenarioId).toBe("planned-harness-smoke");
    expect(compiled[0]?.input.harness.name).toBe("fixture-harness");
    expect(compiled[0]?.input.plan.agents[0]?.promptInputs).toMatchObject({
      payload: {
        prompts: ["Fix the failing test"],
      },
    });
  });

  itEffect("runs a planned-harness path through the existing runPlans pipeline", function* () {
    const dir = makeTempDir("plans-run");
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "single.yaml", planYaml(harnessModulePath));
    const resultsDir = makeTempDir("plans-out");

    const report = yield* runPlannedHarnessPath(planPath, { resultsDir });

    expect(report.summary.total).toBe(1);
    expect(capturedPlannedInputs).toHaveLength(1);
    const input = capturedPlannedInputs?.[0] as {
      readonly plan: { readonly scenarioId: string };
      readonly harness: { readonly name: string };
    };
    expect(input.plan.scenarioId).toBe("planned-harness-smoke");
    expect(input.harness.name).toBe("fixture-harness");
    expect(capturedHarnessRunOpts?.["resultsDir"]).toBe(resultsDir);
  });

  itEffect("forwards totalTimeoutMs into the planned-harness run pipeline", function* () {
    const dir = makeTempDir("plans-timeout");
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "timeout.yaml", planYaml(harnessModulePath));
    const resultsDir = makeTempDir("plans-timeout-out");

    yield* runPlannedHarnessPath(planPath, {
      resultsDir,
      totalTimeoutMs: 12_345,
    });

    expect(capturedHarnessRunOpts?.["totalTimeoutMs"]).toBe(12_345);
  });

  itEffect("dispatches `run` through the CLI with explicit harness YAML", function* () {
    const dir = makeTempDir("plans-cli");
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "cli.yaml", planYaml(harnessModulePath));
    const resultsDir = makeTempDir("plans-cli-out");

    const code = yield* main([
      "run",
      planPath,
      "--runtime",
      "subprocess",
      "--bin",
      "/bin/echo",
      "--results",
      resultsDir,
      "--log-level",
      "error",
    ]);

    expect(code).toBe(EXIT_SUCCESS);
    expect(capturedHarnessRunOpts?.["runtime"]).toMatchObject({ kind: "subprocess" });
    expect(capturedPlannedInputs).toHaveLength(1);
  });

  itEffect("returns exit 2 when harness export is missing", function* () {
    const dir = makeTempDir("plans-missing-export");
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(
      dir,
      "missing-export.yaml",
      planYaml(harnessModulePath, { exportName: "missingHarness" }),
    );

    const code = yield* main(["run", planPath, "--log-level", "error"]);

    expect(code).toBe(EXIT_FATAL);
  });

  itEffect("returns exit 2 with a parse error from the harness plan loader", function* () {
    const dir = makeTempDir("plans-invalid");
    const badPath = writePlanFile(dir, "broken.yaml", "harness:\n  module: [\n");
    const stderr = captureStream(process.stderr);

    const code = yield* Effect.ensuring(
      main(["run", badPath, "--log-level", "error"]),
      Effect.sync(stderr.restore),
    );

    expect(code).toBe(EXIT_FATAL);
    expect(stderr.chunks.join("")).toContain("ParseFailure");
  });

  // P0-7 regression tests: a misbehaving user harness must NOT crash the
  // cc-judge process. All three failure modes must produce a typed
  // PlannedHarnessIngressError (HarnessPlanLoadFailed cause).

  itEffect("compiler maps a synchronous throw from load() to a typed error", function* () {
    const dir = makeTempDir("plans-load-throw");
    const harnessModulePath = path.join(dir, "throw-harness.mjs");
    writeFileSync(
      harnessModulePath,
      [
        "export default {",
        "  load() {",
        "    throw new Error('intentional sync throw from load()');",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const planPath = writePlanFile(dir, "throw.yaml", planYaml(harnessModulePath));

    const documents = yield* loadPlannedHarnessPath(planPath);
    const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("HarnessPlanLoadFailed");
      if (result.left.cause._tag === "HarnessPlanLoadFailed") {
        expect(result.left.cause.message).toContain("threw synchronously");
        expect(result.left.cause.message).toContain("intentional sync throw");
      }
    }
  });

  itEffect(
    "compiler maps a non-Effect return value from load() to a typed error",
    function* () {
      const dir = makeTempDir("plans-load-nonEffect");
      const harnessModulePath = path.join(dir, "promise-harness.mjs");
      writeFileSync(
        harnessModulePath,
        [
          "export default {",
          "  async load() {",
          "    return { plan: {}, harness: { name: 'x', run: () => undefined } };",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      const planPath = writePlanFile(dir, "promise.yaml", planYaml(harnessModulePath));

      const documents = yield* loadPlannedHarnessPath(planPath);
      const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

      expect(result._tag).toBe(EITHER_LEFT);
      if (result._tag === EITHER_LEFT) {
        expect(result.left.cause._tag).toBe("HarnessPlanLoadFailed");
        if (result.left.cause._tag === "HarnessPlanLoadFailed") {
          expect(result.left.cause.message).toContain("must return an Effect");
          expect(result.left.cause.message).toContain("Promise");
        }
      }
    },
  );

  // Three short fixtures that exercise the remaining error-message branches
  // for non-Effect return values: null, primitive (number), plain object
  // without a .then. Each kills the corresponding ternary branch in
  // compiler.ts that produces the "got <X>" suffix.

  itEffect("compiler error names 'null' when load() returns null", function* () {
    const dir = makeTempDir("plans-load-null");
    const harnessModulePath = path.join(dir, "null-harness.mjs");
    writeFileSync(
      harnessModulePath,
      ["export default {", "  load() { return null; },", "};", ""].join("\n"),
      "utf8",
    );
    const planPath = writePlanFile(dir, "null.yaml", planYaml(harnessModulePath));

    const documents = yield* loadPlannedHarnessPath(planPath);
    const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "HarnessPlanLoadFailed") {
      expect(result.left.cause.message).toContain("got null");
    }
  });

  itEffect("compiler error names the typeof when load() returns a primitive", function* () {
    const dir = makeTempDir("plans-load-num");
    const harnessModulePath = path.join(dir, "num-harness.mjs");
    writeFileSync(
      harnessModulePath,
      ["export default {", "  load() { return 42; },", "};", ""].join("\n"),
      "utf8",
    );
    const planPath = writePlanFile(dir, "num.yaml", planYaml(harnessModulePath));

    const documents = yield* loadPlannedHarnessPath(planPath);
    const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "HarnessPlanLoadFailed") {
      expect(result.left.cause.message).toContain("got number");
    }
  });

  itEffect(
    "compiler error names 'object' when load() returns a plain object without then",
    function* () {
      const dir = makeTempDir("plans-load-obj");
      const harnessModulePath = path.join(dir, "obj-harness.mjs");
      writeFileSync(
        harnessModulePath,
        ["export default {", "  load() { return { foo: 1 }; },", "};", ""].join("\n"),
        "utf8",
      );
      const planPath = writePlanFile(dir, "obj.yaml", planYaml(harnessModulePath));

      const documents = yield* loadPlannedHarnessPath(planPath);
      const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

      expect(result._tag).toBe(EITHER_LEFT);
      if (result._tag === EITHER_LEFT && result.left.cause._tag === "HarnessPlanLoadFailed") {
        expect(result.left.cause.message).toContain("got object");
      }
    },
  );

  itEffect(
    "compiler maps an uncaught defect inside the load() Effect to a typed error",
    function* () {
      const dir = makeTempDir("plans-load-defect");
      const harnessModulePath = path.join(dir, "defect-harness.mjs");
      writeFileSync(
        harnessModulePath,
        [
          "import { Effect } from 'effect';",
          "export default {",
          "  load() {",
          "    return Effect.sync(() => {",
          "      throw new Error('intentional defect inside load() effect');",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      const planPath = writePlanFile(dir, "defect.yaml", planYaml(harnessModulePath));

      const documents = yield* loadPlannedHarnessPath(planPath);
      const result = yield* Effect.either(compilePlannedHarnessDocuments(documents));

      expect(result._tag).toBe(EITHER_LEFT);
      if (result._tag === EITHER_LEFT) {
        expect(result.left.cause._tag).toBe("HarnessPlanLoadFailed");
        if (result.left.cause._tag === "HarnessPlanLoadFailed") {
          expect(result.left.cause.message).toContain("uncaught defect");
          expect(result.left.cause.message).toContain("intentional defect");
        }
      }
    },
  );
});
