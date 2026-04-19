import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as YAML from "yaml";
import { makeReportEmitter, readRunsJsonl } from "../src/emit/report.js";
import { ScenarioId, RunNumber, TraceId } from "../src/core/types.js";
import type { RunRecord, Report } from "../src/core/schema.js";
import { PublishError } from "../src/core/errors.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

// ── Fixture constants ────────────────────────────────────────────────────────
const SCEN_A_ID = "scen-a";
const SCEN_B_ID = "scen-b";
const SCEN_C_ID = "scen-c";
const SCEN_D_ID = "scen-d";
const SCEN_C_RUN_NUMBER = 2;
const EXPECTED_RESULTS_LINE_COUNT = 2;
const EXPECTED_ROUNDTRIP_LENGTH = 1;
const LATENCY_MS = 1234;
const AVG_LATENCY_MS = 500;
const ISSUE_TEXT = "broken";
const ISSUE_SEVERITY_CRITICAL = "critical";
const REASON_FAIL = "failed";
const REASON_PASS = "ok";
const TRACE_ID_1 = "trace-id-1";
const FAKE_PR_NUMBER = 99999;
const SPECIAL_SCEN_ID = "scen/special:test";
const SAFE_SCEN_FILENAME = "scen_special_test.1.yaml";

// Summary format constants — user-visible output surface.
const SUMMARY_HEADER = "# cc-judge report";
const SUMMARY_ARTIFACTS_PREFIX = "- artifacts:";
const SUMMARY_RUNS_HEADING = "## Runs";
const SUMMARY_TABLE_HEADER = "| scenario | run | verdict | severity | latency | retries |";
const SUMMARY_TABLE_SEPARATOR = "| --- | --- | --- | --- | --- | --- |";
const SUMMARY_FAILURES_HEADING = "## Failures";
const SUMMARY_NO_FAILURES = "None.";
const VERDICT_FAIL = "FAIL";
const SUMMARY_ISSUES_LABEL = "- issues:";

