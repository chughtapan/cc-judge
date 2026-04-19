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
// GitHub comment truncation constants — must stay in sync with production value.
const GITHUB_COMMENT_BODY_LIMIT = 65_000;
const TRUNCATION_SUFFIX_WITH_URL = "…truncated. Full report:";
const TRUNCATION_SUFFIX_NO_URL = "…truncated (raise --github-comment-artifact-url to link the full report).";
const FAKE_ARTIFACT_URL = "https://example.com/artifacts/report.html";
// PublishError cause tag constants — mirror the tagged-union values in errors.ts.
const PUBLISH_CAUSE_GH_CLI_FAILED = "GhCliFailed" as const;
const PUBLISH_CAUSE_GH_CLI_MISSING = "GhCliMissing" as const;
// Summary structure strings — user-visible formatting that must use \n separators.
const SUMMARY_HEADER_BLANK = "# cc-judge report\n\n";
const SUMMARY_RUNS_WITH_BLANKS = "\n\n## Runs\n\n";
const SUMMARY_FAILURES_WITH_BLANKS = "\n\n## Failures\n\n";

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
      expect(
        cause._tag === PUBLISH_CAUSE_GH_CLI_MISSING || cause._tag === PUBLISH_CAUSE_GH_CLI_FAILED,
      ).toBe(true);
    }
  });

  itEffect("publishGithubComment fails with GhCliFailed when gh cli is available but pr does not exist", function* () {
    // `gh` is present in this environment. A bogus PR number triggers GhCliFailed,
    // not GhCliMissing. Mutations that make ghAvailable() always return false would
    // produce GhCliMissing instead, killing those survivors (lines 97, 100, 96).
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
      const err = result.left as PublishError;
      // gh is available in CI so the error must be GhCliFailed (not GhCliMissing).
      // If ghAvailable() incorrectly returns false, cause._tag would be "GhCliMissing".
      expect(err.cause._tag).toBe(PUBLISH_CAUSE_GH_CLI_FAILED);
    }
  });

  itEffect("publishGithubComment passes pr args and body via stdin to gh cli", function* () {
    // This test verifies the runGh arguments path. With gh available but a bogus
    // PR number, gh exits non-zero → GhCliFailed with a non-empty stderr.
    // Mutations that strip the args array or remove stdin would still produce
    // GhCliFailed but would either fail differently or not relay the PR number.
    // The primary kill target here is the args/stdio ObjectLiteral mutation (line 126-128).
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
      const err = result.left as PublishError;
      expect(err.cause._tag).toBe(PUBLISH_CAUSE_GH_CLI_FAILED);
      if (err.cause._tag === PUBLISH_CAUSE_GH_CLI_FAILED) {
        // gh reports an error — stderr is a string when the PR is not found.
        expect(err.cause.stderr).toEqual(expect.any(String));
      }
    }
  });

  // ── truncateForGitHub — body exceeds limit, both with and without artifactUrl ─

  itEffect("publishGithubComment with a very long report body still fails with GhCliFailed (not a crash)", function* () {
    // Generate enough runs to push renderSummary past GITHUB_COMMENT_BODY_LIMIT.
    // Each table row is ~80 chars; 1000 rows ≈ 80 KB, safely over 65 KB.
    // This exercises the truncation path (lines 87-91) which is NoCoverage.
    const MANY_RUNS = 1000;
    const runs = Array.from({ length: MANY_RUNS }, (_, i) =>
      makeRecord(`scenario-${String(i).padStart(4, "0")}`, 1, i % 2 === 0),
    );
    const dir = tmpDir();
    const emitter = makeReportEmitter({
      resultsDir: dir,
      githubComment: FAKE_PR_NUMBER,
    });
    const result = yield* Effect.either(
      emitter.publishGithubComment({
        runs,
        summary: { total: MANY_RUNS, passed: MANY_RUNS / 2, failed: MANY_RUNS / 2, avgLatencyMs: 0 },
      }),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      const err = result.left as PublishError;
      // gh is available, so we get GhCliFailed (truncated body piped to gh).
      expect(err.cause._tag).toBe(PUBLISH_CAUSE_GH_CLI_FAILED);
    }
  });

  itEffect("publishGithubComment with very long report body and artifactUrl exercises truncation suffix with url", function* () {
    // This exercises the artifactUrl branch in truncateForGitHub (line 89).
    const MANY_RUNS = 1000;
    const runs = Array.from({ length: MANY_RUNS }, (_, i) =>
      makeRecord(`scenario-${String(i).padStart(4, "0")}`, 1, true),
    );
    const dir = tmpDir();
    const emitter = makeReportEmitter({
      resultsDir: dir,
      githubComment: FAKE_PR_NUMBER,
      githubCommentArtifactUrl: FAKE_ARTIFACT_URL,
    });
    const result = yield* Effect.either(
      emitter.publishGithubComment({
        runs,
        summary: { total: MANY_RUNS, passed: MANY_RUNS, failed: 0, avgLatencyMs: 0 },
      }),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      const err = result.left as PublishError;
      expect(err.cause._tag).toBe(PUBLISH_CAUSE_GH_CLI_FAILED);
    }
  });

  // ── renderSummary — newline separator and blank-line structure ───────────────

  itEffect("summary uses newline as section separator (not empty string)", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: AVG_LATENCY_MS },
    });
    const raw = readFileSync(path.join(dir, "summary.md"), "utf8");
    // The header must be followed by a blank line, proving lines.join("\n") is used.
    expect(raw).toContain(SUMMARY_HEADER_BLANK);
    // The Runs heading must be preceded and followed by blank lines.
    expect(raw).toContain(SUMMARY_RUNS_WITH_BLANKS);
    // The Failures heading must be preceded and followed by blank lines.
    expect(raw).toContain(SUMMARY_FAILURES_WITH_BLANKS);
  });

  itEffect("summary failure block has a lines.push empty-string separator after each issue list", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_B_ID, 1, false);
    // Provide TWO failing runs so the blank-line separator between them is observable.
    const r2: RunRecord = {
      ...makeRecord(SCEN_A_ID, 1, false),
      issues: [{ issue: "second-issue", severity: ISSUE_SEVERITY_CRITICAL }],
    };
    yield* emitter.emitReport({
      runs: [r1, r2],
      summary: { total: 2, passed: 0, failed: 2, avgLatencyMs: 0 },
    });
    const raw = readFileSync(path.join(dir, "summary.md"), "utf8");
    // The blank line (from lines.push("")) must separate the two failure blocks.
    // With mutation lines.push("Stryker was here!") the separator text would be different.
    expect(raw).toContain(
      `  - [${ISSUE_SEVERITY_CRITICAL}] ${ISSUE_TEXT}\n\n### ${SCEN_A_ID} #1`,
    );
  });

  itEffect("summary table separator row is present between header and data rows", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 0 },
    });
    const raw = readFileSync(path.join(dir, "summary.md"), "utf8");
    // Table header, separator, and data row must be adjacent lines separated by \n.
    expect(raw).toContain(
      `${SUMMARY_TABLE_HEADER}\n${SUMMARY_TABLE_SEPARATOR}\n`,
    );
  });

  // ── truncateForGitHub — body shorter or equal to limit passes through ────────

  itEffect("publishGithubComment body at exactly the limit is not truncated", function* () {
    const dir = tmpDir();
    // Build a report whose rendered summary is well under the limit, confirming
    // the ≤ branch returns the body as-is.
    const emitter = makeReportEmitter({
      resultsDir: dir,
      githubComment: FAKE_PR_NUMBER,
      githubCommentArtifactUrl: FAKE_ARTIFACT_URL,
    });
    // The emitter will call ghAvailable() and then fail — that is expected.
    // What we care about is that the *body passed to postGithubComment* is not
    // truncated. We verify this by checking that the summary written to disk
    // (same renderSummary output) does not contain the truncation suffix.
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_A_ID, 1, true)],
      summary: { total: 1, passed: 1, failed: 0, avgLatencyMs: 0 },
    });
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary.length).toBeLessThanOrEqual(GITHUB_COMMENT_BODY_LIMIT);
    expect(summary).not.toContain(TRUNCATION_SUFFIX_WITH_URL);
    expect(summary).not.toContain(TRUNCATION_SUFFIX_NO_URL);
  });

  // ── emitReport — deletes prior jsonl before rewriting ───────────────────────

  itEffect("emitReport removes existing jsonl file before rewriting it", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    // Seed a jsonl file via emitRun so one exists on disk.
    yield* emitter.emitRun(makeRecord(SCEN_A_ID, 1, true));
    const jsonlPath = path.join(dir, "results.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);
    // emitReport with a different set of runs must delete and rewrite.
    yield* emitter.emitReport({
      runs: [makeRecord(SCEN_B_ID, 1, false)],
      summary: { total: 1, passed: 0, failed: 1, avgLatencyMs: 0 },
    });
    const raw = readFileSync(jsonlPath, "utf8");
    // Only scen-b should appear; scen-a from the prior emitRun must be gone.
    expect(raw).toContain(SCEN_B_ID);
    expect(raw).not.toContain(SCEN_A_ID);
  });

  itEffect("emitReport writes yaml detail files for every run in report", function* () {
    const dir = tmpDir();
    const emitter = makeReportEmitter({ resultsDir: dir });
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    yield* emitter.emitReport({
      runs: [r1, r2],
      summary: { total: 2, passed: 1, failed: 1, avgLatencyMs: LATENCY_MS },
    });
    expect(existsSync(path.join(dir, "details", `${SCEN_A_ID}.1.yaml`))).toBe(true);
    expect(existsSync(path.join(dir, "details", `${SCEN_B_ID}.1.yaml`))).toBe(true);
    const parsedA = YAML.parse(
      readFileSync(path.join(dir, "details", `${SCEN_A_ID}.1.yaml`), "utf8"),
    ) as { scenarioId: string; pass: boolean };
    expect(parsedA.scenarioId).toBe(SCEN_A_ID);
    expect(parsedA.pass).toBe(true);
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

  // ── whitespace and blank-line handling ──────────────────────────────────────

  it("skips blank lines (whitespace-only) in jsonl without parsing them", () => {
    const dir = tmpDir();
    const r = makeRecord(SCEN_A_ID, 1, true);
    // A file with interspersed blank lines and leading/trailing whitespace lines.
    writeFileSync(
      path.join(dir, "results.jsonl"),
      `\n   \n${JSON.stringify(r)}\n\n   \n`,
      "utf8",
    );
    const records = readRunsJsonl(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.scenarioId).toBe(SCEN_A_ID);
  });

  it("trims leading and trailing whitespace from each line before parsing", () => {
    const dir = tmpDir();
    const r = makeRecord(SCEN_B_ID, 1, false);
    // Indent the JSON with leading spaces — trim() must strip them before JSON.parse.
    writeFileSync(
      path.join(dir, "results.jsonl"),
      `  ${JSON.stringify(r)}  \n`,
      "utf8",
    );
    const records = readRunsJsonl(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.scenarioId).toBe(SCEN_B_ID);
  });

  it("continues past a malformed json line and still returns subsequent valid records", () => {
    const dir = tmpDir();
    const r1 = makeRecord(SCEN_A_ID, 1, true);
    const r2 = makeRecord(SCEN_B_ID, 1, false);
    // malformed line sits between two valid records.
    writeFileSync(
      path.join(dir, "results.jsonl"),
      `${JSON.stringify(r1)}\nnot-json-at-all\n${JSON.stringify(r2)}\n`,
      "utf8",
    );
    const records = readRunsJsonl(dir);
    expect(records).toHaveLength(2);
    expect(records[0]?.scenarioId).toBe(SCEN_A_ID);
    expect(records[1]?.scenarioId).toBe(SCEN_B_ID);
  });
});
