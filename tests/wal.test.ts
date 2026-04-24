// Tests for the WAL substrate (`src/emit/wal.ts`), spec
// chughtapan/cc-judge#75. Each describe-block below maps to a line of
// the spec's acceptance criteria:
//
//   openRunLog/append/close ........... "Happy path" block
//   Effect.acquireRelease lifecycle ... "acquireRelease" block
//   Invariant #12 on ENOSPC ........... "Invariant #12" block
//   Effect.Semaphore seq monotonicity . "Seq monotonicity" block
//   Recovery sweep rule ............... "Recovery sweep" block
//   proper-lockfile concurrency ....... "Lockfile" block
//   WAL line envelope ................. "Envelope" block

import { describe, expect, it, vi } from "vitest";
import { Effect, Scope } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";
import {
  RECOVERY_OUTCOME,
  RUN_CLOSE_STATUS,
  WAL_LINE_KIND,
  WAL_LINE_VERSION,
  openRunLog,
  recoverySweep,
  walPathsFromResultsDir,
  type WalLine,
} from "../src/emit/wal.js";
import { RunId } from "../src/core/types.js";
import { itEffect } from "./support/effect.js";

// ── Test fixture helpers ────────────────────────────────────────────────────

function mkTmpResultsDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cc-judge-wal-${tag}-`));
}

function readJsonl(file: string): ReadonlyArray<WalLine> {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return [];
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WalLine);
}

const TEST_RUN_ID_HAPPY = RunId("run-happy");
const TEST_RUN_ID_ACQ = RunId("run-acq-release");
const TEST_RUN_ID_ENOSPC = RunId("run-enospc");
const TEST_RUN_ID_SEQ = RunId("run-seq");
const TEST_RUN_ID_LOCK1 = RunId("run-lock-1");
const TEST_RUN_ID_SWEEP_CLEAN = RunId("run-sweep-clean");
const TEST_RUN_ID_SWEEP_ORPHAN = RunId("run-sweep-orphan");
const TEST_RUN_ID_SWEEP_LOCKED = RunId("run-sweep-locked");
const TEST_RUN_ID_ENVELOPE = RunId("run-envelope");

const EVENT_COUNT_CONCURRENT = 20;

// ── Happy path: openRunLog/append/close ────────────────────────────────────

describe("WAL happy path (openRunLog/append/close)", () => {
  itEffect("appends lines to inflight and atomically renames to runs on close", function* () {
    const resultsDir = mkTmpResultsDir("happy");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(TEST_RUN_ID_HAPPY, paths);
      yield* handle.append({ kind: WAL_LINE_KIND.Phase, payload: { name: "phase-A" } });
      yield* handle.append({ kind: WAL_LINE_KIND.Turn, payload: { index: 0 } });
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
    }));

    const inflight = path.join(paths.inflightDir, `${TEST_RUN_ID_HAPPY}.jsonl`);
    const final = path.join(paths.runsDir, `${TEST_RUN_ID_HAPPY}.jsonl`);
    expect(fs.existsSync(inflight)).toBe(false);
    expect(fs.existsSync(final)).toBe(true);

    const lines = readJsonl(final);
    expect(lines.length).toBe(3);
    expect(lines[0]?.kind).toBe(WAL_LINE_KIND.Phase);
    expect(lines[1]?.kind).toBe(WAL_LINE_KIND.Turn);
    expect(lines[2]?.kind).toBe(WAL_LINE_KIND.Outcome);
    expect((lines[2]?.payload as { status?: string }).status).toBe(RUN_CLOSE_STATUS.Completed);
  });

  itEffect("creates inflight/ and runs/ as siblings under resultsDir", function* () {
    const resultsDir = mkTmpResultsDir("siblings");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(RunId("sibling-check"), paths);
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
    }));

    expect(fs.existsSync(paths.inflightDir)).toBe(true);
    expect(fs.existsSync(paths.runsDir)).toBe(true);
    expect(path.dirname(paths.inflightDir)).toBe(resultsDir);
    expect(path.dirname(paths.runsDir)).toBe(resultsDir);
  });
});

// ── Effect.acquireRelease lifecycle ─────────────────────────────────────────

describe("WAL Effect.acquireRelease lifecycle", () => {
  itEffect("scope release without explicit close still renames to runs with failed outcome", function* () {
    const resultsDir = mkTmpResultsDir("acq");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(TEST_RUN_ID_ACQ, paths);
      yield* handle.append({ kind: WAL_LINE_KIND.Event, payload: { name: "e1" } });
      // No explicit close — release fires via scope exit.
    }));

    const final = path.join(paths.runsDir, `${TEST_RUN_ID_ACQ}.jsonl`);
    expect(fs.existsSync(final)).toBe(true);
    const lines = readJsonl(final);
    const outcome = lines.find((l) => l.kind === WAL_LINE_KIND.Outcome);
    expect(outcome).toBeDefined();
    expect((outcome?.payload as { status?: string }).status).toBe(RUN_CLOSE_STATUS.Failed);
  });

  itEffect("double-close is a no-op (idempotent)", function* () {
    const resultsDir = mkTmpResultsDir("idemp");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(RunId("run-idemp"), paths);
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
      // Release path fires a second close — handle state must see it as
      // a no-op so no duplicate outcome line is written.
    }));

    const final = path.join(paths.runsDir, "run-idemp.jsonl");
    const lines = readJsonl(final);
    const outcomeLines = lines.filter((l) => l.kind === WAL_LINE_KIND.Outcome);
    expect(outcomeLines.length).toBe(1);
  });
});

// ── Invariant #12: errors on the hot path are swallowed ─────────────────────

describe("WAL invariant #12 (errors swallowed on hot path)", () => {
  itEffect("append after close is silently dropped", function* () {
    const resultsDir = mkTmpResultsDir("post-close");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(RunId("run-post-close"), paths);
      yield* handle.append({ kind: WAL_LINE_KIND.Event, payload: { a: 1 } });
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
      // Post-close append must not throw.
      yield* handle.append({ kind: WAL_LINE_KIND.Event, payload: { a: 2 } });
    }));

    const final = path.join(paths.runsDir, "run-post-close.jsonl");
    const lines = readJsonl(final);
    // Two real lines pre-close (event + outcome). No third event line.
    expect(lines.length).toBe(2);
  });

  itEffect("fs failures on the hot path are swallowed; run continues", function* () {
    // Pre-stage a DIRECTORY at the path where the WAL file should live.
    // `fs.appendFileSync` will throw EISDIR when it tries to open the
    // path for writing — exercises the same try/catch swallow branch
    // that a real ENOSPC would hit, without needing to mock a sealed
    // ESM export.
    const resultsDir = mkTmpResultsDir("enospc");
    const paths = walPathsFromResultsDir(resultsDir);
    fs.mkdirSync(paths.inflightDir, { recursive: true });
    fs.mkdirSync(path.join(paths.inflightDir, `${TEST_RUN_ID_ENOSPC}.jsonl`));

    const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(TEST_RUN_ID_ENOSPC, paths);
      yield* handle.append({ kind: WAL_LINE_KIND.Event, payload: { a: 1 } });
      yield* handle.append({ kind: WAL_LINE_KIND.Event, payload: { a: 2 } });
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
    })));
    // The Effect MUST succeed (invariant #12): fs failures are warned
    // and swallowed, never surface as a Cause.
    expect(exit._tag).toBe("Success");
    // avoid unused-import warning on vi when the spy path is unused
    expect(vi).toBeDefined();
  });
});

// ── Effect.Semaphore seq monotonicity under concurrent emission ─────────────

describe("WAL seq monotonicity (Effect.Semaphore)", () => {
  itEffect(
    "20 concurrent appends produce strictly monotonic seq 0..19",
    function* () {
      const resultsDir = mkTmpResultsDir("seq");
      const paths = walPathsFromResultsDir(resultsDir);

      yield* Effect.scoped(Effect.gen(function* () {
        const handle = yield* openRunLog(TEST_RUN_ID_SEQ, paths);
        const indices = Array.from({ length: EVENT_COUNT_CONCURRENT }, (_, i) => i);
        yield* Effect.forEach(
          indices,
          (i) => handle.append({ kind: WAL_LINE_KIND.Event, payload: { i } }),
          { concurrency: EVENT_COUNT_CONCURRENT },
        );
        yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
      }));

      const final = path.join(paths.runsDir, `${TEST_RUN_ID_SEQ}.jsonl`);
      const lines = readJsonl(final);
      // EVENT_COUNT_CONCURRENT event lines + 1 outcome.
      expect(lines.length).toBe(EVENT_COUNT_CONCURRENT + 1);
      const eventSeqs = lines
        .filter((l) => l.kind === WAL_LINE_KIND.Event)
        .map((l) => l.seq)
        .sort((a, b) => a - b);
      // Strictly monotonic: 0..19, no duplicates, no gaps.
      expect(eventSeqs).toEqual(Array.from({ length: EVENT_COUNT_CONCURRENT }, (_, i) => i));
      // Outcome is last.
      expect(lines[lines.length - 1]?.kind).toBe(WAL_LINE_KIND.Outcome);
      expect(lines[lines.length - 1]?.seq).toBe(EVENT_COUNT_CONCURRENT);
    },
    20_000,
  );
});

// ── proper-lockfile concurrency ─────────────────────────────────────────────

describe("WAL proper-lockfile concurrency", () => {
  itEffect(
    "openRunLog acquires a lock that checkSync observes as held; released on close",
    function* () {
      const resultsDir = mkTmpResultsDir("lock");
      const paths = walPathsFromResultsDir(resultsDir);
      const file = path.join(paths.inflightDir, `${TEST_RUN_ID_LOCK1}.jsonl`);

      let heldDuringRun = false;
      yield* Effect.scoped(Effect.gen(function* () {
        yield* openRunLog(TEST_RUN_ID_LOCK1, paths);
        heldDuringRun = lockfile.checkSync(file, { realpath: false });
      }));

      expect(heldDuringRun).toBe(true);
      // After scope exits, the file has been renamed to runs/ so
      // checkSync on the inflight path would ENOENT. That's fine —
      // what matters is that the lock was released cleanly before
      // rename (tested indirectly: if it hadn't, rename would fail
      // and the inflight file would still exist).
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(path.join(paths.runsDir, `${TEST_RUN_ID_LOCK1}.jsonl`))).toBe(true);
    },
  );

  itEffect("second openRunLog on the same runId after close succeeds", function* () {
    const resultsDir = mkTmpResultsDir("lock-reuse");
    const paths = walPathsFromResultsDir(resultsDir);
    const runId = RunId("reusable");

    yield* Effect.scoped(Effect.gen(function* () {
      const h1 = yield* openRunLog(runId, paths);
      yield* h1.close({ status: RUN_CLOSE_STATUS.Completed });
    }));

    // Re-open: first run's file is in runs/ now, so inflight/ is empty.
    // A fresh open creates a new inflight file and locks it.
    yield* Effect.scoped(Effect.gen(function* () {
      const h2 = yield* openRunLog(runId, paths);
      yield* h2.append({ kind: WAL_LINE_KIND.Event, payload: { iteration: 2 } });
      yield* h2.close({ status: RUN_CLOSE_STATUS.Completed });
    }));

    // Both files landed — the first at runs/<id>.jsonl, the second
    // would overwrite (rename is atomic-replace). Just verify the final
    // has the iteration-2 event.
    const final = path.join(paths.runsDir, `${runId}.jsonl`);
    const lines = readJsonl(final);
    const event = lines.find((l) => l.kind === WAL_LINE_KIND.Event);
    expect((event?.payload as { iteration?: number }).iteration).toBe(2);
  });
});

// ── Recovery sweep rule (startup contract) ─────────────────────────────────

describe("WAL recovery sweep", () => {
  itEffect("clean sweep: outcome-present inflight is renamed WITHOUT orphaned marker", function* () {
    const resultsDir = mkTmpResultsDir("sweep-clean");
    const paths = walPathsFromResultsDir(resultsDir);
    fs.mkdirSync(paths.inflightDir, { recursive: true });
    const file = path.join(paths.inflightDir, `${TEST_RUN_ID_SWEEP_CLEAN}.jsonl`);

    // Stage an inflight file with a real outcome line (simulates "run
    // completed cleanly but crashed between outcome-append and rename").
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        v: WAL_LINE_VERSION, runId: TEST_RUN_ID_SWEEP_CLEAN, seq: 0, ts: 1,
        kind: WAL_LINE_KIND.Event, payload: {},
      })}\n${JSON.stringify({
        v: WAL_LINE_VERSION, runId: TEST_RUN_ID_SWEEP_CLEAN, seq: 1, ts: 2,
        kind: WAL_LINE_KIND.Outcome, payload: { status: RUN_CLOSE_STATUS.Completed },
      })}\n`,
    );

    const result = yield* recoverySweep(paths);
    expect(result.scanned).toBe(1);
    expect(result.recovered.length).toBe(1);
    expect(result.recovered[0]?.outcome).toBe(RECOVERY_OUTCOME.Completed);

    const final = path.join(paths.runsDir, `${TEST_RUN_ID_SWEEP_CLEAN}.jsonl`);
    const lines = readJsonl(final);
    expect(lines.some((l) => l.kind === WAL_LINE_KIND.Orphaned)).toBe(false);
    expect(lines.some((l) => l.kind === WAL_LINE_KIND.Outcome)).toBe(true);
  });

  itEffect("orphan sweep: outcome-absent inflight gets orphaned marker + rename", function* () {
    const resultsDir = mkTmpResultsDir("sweep-orphan");
    const paths = walPathsFromResultsDir(resultsDir);
    fs.mkdirSync(paths.inflightDir, { recursive: true });
    const file = path.join(paths.inflightDir, `${TEST_RUN_ID_SWEEP_ORPHAN}.jsonl`);

    // No outcome line — simulates a crash mid-run.
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        v: WAL_LINE_VERSION, runId: TEST_RUN_ID_SWEEP_ORPHAN, seq: 0, ts: 1,
        kind: WAL_LINE_KIND.Turn, payload: { index: 0 },
      })}\n`,
    );

    const result = yield* recoverySweep(paths);
    expect(result.recovered[0]?.outcome).toBe(RECOVERY_OUTCOME.Orphaned);

    const final = path.join(paths.runsDir, `${TEST_RUN_ID_SWEEP_ORPHAN}.jsonl`);
    const lines = readJsonl(final);
    expect(lines.some((l) => l.kind === WAL_LINE_KIND.Orphaned)).toBe(true);
    expect(lines.some((l) => l.kind === WAL_LINE_KIND.Outcome)).toBe(false);
  });

  itEffect("locked sweep: live-lock inflight is SKIPPED (no rename, no marker)", function* () {
    const resultsDir = mkTmpResultsDir("sweep-locked");
    const paths = walPathsFromResultsDir(resultsDir);
    fs.mkdirSync(paths.inflightDir, { recursive: true });
    const file = path.join(paths.inflightDir, `${TEST_RUN_ID_SWEEP_LOCKED}.jsonl`);
    fs.writeFileSync(file, "");

    // Hold the lock for the duration of the sweep.
    const release = lockfile.lockSync(file, { realpath: false, retries: 0 });
    try {
      const result = yield* recoverySweep(paths);
      expect(result.recovered[0]?.outcome).toBe(RECOVERY_OUTCOME.Locked);
      // Inflight still present; runs/ dir has no file for this runId.
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(path.join(paths.runsDir, `${TEST_RUN_ID_SWEEP_LOCKED}.jsonl`))).toBe(false);
    } finally {
      release();
    }
  });

  itEffect("missing inflight dir returns empty sweep result (first run ever)", function* () {
    const resultsDir = mkTmpResultsDir("sweep-empty");
    const paths = walPathsFromResultsDir(resultsDir);
    // Do NOT create inflight dir; mimic a brand-new install.
    const result = yield* recoverySweep(paths);
    expect(result.scanned).toBe(0);
    expect(result.recovered.length).toBe(0);
  });
});

// ── WAL line envelope schema ────────────────────────────────────────────────

describe("WAL line envelope", () => {
  itEffect("every line has v/runId/seq/ts/kind/payload fields", function* () {
    const resultsDir = mkTmpResultsDir("envelope");
    const paths = walPathsFromResultsDir(resultsDir);

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openRunLog(TEST_RUN_ID_ENVELOPE, paths);
      yield* handle.append({ kind: WAL_LINE_KIND.Phase, payload: { name: "x" } });
      yield* handle.close({ status: RUN_CLOSE_STATUS.Completed });
    }));

    const final = path.join(paths.runsDir, `${TEST_RUN_ID_ENVELOPE}.jsonl`);
    const lines = readJsonl(final);
    for (const l of lines) {
      expect(l.v).toBe(WAL_LINE_VERSION);
      expect(l.runId).toBe(TEST_RUN_ID_ENVELOPE);
      expect(typeof l.seq).toBe("number");
      expect(typeof l.ts).toBe("number");
      expect(typeof l.kind).toBe("string");
      expect(l.payload).toBeDefined();
    }
  });
});