function makeRecord(id: string, run: number, pass: boolean): RunRecord {
  return {
    source: "scenario",
    scenarioId: ScenarioId(id),
    runNumber: RunNumber(run),
    modelName: "test-model",
    judgeModel: "test-judge",
    startedAt: "2026-04-18T00:00:00.000Z",
    latencyMs: LATENCY_MS,
    pass,
    reason: pass ? REASON_PASS : REASON_FAIL,
    issues: pass ? [] : [{ issue: ISSUE_TEXT, severity: ISSUE_SEVERITY_CRITICAL }],
    overallSeverity: pass ? null : ISSUE_SEVERITY_CRITICAL,
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

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-judge-emit-"));
}

describe("ReportEmitter", () => {
  itEffect("writes results.jsonl + summary.md + details/*.yaml", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitRun(r1);
    yield* emitter.emitRun(r2);
    const report: Report = {
      runs: [r1, r2],
      summary: { total: 2, passed: 1, failed: 1, avgLatencyMs: LATENCY_MS },
      artifactsDir: dir,
    };
    yield* emitter.emitReport(report);
    expect(existsSync(path.join(dir, "summary.md"))).toBe(true);
    expect(existsSync(path.join(dir, "results.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "details", `${SCEN_A_ID}.1.yaml`))).toBe(true);
    expect(existsSync(path.join(dir, "details", `${SCEN_B_ID}.1.yaml`))).toBe(true);
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(`- passed: ${report.summary.passed}`);
    expect(summary).toContain(SCEN_B_ID);
    const jsonl = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim();
    expect(jsonl.split("\n").length).toBe(EXPECTED_RESULTS_LINE_COUNT);
  });

  itEffect("readRunsJsonl round-trips", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_C_ID, SCEN_C_RUN_NUMBER, true);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: LATENCY_MS },
    });
    const round = readRunsJsonl(dir);
    expect(round.length).toBe(EXPECTED_ROUNDTRIP_LENGTH);
    expect(round[0]?.scenarioId).toBe(SCEN_C_ID);
    expect(round[0]?.runNumber).toBe(SCEN_C_RUN_NUMBER);
  });

  // ── emitRun ─────────────────────────────────────────────────────────────────

  itEffect("emitRun appends json lines to jsonl with trailing newline separator", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitRun(r1);
    yield* emitter.emitRun(r2);
    const raw = readFileSync(path.join(dir, "results.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(EXPECTED_RESULTS_LINE_COUNT);
    const [line0, line1] = lines;
    expect((JSON.parse(line0 ?? "{}") as { scenarioId: string }).scenarioId).toBe(SCEN_A_ID);
    expect((JSON.parse(line1 ?? "{}") as { scenarioId: string }).scenarioId).toBe(SCEN_B_ID);
  });

  itEffect("emitRun writes yaml detail file with serialized record content", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_A_ID, 1, true);
    yield* emitter.emitRun(r);
    const yamlPath = path.join(dir, "details", `${SCEN_A_ID}.1.yaml`);
    expect(existsSync(yamlPath)).toBe(true);
    const parsed = YAML.parse(readFileSync(yamlPath, "utf8")) as { scenarioId: string; pass: boolean };
    expect(parsed.scenarioId).toBe(SCEN_A_ID);
    expect(parsed.pass).toBe(true);
  });

  // ── emitReport ──────────────────────────────────────────────────────────────

  itEffect("emitReport overwrites jsonl content from a prior emitRun", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitRun(r1);
    yield* emitter.emitReport({
      runs: [r2],
      summary: { total: 1, passed: 0, failed: 1, avgLatencyMs: LATENCY_MS },
    });
    const raw = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim();
    const lines = raw.split("\n");
    expect(lines.length).toBe(1);
    const [line0] = lines;
    expect((JSON.parse(line0 ?? "{}") as { scenarioId: string }).scenarioId).toBe(SCEN_B_ID);
  });

  itEffect("emitReport writes empty string to jsonl for zero runs", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    });
    expect(readFileSync(path.join(dir, "results.jsonl"), "utf8")).toBe("");
  });

  itEffect("emitReport creates jsonl without a prior emitRun call", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_A_ID, 1, true);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: AVG_LATENCY_MS },
    });
    expect(existsSync(path.join(dir, "results.jsonl"))).toBe(true);
    expect(readFileSync(path.join(dir, "results.jsonl"), "utf8").trim().length).toBeGreaterThan(0);
  });

  // ── renderSummary (via emitReport) ───────────────────────────────────────────

  itEffect("summary contains document header and full statistics block", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const total = 1;
    const passed = 1;
    const failed = 0;
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total, passed, failed, avgLatencyMs: AVG_LATENCY_MS },
      artifactsDir: dir,
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(SUMMARY_HEADER);
    expect(summary).toContain(`- total: ${total}`);
    expect(summary).toContain(`- passed: ${passed}`);
    expect(summary).toContain(`- failed: ${failed}`);
    expect(summary).toContain(`- avg latency: ${AVG_LATENCY_MS}ms`);
    expect(summary).toContain(`${SUMMARY_ARTIFACTS_PREFIX} ${dir}`);
  });

  itEffect("summary omits artifacts line when artifactsDir is not provided", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    });
    expect(readFileSync(path.join(dir, "summary.md"), "utf8")).not.toContain(SUMMARY_ARTIFACTS_PREFIX);
  });

  itEffect("summary includes runs section header and table header row", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(SUMMARY_RUNS_HEADING);
    expect(summary).toContain(SUMMARY_TABLE_HEADER);
    expect(summary).toContain(SUMMARY_TABLE_SEPARATOR);
  });

  itEffect("summary table row shows PASS verdict and dash for null overallSeverity", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_A_ID, 1, true);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: LATENCY_MS },
    });
    expect(readFileSync(path.join(dir, "summary.md"), "utf8")).toContain(
      `| ${SCEN_A_ID} | 1 | PASS | - | ${LATENCY_MS}ms | 0 |`,
    );
  });

  itEffect("summary table row shows FAIL verdict and severity for a failing run", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 0, failed: 1, avgLatencyMs: LATENCY_MS },
    });
    expect(readFileSync(path.join(dir, "summary.md"), "utf8")).toContain(
      `| ${SCEN_B_ID} | 1 | ${VERDICT_FAIL} | ${ISSUE_SEVERITY_CRITICAL} | ${LATENCY_MS}ms | 0 |`,
    );
  });

  itEffect("summary failures section shows no-failures marker when all runs pass", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 0 },
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(SUMMARY_FAILURES_HEADING);
    expect(summary).toContain(SUMMARY_NO_FAILURES);
    expect(summary).not.toContain(VERDICT_FAIL);
  });

  itEffect("summary failure block includes heading, reason line, and issue list", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 0, failed: 1, avgLatencyMs: LATENCY_MS },
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(`### ${SCEN_B_ID} #1`);
    expect(summary).toContain(`- reason: ${REASON_FAIL}`);
    expect(summary).toContain(SUMMARY_ISSUES_LABEL);
    expect(summary).toContain(`  - [${ISSUE_SEVERITY_CRITICAL}] ${ISSUE_TEXT}`);
  });

  itEffect("summary failure block omits issue list when issues array is empty", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r: RunRecord = {
      ...makeRecord(SCEN_B_ID, 1, false),
      issues: [],
      overallSeverity: null,
    };
    yield* emitter.emitReport({
      runs: [r],
      summary: { total: 1, passed: 0, failed: 1, avgLatencyMs: LATENCY_MS },
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain(`### ${SCEN_B_ID} #1`);
    expect(summary).not.toContain(SUMMARY_ISSUES_LABEL);
  });

  // ── runFilename ──────────────────────────────────────────────────────────────

  itEffect("runFilename sanitizes special characters in scenarioId to safe filename", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitRun(makeRecord(SPECIAL_SCEN_ID, 1, true));
    expect(existsSync(path.join(dir, "details", SAFE_SCEN_FILENAME))).toBe(true);
  });

  // ── publishGithubComment ─────────────────────────────────────────────────────

  itEffect("publishGithubComment returns void when githubComment option is not set", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.publishGithubComment({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 0 },
    });
  });

  itEffect("publishGithubComment fails with PublishError when prNumber is defined", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir, githubComment: FAKE_PR_NUMBER });
    const result = yield* Effect.either(
      emitter.publishGithubComment({
        runs: [makeRecord(SCEN_A_ID, 1, true)],
        summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 0 },
      }),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      const { cause } = result.left as PublishError;
      expect(cause._tag === "GhCliMissing" || cause._tag === "GhCliFailed").toBe(true);
    }
  });
});

