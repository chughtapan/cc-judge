import { afterEach, describe, expect, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

installDefaultEnvVar("ANTHROPIC_API_KEY", "test-anthropic-api-key");

let capturedPlannedInputs: ReadonlyArray<unknown> | null = null;
let capturedHarnessRunOpts: Record<string, unknown> | null = null;

vi.mock("../src/app/pipeline.js", () => ({
  scoreTraces: vi.fn(() =>
    Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    })),
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

function installStderrCapture(): { readonly chunks: string[]; readonly restore: () => void } {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return originalWrite(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;
  return {
    chunks,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-dup-"));
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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-compile-"));
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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-run-"));
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "single.yaml", planYaml(harnessModulePath));
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-out-"));

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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-timeout-"));
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "timeout.yaml", planYaml(harnessModulePath));
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-timeout-out-"));

    yield* runPlannedHarnessPath(planPath, {
      resultsDir,
      totalTimeoutMs: 12_345,
    });

    expect(capturedHarnessRunOpts?.["totalTimeoutMs"]).toBe(12_345);
  });

  itEffect("dispatches `run` through the CLI with explicit harness YAML", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-cli-"));
    const harnessModulePath = writeHarnessModule(dir);
    const planPath = writePlanFile(dir, "cli.yaml", planYaml(harnessModulePath));
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-cli-out-"));

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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-missing-export-"));
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
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-invalid-"));
    const badPath = writePlanFile(dir, "broken.yaml", "harness:\n  module: [\n");
    const { chunks, restore } = installStderrCapture();

    const code = yield* Effect.ensuring(
      main(["run", badPath, "--log-level", "error"]),
      Effect.sync(restore),
    );

    expect(code).toBe(EXIT_FATAL);
    expect(chunks.join("")).toContain("ParseFailure");
  });
});
