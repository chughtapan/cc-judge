// Tests for `src/app/inspect.ts` — spec chughtapan/cc-judge#77.
//
// Assertions target the structured `InspectReport` returned by `inspectRun`,
// not stdout/stderr formatting. Rendering is a pure CLI concern covered
// indirectly via cli-smoke.

import { describe, expect } from "vitest";
import { Effect, Exit } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { WAL_LINE_KIND, WAL_LINE_VERSION } from "../src/emit/wal.js";
import { INSPECT_CAUSE, INSPECT_SOURCE, inspectRun } from "../src/app/inspect.js";
import { expectLeft, expectCauseTag, itEffect } from "./support/effect.js";
import { makeTempDir } from "./support/tmpdir.js";

// ---------------------------------------------------------------------------
// WAL line fixture helpers.
// ---------------------------------------------------------------------------

function mkTmpResultsDir(tag: string): string {
  return makeTempDir(`inspect-${tag}`);
}

interface WalLineFixture {
  readonly v: number;
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly payload: unknown;
}

function walLine(
  runId: string,
  seq: number,
  kind: string,
  payload: unknown = {},
  v: number = WAL_LINE_VERSION,
): WalLineFixture {
  return { v, runId, seq, ts: Date.now(), kind, payload };
}

function writeInflightFile(
  inflightDir: string,
  runId: string,
  lines: ReadonlyArray<WalLineFixture>,
): void {
  fs.mkdirSync(inflightDir, { recursive: true });
  const file = path.join(inflightDir, `${runId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(file, content, "utf8");
}

function writeRunsFile(
  runsDir: string,
  runId: string,
  lines: ReadonlyArray<WalLineFixture>,
): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `${runId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(file, content, "utf8");
}

// ---------------------------------------------------------------------------
// 1. seq-gap detection — gaps surface as report.gaps.
// ---------------------------------------------------------------------------

describe("inspect seq-gap detection", () => {
  itEffect("reports a single missing seq when seq jumps from 1 to 3", function* () {
    const resultsDir = mkTmpResultsDir("gap");
    const runId = "run-gap-test";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "setup" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 3, WAL_LINE_KIND.Event, { type: "tool_use" }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.gaps).toEqual([2]);
  });

  itEffect("lists every missing seq in ascending order", function* () {
    const resultsDir = mkTmpResultsDir("gap-multi");
    const runId = "run-gap-multi";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      walLine(runId, 3, WAL_LINE_KIND.Turn, { index: 0 }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.gaps).toEqual([1, 2]);
  });

  itEffect("returns empty gaps when seqs are contiguous", function* () {
    const resultsDir = mkTmpResultsDir("gap-none");
    const runId = "run-gap-none";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 2, WAL_LINE_KIND.Event, { type: "t" }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. duplicate seq → InspectError{DuplicateSeq}.
// ---------------------------------------------------------------------------

describe("inspect duplicate-seq detection", () => {
  itEffect("fails with DuplicateSeq when seq is repeated", function* () {
    const resultsDir = mkTmpResultsDir("dup");
    const runId = "run-dup-test";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 1 }),
    ]);

    const err = expectLeft(yield* Effect.either(inspectRun(runId, resultsDir)));
    const cause = expectCauseTag(err.cause, INSPECT_CAUSE.DuplicateSeq);
    expect(cause.seq).toBe(1);
    expect(cause.runId).toBe(runId);
  });

  itEffect("reports the lowest duplicate seq when multiple are repeated", function* () {
    const resultsDir = mkTmpResultsDir("dup-multi");
    const runId = "run-dup-multi";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}),
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}),
      walLine(runId, 2, WAL_LINE_KIND.Turn, {}),
      walLine(runId, 2, WAL_LINE_KIND.Turn, {}),
    ]);

    const err = expectLeft(yield* Effect.either(inspectRun(runId, resultsDir)));
    const cause = expectCauseTag(err.cause, INSPECT_CAUSE.DuplicateSeq);
    expect(cause.seq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. malformed JSON line → silently skipped.
// ---------------------------------------------------------------------------

describe("inspect malformed-JSON line handling", () => {
  itEffect("skips malformed lines and keeps valid ones in the report", function* () {
    const resultsDir = mkTmpResultsDir("malformed");
    const runId = "run-malformed";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    const file = path.join(inflightDir, `${runId}.jsonl`);
    const goodLine = JSON.stringify(
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "planning" }),
    );
    fs.writeFileSync(
      file,
      `${goodLine}\n{not valid json\n{"also": "bad json without closing\n`,
      "utf8",
    );

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]?.kind).toBe(WAL_LINE_KIND.Phase);
  });

  itEffect("returns an empty report when every line is malformed", function* () {
    const resultsDir = mkTmpResultsDir("all-malformed");
    const runId = "run-all-malformed";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    const file = path.join(inflightDir, `${runId}.jsonl`);
    fs.writeFileSync(file, "not json at all\n{broken\n", "utf8");

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.events).toHaveLength(0);
    expect(report.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. unknown envelope v → line skipped (not present in report).
// ---------------------------------------------------------------------------

describe("inspect unknown-v handling", () => {
  itEffect("skips v≠1 lines while keeping known-v lines", function* () {
    const resultsDir = mkTmpResultsDir("unknown-v");
    const runId = "run-unknown-v";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }, 2),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }, WAL_LINE_VERSION),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]?.kind).toBe(WAL_LINE_KIND.Turn);
    expect(report.events[0]?.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty / present file resolution and source labeling.
// ---------------------------------------------------------------------------

describe("inspect file resolution", () => {
  itEffect("returns an empty report for an empty inflight file", function* () {
    const resultsDir = mkTmpResultsDir("empty");
    const runId = "run-empty";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, `${runId}.jsonl`), "", "utf8");

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.events).toHaveLength(0);
    expect(report.outcome).toBeNull();
  });

  itEffect("labels source as 'inflight' when file is in inflight/", function* () {
    const resultsDir = mkTmpResultsDir("label-inflight");
    const runId = "run-label-inflight";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, `${runId}.jsonl`), "", "utf8");

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.source).toBe(INSPECT_SOURCE.Inflight);
  });

  itEffect("labels source as 'completed' when file is in runs/", function* () {
    const resultsDir = mkTmpResultsDir("label-completed");
    const runId = "run-label-completed";
    const runsDir = path.join(resultsDir, "runs");

    writeRunsFile(runsDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Outcome, { status: "completed" }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.source).toBe(INSPECT_SOURCE.Completed);
  });

  itEffect("fails with RunNotFound when run does not exist anywhere", function* () {
    const resultsDir = mkTmpResultsDir("not-found");
    const runId = "run-does-not-exist";

    const err = expectLeft(yield* Effect.either(inspectRun(runId, resultsDir)));
    const cause = expectCauseTag(err.cause, INSPECT_CAUSE.RunNotFound);
    expect(cause.runId).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// 6. Outcome view extraction.
// ---------------------------------------------------------------------------

describe("inspect outcome extraction", () => {
  itEffect("surfaces the outcome status from a completed run", function* () {
    const resultsDir = mkTmpResultsDir("render-outcome");
    const runId = "run-render-outcome";
    const runsDir = path.join(resultsDir, "runs");
    const outcomeStatus = "completed";

    writeRunsFile(runsDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "run" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 2, WAL_LINE_KIND.Outcome, { status: outcomeStatus }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.outcome).not.toBeNull();
    expect(report.outcome?.status).toBe(outcomeStatus);
    expect(report.events).toHaveLength(2);
    expect(report.events.map((e) => e.kind)).toEqual([
      WAL_LINE_KIND.Phase,
      WAL_LINE_KIND.Turn,
    ]);
  });

  itEffect("returns null outcome when no Outcome line is present", function* () {
    const resultsDir = mkTmpResultsDir("render-inflight");
    const runId = "run-render-inflight";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "setup" }),
    ]);

    const report = yield* inspectRun(runId, resultsDir);
    expect(report.outcome).toBeNull();
    expect(report.source).toBe(INSPECT_SOURCE.Inflight);
  });
});

// ---------------------------------------------------------------------------
// 7. Effect channel sanity — Exit-tag checks via Effect's helpers.
// ---------------------------------------------------------------------------

describe("inspect Effect outcome", () => {
  itEffect("a malformed-only file still resolves successfully", function* () {
    const resultsDir = mkTmpResultsDir("exit-success");
    const runId = "run-exit-success";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, `${runId}.jsonl`), "garbage\n", "utf8");

    const exit = yield* Effect.exit(inspectRun(runId, resultsDir));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  itEffect("duplicate seq fails the Effect", function* () {
    const resultsDir = mkTmpResultsDir("exit-failure");
    const runId = "run-exit-failure";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}),
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}),
    ]);

    const exit = yield* Effect.exit(inspectRun(runId, resultsDir));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
