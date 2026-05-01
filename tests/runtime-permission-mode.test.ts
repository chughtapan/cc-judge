// Real-process coverage for SubprocessRuntime permission-mode threading
// (spec § 5 PR 2 / § 6 PR 2 / § 7.3, invariants I3 + I4). The fake bin
// is a Node script that records its argv to a file we then assert on,
// so the spawn boundary is exercised end-to-end without invoking a real
// `claude` CLI.

import { describe, expect } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SUBPROCESS_PERMISSION_MODE,
  SUBPROCESS_PERMISSION_MODES,
  SubprocessRuntime,
} from "../src/runner/index.js";
import { AgentId, ProjectId, ScenarioId } from "../src/core/types.js";
import { itEffect } from "./support/effect.js";

const PERMISSION_FLAG = "--permission-mode";
const FAKE_ARGV_ENV_VAR = "CC_JUDGE_FAKE_ARGV_FILE";
const TIMEOUT_MS = 10_000;

interface FakeBin {
  readonly bin: string;
  readonly argvFile: string;
}

// Writes a self-contained Node script to a fresh tmpdir that, when
// spawned by SubprocessRuntime, dumps process.argv.slice(2) as JSON to
// the path supplied via env. tmpdir survives the test; vitest cleanup
// is not load-bearing because subsequent runs create new dirs.
function setupFakeBin(): FakeBin {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-fake-bin-"));
  const argvFile = path.join(dir, "argv.json");
  const bin = path.join(dir, "fake-claude.js");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.${FAKE_ARGV_ENV_VAR}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, argvFile };
}

function makeAgentAndPlan(scenarioId: string) {
  const agent = {
    id: AgentId(scenarioId),
    name: scenarioId,
    artifact: {
      _tag: "DockerImageArtifact" as const,
      image: "n/a",
    },
    promptInputs: {},
  };
  const plan = {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId(scenarioId),
    name: scenarioId,
    description: scenarioId,
    agents: [agent] as const,
    requirements: {
      expectedBehavior: "permission-mode threading",
      validationChecks: [] as ReadonlyArray<string>,
    },
  };
  return { agent, plan };
}

function readArgv(file: string): ReadonlyArray<string> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) {
    throw new Error(`fake bin argv file did not contain a string array: ${file}`);
  }
  return parsed;
}

function modeAfterFlag(args: ReadonlyArray<string>): string | undefined {
  const idx = args.indexOf(PERMISSION_FLAG);
  return idx === -1 ? undefined : args[idx + 1];
}

function countOccurrences(args: ReadonlyArray<string>, token: string): number {
  return args.filter((v) => v === token).length;
}

describe("SubprocessRuntime permission-mode threading", () => {
  itEffect(
    "default opts inject acceptEdits exactly once",
    function* () {
      const { bin, argvFile } = setupFakeBin();
      const runtime = new SubprocessRuntime({
        bin,
        env: { [FAKE_ARGV_ENV_VAR]: argvFile },
      });
      const { agent, plan } = makeAgentAndPlan(`subproc-permdefault-${Date.now()}`);
      const handle = yield* runtime.prepare(agent, plan);
      yield* handle.executePrompt("hello", { timeoutMs: TIMEOUT_MS });
      yield* runtime.stop(handle);

      const argv = readArgv(argvFile);
      expect(modeAfterFlag(argv)).toBe(DEFAULT_SUBPROCESS_PERMISSION_MODE);
      expect(countOccurrences(argv, PERMISSION_FLAG)).toBe(1);
    },
  );

  itEffect(
    "explicit permissionMode threads each enum value",
    function* () {
      for (const mode of SUBPROCESS_PERMISSION_MODES) {
        const { bin, argvFile } = setupFakeBin();
        const runtime = new SubprocessRuntime({
          bin,
          permissionMode: mode,
          env: { [FAKE_ARGV_ENV_VAR]: argvFile },
        });
        const { agent, plan } = makeAgentAndPlan(`subproc-permopt-${mode}-${Date.now()}`);
        const handle = yield* runtime.prepare(agent, plan);
        yield* handle.executePrompt("hello", { timeoutMs: TIMEOUT_MS });
        yield* runtime.stop(handle);

        const argv = readArgv(argvFile);
        expect(modeAfterFlag(argv)).toBe(mode);
        expect(countOccurrences(argv, PERMISSION_FLAG)).toBe(1);
      }
    },
  );

  itEffect(
    "extraArgs --permission-mode wins; opt is suppressed and not duplicated",
    function* () {
      const { bin, argvFile } = setupFakeBin();
      const overrideMode = SUBPROCESS_PERMISSION_MODES[1]; // "bypassPermissions"
      const ignoredMode = SUBPROCESS_PERMISSION_MODES[2]; // "plan"
      const runtime = new SubprocessRuntime({
        bin,
        permissionMode: ignoredMode,
        extraArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          PERMISSION_FLAG,
          overrideMode,
        ],
        env: { [FAKE_ARGV_ENV_VAR]: argvFile },
      });
      const { agent, plan } = makeAgentAndPlan(`subproc-permextraargs-${Date.now()}`);
      const handle = yield* runtime.prepare(agent, plan);
      yield* handle.executePrompt("hello", { timeoutMs: TIMEOUT_MS });
      yield* runtime.stop(handle);

      const argv = readArgv(argvFile);
      expect(modeAfterFlag(argv)).toBe(overrideMode);
      expect(countOccurrences(argv, PERMISSION_FLAG)).toBe(1);
      expect(argv.includes(ignoredMode)).toBe(false);
    },
  );
});