// ── readRunsJsonl ────────────────────────────────────────────────────────────

describe("readRunsJsonl", () => {
  it("returns empty array for a non-existent path", () => {
    expect(readRunsJsonl("/definitely/nonexistent/path-abc-xyz-9999")).toHaveLength(0);
  });

  it("returns empty array for an empty file", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "results.jsonl"), "", "utf8");
    expect(readRunsJsonl(dir)).toHaveLength(0);
  });

  it("skips malformed json lines and returns only valid records", () => {
    const dir = tmpDir();
    const r = makeRecord(SCEN_A_ID, 1, true);
    writeFileSync(
      path.join(dir, "results.jsonl"),
      `${JSON.stringify(r)}\nnot-valid-json\n`,
      "utf8",
    );
    expect(readRunsJsonl(dir)).toHaveLength(1);
    expect(readRunsJsonl(dir)[0]?.scenarioId).toBe(SCEN_A_ID);
  });

  it("skips records that fail schema validation", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "results.jsonl"), `{"notARunRecord": true}\n`, "utf8");
    expect(readRunsJsonl(dir)).toHaveLength(0);
  });

  it("preserves traceId field when present in the serialized record", () => {
    const dir = tmpDir();
    const r = makeRecord(SCEN_D_ID, 1, true);
    writeFileSync(
      path.join(dir, "results.jsonl"),
      `${JSON.stringify({ ...r, traceId: TRACE_ID_1 })}\n`,
      "utf8",
    );
    const records = readRunsJsonl(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.traceId).toBe(TRACE_ID_1);
  });

  it("omits traceId field when not present in the serialized record", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "results.jsonl"), `${JSON.stringify(makeRecord(SCEN_A_ID, 1, true))}\n`, "utf8");
    const records = readRunsJsonl(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.traceId).toBeUndefined();
  });
});
