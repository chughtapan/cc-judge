import { describe, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeReportEmitter, readRunsJsonl } from "../src/emit/report.js";
import { ScenarioId, RunNumber } from "../src/core/types.js";
import type { RunRecord, Report } from "../src/core/schema.js";
import { itEffect } from "./support/effect.js";

const SCEN_A_ID = "scen-a";
const SCEN_B_ID = "scen-b";
const SCEN_C_ID = "scen-c";
const SCEN_C_RUN_NUMBER = 2;
const EXPECTED_RESULTS_LINE_COUNT = 2;
const EXPECTED_ROUNDTRIP_LENGTH = 1;
const SUMMARY_PASSED_LINE = "passed: 1";

function makeRecord(id: string, run: number, pass: boolean): RunRecord {
  return {
    source: "scenario",
    scenarioId: ScenarioId(id),
    runNumber: RunNumber(run),
    modelName: "test-model",
    judgeModel: "test-judge",
    startedAt: "2026-04-18T00:00:00.000Z",
    latencyMs: 1234,
    pass,
    reason: pass ? "ok" : "failed",
    issues: pass ? [] : [{ issue: "broken", severity: "critical" }],
    overallSeverity: pass ? null : "critical",
    judgeConfidence: 0.9,
    retryCount: 0,
    toolCallCount: 0,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptPath: "",
    workspaceDiffSummary: { changed: 0, added: 0, removed: 0 },
  };
}

describe("ReportEmitter", () => {
  itEffect("writes results.jsonl + summary.md + details/*.yaml", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-emit-"));
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitRun(r1);
    yield* emitter.emitRun(r2);
    const report: Report = {
      runs: [r1, r2],
      summary: { total: 2, passed: 1, failed: 1, avgLatencyMs: 1234 },
      artifactsDir: dir,
    };
    yield* emitter.emitReport(report);
    expect(existsSync(path.join(dir, "summary.md"))).toBe(true);
    expect(existsSync(path.join(dir, "results.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "details", `${SCEN_A_ID}.1.yaml`))).toBe(true);
    expect(existsSync(path.join(dir, "details", `${SCEN_B_ID}.1.yaml`))).toBe(true);
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(SUMMARY_PASSED_LINE);
    expect(summary).toContain(SCEN_B_ID);
    const jsonl = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim();
    expect(jsonl.split("\n").length).toBe(EXPECTED_RESULTS_LINE_COUNT);
  });

  itEffect("readRunsJsonl round-trips", function* () {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-emit-"));
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_C_ID, SCEN_C_RUN_NUMBER, true);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 1234 },
    });
    const round = readRunsJsonl(dir);
    expect(round.length).toBe(EXPECTED_ROUNDTRIP_LENGTH);
    expect(round[0]?.scenarioId).toBe(SCEN_C_ID);
    expect(round[0]?.runNumber).toBe(SCEN_C_RUN_NUMBER);
  });
});
