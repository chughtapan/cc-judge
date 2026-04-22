import { describe, expect, afterEach, vi } from "vitest";
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
  decodePromptWorkspacePlanSpec,
  loadPlannedHarnessPath,
  runPlannedHarnessPath,
} from "../src/plans/index.js";
import { itEffect, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";

let capturedPlannedInputs: ReadonlyArray<unknown> | null = null;
let capturedHarnessRunOpts: Record<string, unknown> | null = null;

vi.mock("../src/app/pipeline.js", () => ({
  runScenarios: vi.fn(() =>
    Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    })),
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

function planYaml(overrides: {
  readonly scenarioId?: string;
  readonly harnessKind?: string;
} = {}): string {
  return YAML.stringify({
    plan: {
      project: "cc-judge",
      scenarioId: overrides.scenarioId ?? "planned-harness-smoke",
      name: "planned-harness-smoke",
      description: "exercise planned harness ingress",
      agents: [
        {
          id: "alpha",
          name: "Alpha",
          artifact: {
            _tag: "DockerImageArtifact",
            image: "repo/alpha:latest",
          },
          promptInputs: {},
        },
      ],
      requirements: {
        expectedBehavior: "complete one prompt",
        validationChecks: ["summary should be emitted"],
      },
    },
    harness: {
      kind: overrides.harnessKind ?? "prompt-workspace",
      config: {
        prompts: ["Fix the failing test"],
        workspace: [
          {
            path: "README.md",
            content: "hello",
          },
        ],
        turnTimeoutMs: 1_000,
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
      YAML.parse(planYaml()),
      PlanFilePath("mem://planned-harness.yaml"),
    );

    expect(decoded.plan.project).toBe("cc-judge");
    expect(decoded.plan.scenarioId).toBe("planned-harness-smoke");
    expect(decoded.plan.agents[0].id).toBe("alpha");
    expect(decoded.harness.kind).toBe("prompt-workspace");
    expect(decoded.harness.config.prompts).toEqual(["Fix the failing test"]);
    expect(decoded.harness.config.workspace?.[0]?.path).toBe("README.md");
    expect(decoded.harness.config.turnTimeoutMs).toBe(1_000);
  });

  itEffect("rejects non-document roots with TopLevelNotDocument", function* () {
    const result = yield* Effect.either(
      decodePlannedHarnessDocument(
        [YAML.parse(planYaml())],
        PlanFilePath("mem://array-root.yaml"),
      ),
    );

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("TopLevelNotDocument");
      expect(result.left.cause.path).toBe("mem://array-root.yaml");
    }
  });

  itEffect("rejects unsupported harness kinds before schema decode", function* () {
    const result = yield* Effect.either(
      decodePromptWorkspacePlanSpec(
        {
          kind: "arena-game",
          config: {
            prompts: ["ignored"],
          },
        },
        PlanFilePath("mem://unsupported.yaml"),
      ),
    );

    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("UnsupportedHarnessKind");
      expect(result.left.cause.kind).toBe("arena-game");
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
    writePlanFile(dir, "a.yaml", planYaml({ scenarioId: "duplicate-scenario" }));
    writePlanFile(dir, "b.yaml", planYaml({ scenarioId: "duplicate-scenario" }));

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
    const document = yield* decodePlannedHarnessDocument(
      YAML.parse(planYaml()),
      PlanFilePath("mem://compiled.yaml"),
    );

    const compiled = yield* compilePlannedHarnessDocuments([
      {
        sourcePath: PlanFilePath("mem://compiled.yaml"),
        document,
      },
    ]);

    expect(compiled[0]?.sourcePath).toBe("mem://compiled.yaml");
    expect(compiled[0]?.input.plan.scenarioId).toBe("planned-harness-smoke");
    expect(compiled[0]?.input.harness.name).toBe("prompt-workspace");
  });

  itEffect("runs a planned-harness path through the existing runPlans pipeline", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-run-"));
    const planPath = writePlanFile(dir, "single.yaml", planYaml());
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-out-"));

    const report = yield* runPlannedHarnessPath(planPath, { resultsDir });

    expect(report.summary.total).toBe(1);
    expect(capturedPlannedInputs).toHaveLength(1);
    const input = capturedPlannedInputs?.[0] as {
      readonly plan: { readonly scenarioId: string };
      readonly harness: { readonly name: string };
    };
    expect(input.plan.scenarioId).toBe("planned-harness-smoke");
    expect(input.harness.name).toBe("prompt-workspace");
    expect(capturedHarnessRunOpts?.["resultsDir"]).toBe(resultsDir);
  });

  itEffect("dispatches `run-plans` through the CLI with runtime options", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-cli-"));
    const planPath = writePlanFile(dir, "cli.yaml", planYaml());
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-plans-cli-out-"));

    const code = yield* main([
      "run-plans",
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

  itEffect("returns exit 2 when `run-plans` receives a missing file", function* () {
    const code = yield* main([
      "run-plans",
      path.join(os.tmpdir(), `cc-judge-cli-missing-plan-${Date.now()}.yaml`),
      "--log-level",
      "error",
    ]);

    expect(code).toBe(EXIT_FATAL);
  });
});
