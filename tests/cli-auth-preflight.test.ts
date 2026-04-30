import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { makeTempDir } from "./support/tmpdir.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("../src/app/pipeline.js", () => ({
  runPlans: vi.fn(() =>
    Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    })),
}));

import { main } from "../src/app/cli.js";
import {
  clearJudgePreflightDiskCacheForTests,
  resetJudgePreflightCacheForTests,
} from "../src/app/judge-preflight.js";
import { itEffect } from "./support/effect.js";
import { captureEnvVar, deleteEnvVar, restoreEnvVar, setEnvVar } from "./support/env.js";

const SAVED_XDG_CACHE_HOME = captureEnvVar("XDG_CACHE_HOME");
const SAVED_ANTHROPIC_API_KEY = captureEnvVar("ANTHROPIC_API_KEY");

function writeHarnessPlan(dir: string, fileName: string): string {
  const modulePath = path.join(dir, "fixture-harness.mjs");
  writeFileSync(
    modulePath,
    [
      "import { Effect } from 'effect';",
      "export default {",
      "  load(args) {",
      "    return Effect.succeed({",
      "      plan: {",
      "        project: args.plan.project,",
      "        scenarioId: args.plan.scenarioId,",
      "        name: args.plan.name,",
      "        description: args.plan.description,",
      "        requirements: args.plan.requirements,",
      "        agents: [",
      "          {",
      "            id: 'alpha',",
      "            name: 'Alpha',",
      "            artifact: { _tag: 'DockerImageArtifact', image: 'repo/alpha:latest' },",
      "            promptInputs: {},",
      "          },",
      "        ],",
      "      },",
      "      harness: { name: 'fixture-harness', run: () => Effect.void },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const filePath = path.join(dir, fileName);
  writeFileSync(
    filePath,
    YAML.stringify({
      project: "cc-judge",
      scenarioId: "preflight-harness",
      name: "preflight-harness",
      description: "harness plan for auth preflight coverage",
      requirements: {
        expectedBehavior: "reply",
        validationChecks: ["responds"],
      },
      harness: {
        module: modulePath,
        payload: {},
      },
    }),
    "utf8",
  );
  return filePath;
}

function installStderrCapture(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  type StderrWriteFn = typeof process.stderr.write;
  const spy: StderrWriteFn = ((value: string | Uint8Array): boolean => {
    chunks.push(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
    return true;
  }) as StderrWriteFn;
  Object.defineProperty(process.stderr, "write", { configurable: true, value: spy });
  const restore = (): void => {
    Object.defineProperty(process.stderr, "write", { configurable: true, value: original });
  };
  return { chunks, restore };
}

describe("main anthropic auth preflight", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    resetJudgePreflightCacheForTests();
    clearJudgePreflightDiskCacheForTests();
    setEnvVar("XDG_CACHE_HOME", makeTempDir("cli-auth-cache"));
    deleteEnvVar("ANTHROPIC_API_KEY");
  });

  afterEach(() => {
    restoreEnvVar("XDG_CACHE_HOME", SAVED_XDG_CACHE_HOME);
    restoreEnvVar("ANTHROPIC_API_KEY", SAVED_ANTHROPIC_API_KEY);
  });

  itEffect("fails early with exit 2 when claude auth preflight fails", function* () {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not logged in",
      error: undefined,
    });
    const dir = makeTempDir("cli-auth-run");
    const scenarioPath = writeHarnessPlan(dir, "plan.yaml");

    const { restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main([
        "run",
        scenarioPath,
        "--runtime",
        "subprocess",
        "--bin",
        "/bin/echo",
        "--results",
        "/tmp/cc-judge-results",
      ]),
      Effect.sync(restore),
    );

    expect(code).toBe(2);
  });

  itEffect("reuses the cached success across repeated CLI invocations", function* () {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const dir = makeTempDir("cli-auth-cache-run");
    const scenarioPath = writeHarnessPlan(dir, "plan.yaml");

    yield* main([
      "run",
      scenarioPath,
      "--runtime",
      "subprocess",
      "--bin",
      "/bin/echo",
      "--results",
      "/tmp/cc-judge-results-a",
    ]);
    yield* main([
      "run",
      scenarioPath,
      "--runtime",
      "subprocess",
      "--bin",
      "/bin/echo",
      "--results",
      "/tmp/cc-judge-results-b",
    ]);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
