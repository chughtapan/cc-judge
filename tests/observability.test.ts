import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PromptfooEmitter } from "../src/emit/observability.js";
import { ScenarioId, RunNumber, RUN_SOURCE, ISSUE_SEVERITY } from "../src/core/types.js";
import type { RunRecord, Report } from "../src/core/schema.js";
import { itEffect } from "./support/effect.js";

const NAME_BRAINTRUST = "braintrust";
const NAME_PROMPTFOO = "promptfoo";
const SCEN_A = "scen-a";
const SCEN_B = "scen-b";
const PROMPTFOO_VERSION = 3;
const EXPECTED_RUN_COUNT_TWO = 2;
const EXPECTED_SUCCESSES_ONE = 1;
const EXPECTED_FAILURES_ONE = 1;
const INPUT_TOKENS_A = 5;
const INPUT_TOKENS_B = 7;
const OUTPUT_TOKENS_A = 3;
const OUTPUT_TOKENS_B = 4;
const EXPECTED_PROMPT_TOTAL = INPUT_TOKENS_A + INPUT_TOKENS_B;
const EXPECTED_COMPLETION_TOTAL = OUTPUT_TOKENS_A + OUTPUT_TOKENS_B;
const PASS_SCORE = 1;
const FAIL_SCORE = 0;
const REASON_PASS = "ok";
const REASON_FAIL = "missed";
const DUMMY_API_KEY = "test-key";
const BRAINTRUST_PROJECT = "test-project";

function makeRecord(id: string, pass: boolean, inputTokens: number, outputTokens: number): RunRecord {
  return {
    source: RUN_SOURCE.Scenario,
    scenarioId: ScenarioId(id),
    runNumber: RunNumber(1),
    modelName: "test-model",
    judgeModel: "test-judge",
    startedAt: "2026-04-18T00:00:00.000Z",
    latencyMs: 10,
    pass,
    reason: pass ? REASON_PASS : REASON_FAIL,
    issues: pass ? [] : [{ issue: "x", severity: ISSUE_SEVERITY.Minor }],
    overallSeverity: pass ? null : ISSUE_SEVERITY.Minor,
    judgeConfidence: null,
    retryCount: 0,
    toolCallCount: 0,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptPath: "",
    workspaceDiffSummary: { changed: 0, added: 0, removed: 0 },
  };
}

function makeReport(records: ReadonlyArray<RunRecord>): Report {
  let passed = 0;
  for (const r of records) if (r.pass) passed += 1;
  return {
    runs: records,
    summary: {
      total: records.length,
      passed,
      failed: records.length - passed,
      avgLatencyMs: 10,
    },
  };
}

describe("PromptfooEmitter", () => {
  it("exposes .name = 'promptfoo'", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-promptfoo-"));
    const e = new PromptfooEmitter({ outputPath: path.join(dir, "r.json") });
    expect(e.name).toBe(NAME_PROMPTFOO);
  });

  itEffect("onRun is a no-op Effect that writes nothing", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-promptfoo-"));
    const file = path.join(dir, "out.json");
    const e = new PromptfooEmitter({ outputPath: file });
    yield* e.onRun({ record: makeRecord(SCEN_A, true, INPUT_TOKENS_A, OUTPUT_TOKENS_A) });
    expect(existsSync(file)).toBe(false);
  });

  itEffect("onReport writes a promptfoo-v3 JSON file with per-run rows and aggregated stats", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-promptfoo-"));
    const file = path.join(dir, "sub", "results.json");
    const e = new PromptfooEmitter({ outputPath: file });
    const report = makeReport([
      makeRecord(SCEN_A, true, INPUT_TOKENS_A, OUTPUT_TOKENS_A),
      makeRecord(SCEN_B, false, INPUT_TOKENS_B, OUTPUT_TOKENS_B),
    ]);
    yield* e.onReport({ report });
    expect(existsSync(file)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("results" in parsed)
    ) {
      throw new Error("results.json did not match the promptfoo-v3 envelope");
    }
    const root = parsed as {
      version: number;
      results: {
        results: Array<{
          promptId: string;
          success: boolean;
          score: number;
          gradingResult: { pass: boolean; reason: string };
        }>;
        stats: {
          successes: number;
          failures: number;
          tokenUsage: { total: number; prompt: number; completion: number };
        };
      };
    };
    expect(root.version).toBe(PROMPTFOO_VERSION);
    expect(root.results.results.length).toBe(EXPECTED_RUN_COUNT_TWO);
    expect(root.results.results[0].promptId).toBe(SCEN_A);
    expect(root.results.results[0].success).toBe(true);
    expect(root.results.results[0].score).toBe(PASS_SCORE);
    expect(root.results.results[0].gradingResult.pass).toBe(true);
    expect(root.results.results[0].gradingResult.reason).toBe(REASON_PASS);
    expect(root.results.results[1].success).toBe(false);
    expect(root.results.results[1].score).toBe(FAIL_SCORE);
    expect(root.results.stats.successes).toBe(EXPECTED_SUCCESSES_ONE);
    expect(root.results.stats.failures).toBe(EXPECTED_FAILURES_ONE);
    expect(root.results.stats.tokenUsage.prompt).toBe(EXPECTED_PROMPT_TOTAL);
    expect(root.results.stats.tokenUsage.completion).toBe(EXPECTED_COMPLETION_TOTAL);
    expect(root.results.stats.tokenUsage.total).toBe(EXPECTED_PROMPT_TOTAL + EXPECTED_COMPLETION_TOTAL);
  });

  itEffect("onReport with empty report still writes a valid envelope", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-promptfoo-"));
    const file = path.join(dir, "empty.json");
    const e = new PromptfooEmitter({ outputPath: file });
    yield* e.onReport({
      report: { runs: [], summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 } },
    });
    expect(existsSync(file)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const root = parsed as {
      version: number;
      results: { results: unknown[]; stats: { successes: number; failures: number } };
    };
    expect(root.version).toBe(PROMPTFOO_VERSION);
    expect(root.results.results.length).toBe(0);
    expect(root.results.stats.successes).toBe(0);
    expect(root.results.stats.failures).toBe(0);
  });

});

