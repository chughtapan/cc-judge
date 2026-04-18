// Report emitter: writes the summary.md + results.jsonl + details/*.yaml triple,
// and optionally posts a GitHub comment.
// Invariant #12: emission never changes verdicts. Every filesystem failure is
// swallowed on the hot path so a disk blip doesn't flip run outcomes.

import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { mkdirSync, appendFileSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import { PublishError } from "../core/errors.js";
import { RunRecordSchema, type Report, type RunRecord } from "../core/schema.js";
import { ScenarioId, TraceId, RunNumber } from "../core/types.js";

export interface ReportEmitterOpts {
  readonly resultsDir: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
}

export interface ReportEmitter {
  emitRun(record: RunRecord): Effect.Effect<void, never, never>;
  emitReport(report: Report): Effect.Effect<void, never, never>;
  publishGithubComment(report: Report): Effect.Effect<void, PublishError, never>;
}

const GITHUB_COMMENT_BODY_LIMIT = 65_000;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function runFilename(record: RunRecord): string {
  const safeId = record.scenarioId.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `${safeId}.${String(record.runNumber)}.yaml`;
}

function renderSummary(report: Report): string {
  const { summary } = report;
  const lines: string[] = [];
  lines.push("# cc-judge report");
  lines.push("");
  lines.push(`- total: ${String(summary.total)}`);
  lines.push(`- passed: ${String(summary.passed)}`);
  lines.push(`- failed: ${String(summary.failed)}`);
  lines.push(`- avg latency: ${summary.avgLatencyMs.toFixed(0)}ms`);
  if (report.artifactsDir !== undefined) {
    lines.push(`- artifacts: ${report.artifactsDir}`);
  }
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| scenario | run | verdict | severity | latency | retries |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of report.runs) {
    const verdict = r.pass ? "PASS" : "FAIL";
    const severity = r.overallSeverity ?? "-";
    lines.push(
      `| ${r.scenarioId} | ${String(r.runNumber)} | ${verdict} | ${severity} | ${String(r.latencyMs)}ms | ${String(r.retryCount)} |`,
    );
  }
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  const failures = report.runs.filter((r) => !r.pass);
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    for (const r of failures) {
      lines.push(`### ${r.scenarioId} #${String(r.runNumber)}`);
      lines.push(`- reason: ${r.reason}`);
      if (r.issues.length > 0) {
        lines.push("- issues:");
        for (const i of r.issues) {
          lines.push(`  - [${i.severity}] ${i.issue}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function truncateForGitHub(body: string, artifactUrl: string | undefined): string {
  if (body.length <= GITHUB_COMMENT_BODY_LIMIT) return body;
  const prefix = body.slice(0, GITHUB_COMMENT_BODY_LIMIT - 500);
  const suffix = artifactUrl !== undefined
    ? `\n\n…truncated. Full report: ${artifactUrl}`
    : "\n\n…truncated (raise --github-comment-artifact-url to link the full report).";
  return prefix + suffix;
}

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch (err) {
    void err;
    return false;
  }
}

function postGithubComment(prNumber: number, body: string): Effect.Effect<void, PublishError, never> {
  return Effect.suspend(() => {
    if (!ghAvailable()) {
      return Effect.fail(new PublishError({ cause: { _tag: "GhCliMissing" } }));
    }
    return Effect.tryPromise({
      try: () => runGh(prNumber, body),
      catch: (err) =>
        new PublishError({
          cause: {
            _tag: "GhCliFailed",
            exitCode: 1,
            stderr: err instanceof Error ? err.message : String(err),
          },
        }),
    });
  });
}

function runGh(prNumber: number, body: string) {
  return new Promise<void>((resolve, reject) => {
    try {
      execFileSync("gh", ["pr", "comment", String(prNumber), "--body-file", "-"], {
        input: body,
        stdio: ["pipe", "ignore", "pipe"],
      });
      resolve();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function makeReportEmitter(opts: ReportEmitterOpts): ReportEmitter {
  const resultsDir = path.resolve(opts.resultsDir);
  const detailsDir = path.join(resultsDir, "details");
  const jsonlPath = path.join(resultsDir, "results.jsonl");
  const summaryPath = path.join(resultsDir, "summary.md");

  return {
    emitRun(record) {
      return Effect.sync(() => {
        try {
          ensureDir(detailsDir);
          appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
          const yamlPath = path.join(detailsDir, runFilename(record));
          writeFileSync(yamlPath, YAML.stringify(record), "utf8");
        } catch (err) {
          void err;
          // Emission is non-verdict. Drop and move on (invariant #12).
        }
      });
    },

    emitReport(report) {
      return Effect.sync(() => {
        try {
          ensureDir(resultsDir);
          // Rewrite results.jsonl from the finalized record list. The streaming
          // emitRun path is best-effort; the report is the canonical form.
          if (existsSync(jsonlPath)) unlinkSync(jsonlPath);
          const jsonl = report.runs.map((r) => JSON.stringify(r)).join("\n");
          writeFileSync(jsonlPath, jsonl.length > 0 ? `${jsonl}\n` : "", "utf8");
          writeFileSync(summaryPath, renderSummary(report), "utf8");
          ensureDir(detailsDir);
          for (const r of report.runs) {
            writeFileSync(path.join(detailsDir, runFilename(r)), YAML.stringify(r), "utf8");
          }
        } catch (err) {
          void err;
          // See emitRun comment. Verdict data is already in Report; disk is secondary.
        }
      });
    },

    publishGithubComment(report) {
      const prNumber = opts.githubComment;
      if (prNumber === undefined) return Effect.void;
      const body = truncateForGitHub(renderSummary(report), opts.githubCommentArtifactUrl);
      return postGithubComment(prNumber, body);
    },
  };
}

// Helper: read an existing jsonl back into RunRecord[]. Used by scoring CLI
// to resume from partial output when run with --continue.
export function readRunsJsonl(resultsDir: string): ReadonlyArray<RunRecord> {
  const jsonlPath = path.join(path.resolve(resultsDir), "results.jsonl");
  if (!existsSync(jsonlPath)) return [];
  const raw = readFileSync(jsonlPath, "utf8");
  const out: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      void err;
      // Skip malformed line; inflight-crash recovery is best-effort.
      continue;
    }
    if (!Value.Check(RunRecordSchema, parsed)) continue;
    const decoded = Value.Decode(RunRecordSchema, parsed);
    const { scenarioId: rawScenarioId, traceId: rawTraceId, runNumber: rawRunNumber, ...rest } = decoded;
    const record: RunRecord = {
      ...rest,
      scenarioId: ScenarioId(rawScenarioId),
      runNumber: RunNumber(rawRunNumber),
      ...(rawTraceId !== undefined ? { traceId: TraceId(rawTraceId) } : {}),
    };
    out.push(record);
  }
  return out;
}
