import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeReportEmitter, readRunsJsonl } from "../src/emit/report.js";
import { ScenarioId, RunNumber } from "../src/core/types.js";
import type { RunRecord, Report } from "../src/core/schema.js";

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
  it("writes results.jsonl + summary.md + details/*.yaml", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-emit-"));
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord("scen-a", 1, true);
    const r2 = makeRecord("scen-b", 1, false);
    await Effect.runPromise(emitter.emitRun(r1));
    await Effect.runPromise(emitter.emitRun(r2));
    const report: Report = {
      runs: [r1, r2],
      summary: { total: 2, passed: 1, failed: 1, avgLatencyMs: 1234 },
      artifactsDir: dir,
    };
    await Effect.runPromise(emitter.emitReport(report));
    expect(existsSync(path.join(dir, "summary.md"))).toBe(true);
    expect(existsSync(path.join(dir, "results.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "details", "scen-a.1.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, "details", "scen-b.1.yaml"))).toBe(true);
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain("passed: 1");
    expect(summary).toContain("scen-b");
    const jsonl = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim();
    expect(jsonl.split("\n").length).toBe(2);
  });

  it("readRunsJsonl round-trips", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-emit-"));
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord("scen-c", 2, true);
    await Effect.runPromise(
      emitter.emitReport({
        runs: [r],
        summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 1234 },
      }),
    );
    const round = readRunsJsonl(dir);
    expect(round.length).toBe(1);
    expect(round[0]?.scenarioId).toBe("scen-c");
    expect(round[0]?.runNumber).toBe(2);
  });
});
