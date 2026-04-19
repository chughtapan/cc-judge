/**
 * E2E tests: real experiments through the full cc-judge pipeline.
 *
 * Invariants (from spec #49):
 *   I1 — subprocess invocation only (child_process.execFile)
 *   I2 — exit code assertions: 0=all-pass, 1=any-fail, 2=fatal
 *   I3 — no LLM output wording assertions
 *   I4 — cleanup results dir after each test
 *   I5 — excluded from default vitest via exclude glob
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { itEffect } from "../support/effect.js";

const E2E_TIMEOUT = 300_000;
const BIN_PATH = path.resolve(import.meta.dirname, "../../dist/bin.js");
const SCENARIOS_DIR = path.resolve(import.meta.dirname, "../../scenarios");
const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function resolveClaudeBin(): string {
  try {
    const out = execFileSync("which", ["claude"], { timeout: 5000, encoding: "utf8" });
    return out.trim();
  } catch (err) {
    void err;
    return "";
  }
}

const claudeBin = resolveClaudeBin();
const shouldRun = claudeBin.length > 0;
if (!shouldRun) {
  console.log("[e2e] Skipping all e2e tests: claude binary not found");
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCcJudge(args: ReadonlyArray<string>): Effect.Effect<CliResult, Error, never> {
  return Effect.tryPromise({
    try: () =>
      new Promise<CliResult>((resolve, reject) => {
        const proc = execFile(
          "node",
          [BIN_PATH, ...args],
          { timeout: E2E_TIMEOUT },
          (err, stdout, stderr) => {
            resolve({
              exitCode: err?.status ?? 0,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
        proc.on("error", reject);
      }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

function uniqueResultsDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-judge-e2e-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    void err;
  }
}

function runScenario(
  scenarioPath: string,
  expectedExit: number | readonly [number, number],
  stdoutPattern: string | RegExp,
): Effect.Effect<void, Error, never> {
  return Effect.gen(function* () {
    const resultsDir = uniqueResultsDir();
    const result = yield* Effect.ensuring(
      runCcJudge([
        "run",
        scenarioPath,
        "--runtime", "subprocess",
        "--bin", claudeBin,
        "--results", resultsDir,
        "--log-level", "info",
      ]),
      Effect.sync(() => cleanupDir(resultsDir)),
    );
    if (typeof expectedExit === "number") {
      expect(result.exitCode).toBe(expectedExit);
    } else {
      expect(expectedExit).toContain(result.exitCode);
    }
    if (typeof stdoutPattern === "string") {
      expect(result.stdout).toContain(stdoutPattern);
    } else {
      expect(result.stdout).toMatch(stdoutPattern);
    }
  });
}

const e2e = describe.skipIf(!shouldRun);

e2e("e2e: existing scenario (no-raw-throw-to-tagged)", () => {
  const scenarioPath = path.join(
    SCENARIOS_DIR,
    "acg-rule-coverage/no-raw-throw-to-tagged.yaml",
  );

  itEffect(
    "runs end-to-end via subprocess runner — exit not fatal, summary in stdout",
    function* () { yield* runScenario(scenarioPath, [0, 1] as const, /\d+\/1 (passed|failed)/); },
    E2E_TIMEOUT,
  );
});

e2e("e2e: multi-file edit (extract shared constant)", () => {
  const scenarioPath = path.join(SCENARIOS_DIR, "e2e/multi-file-edit.yaml");

  itEffect(
    "runs end-to-end via subprocess runner — exit not fatal, summary in stdout",
    function* () { yield* runScenario(scenarioPath, [0, 1] as const, /\d+\/1 (passed|failed)/); },
    E2E_TIMEOUT,
  );
});

e2e("e2e: no-op passthrough (add JSDoc to correct code)", () => {
  const scenarioPath = path.join(SCENARIOS_DIR, "e2e/noop-passthrough.yaml");

  itEffect(
    "runs end-to-end via subprocess runner — exit not fatal, summary in stdout",
    function* () { yield* runScenario(scenarioPath, [0, 1] as const, /\d+\/1 (passed|failed)/); },
    E2E_TIMEOUT,
  );
});

e2e("e2e: deliberate failure (impossible constraint)", () => {
  const scenarioPath = path.join(SCENARIOS_DIR, "e2e/deliberate-failure.yaml");

  itEffect(
    "runs end-to-end via subprocess runner — exit not fatal, summary in stdout",
    function* () { yield* runScenario(scenarioPath, [0, 1] as const, /\d+\/1 (passed|failed)/); },
    E2E_TIMEOUT,
  );
});

e2e("e2e: score command with fixture trace", () => {
  const tracePath = path.join(FIXTURES_DIR, "passing-trace.yaml");

  itEffect(
    "scores a pre-existing trace — exits 0 or 1, not 2 (fatal)",
    function* () {
      const resultsDir = uniqueResultsDir();
      const result = yield* Effect.ensuring(
        runCcJudge([
          "score",
          tracePath,
          "--trace-format", "canonical",
          "--results", resultsDir,
          "--log-level", "info",
        ]),
        Effect.sync(() => cleanupDir(resultsDir)),
      );
      expect([0, 1] as const).toContain(result.exitCode);
      expect(result.stdout).toContain("1/1");
    },
    E2E_TIMEOUT,
  );
});
