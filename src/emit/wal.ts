// Write-ahead log substrate for cc-judge runs.
//
// Spec: chughtapan/cc-judge#75 (safer:implement-staff).
// Design: "cc-judge observability substrate" (/office-hours 2026-04-21) —
//   §"Recommended Approach step 2", §"Multi-agent seq race protection",
//   §"Recovery sweep rule", §"WAL line schema".
//
// Scope this release (spec acceptance, verbatim):
//   * `openRunLog(runId) -> {append(event), close(outcome)}`.
//   * One file handle per runId.
//   * Appends via `fs.appendFileSync` (no fsync per event).
//   * `fsync` + atomic rename `inflight/<runId>.jsonl ->
//     runs/<runId>.jsonl` on `close()` only, with `inflight/` and
//     `runs/` as siblings under `results/`.
//   * `Effect.acquireRelease` wraps the WAL lifecycle.
//   * Concurrency via `proper-lockfile` npm.
//   * Startup recovery sweep: outcome-present vs outcome-absent rule.
//   * Multi-agent `seq` monotonicity via `Effect.Semaphore`.
//   * Envelope `{ v, runId, seq, ts, kind, payload }` — internal only
//     this release (§"WAL line schema"). NOT a public contract.
//   * Invariant #12: try/catch swallow on the hot path + structured
//     warning log on WAL failure.
//
// Out of scope: wiring the WAL into `NormalizedBundleSink` (that is P1-a
// #74, "sink unification"). `emitRun` reading from the WAL is #80.
// `cc-judge inspect` is P0-c #77. This file only ships the substrate
// module + recovery sweep + its own tests.

import { Effect, Scope } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";
import { RunId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Envelope constants + kinds. The envelope version is bumped only on
// breaking shape changes; it is NOT a public contract this release.
// ---------------------------------------------------------------------------

export const WAL_LINE_VERSION = 1;

// WAL line `kind` discriminator. Maps 1:1 to `NormalizedBundleSink`
// record* methods so the future sink-unification work (#74) can adopt
// these tags verbatim, plus `outcome` (terminal line written by
// `close()`) and `orphaned` (marker the recovery sweep appends when an
// inflight file is reclaimed without a terminal outcome).
export const WAL_LINE_KIND = {
  Turn: "turn",
  Event: "event",
  Phase: "phase",
  Context: "context",
  WorkspaceDiff: "workspace-diff",
  Outcome: "outcome",
  Orphaned: "orphaned",
} as const;
export type WalLineKind = (typeof WAL_LINE_KIND)[keyof typeof WAL_LINE_KIND];

// Internal telemetry source for structured warnings. Test code keys on
// this string; callers inspecting logs key on it.
export const WAL_WARN_SOURCE = "cc-judge:wal";

// Structured warning event tags emitted by walWarn(). Tests assert on
// these; production observers may key on them.
export const WAL_WARN_EVENT = {
  MkdirFailed: "mkdir.failed",
  PrecreateFailed: "precreate.failed",
  LockFailed: "lock.failed",
  AppendFailed: "append.failed",
  AppendAfterClose: "append.after-close",
  OutcomeAppendFailed: "outcome.append.failed",
  FsyncFailed: "fsync.failed",
  UnlockFailed: "unlock.failed",
  RenameFailed: "rename.failed",
  SweepReaddirFailed: "sweep.readdir.failed",
  SweepCheckFailed: "sweep.check.failed",
  SweepMarkOrphanedFailed: "sweep.mark-orphaned.failed",
  SweepRenameFailed: "sweep.rename.failed",
  SweepScanFailed: "sweep.scan.failed",
} as const;
export type WalWarnEvent = (typeof WAL_WARN_EVENT)[keyof typeof WAL_WARN_EVENT];

// `close()` status channel. The WAL records this on the terminal
// outcome line; it is not read by anything else in this release.
export const RUN_CLOSE_STATUS = {
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type RunCloseStatus = (typeof RUN_CLOSE_STATUS)[keyof typeof RUN_CLOSE_STATUS];

// Recovery-sweep per-file outcomes, used as the return shape so callers
// and tests can key on concrete tags rather than parse strings.
export const RECOVERY_OUTCOME = {
  Completed: "completed",
  Orphaned: "orphaned",
  Locked: "locked",
  Failed: "failed",
} as const;
export type RecoveryOutcome = (typeof RECOVERY_OUTCOME)[keyof typeof RECOVERY_OUTCOME];

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

// Caller-facing envelope. `seq` + `ts` + `v` are stamped by the handle;
// the caller supplies `kind` + `payload`.
export interface WalLineInput {
  readonly kind: WalLineKind;
  readonly payload: unknown;
}

// Full envelope written to the JSONL file.
export interface WalLine {
  readonly v: number;
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: WalLineKind;
  readonly payload: unknown;
}

// Terminal `close()` descriptor. Recorded as the last line of the WAL
// under kind="outcome" before fsync + rename.
export interface RunCloseOutcome {
  readonly status: RunCloseStatus;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// Directory layout under `results/`. `inflight/` and `runs/` MUST live
// on the same filesystem so the close-time rename is atomic.
export interface WalPaths {
  readonly resultsDir: string;
  readonly inflightDir: string;
  readonly runsDir: string;
}

// Per-run WAL handle. `openRunLog` returns this via `Effect.acquireRelease`
// so scope release guarantees `close()` fires exactly once even on
// interrupt/exception.
export interface RunLogHandle {
  readonly runId: string;
  readonly paths: WalPaths;
  append(line: WalLineInput): Effect.Effect<void, never, never>;
  close(outcome: RunCloseOutcome): Effect.Effect<void, never, never>;
  isClosed(): boolean;
}

// Per-file result of the startup recovery sweep.
export interface RecoveredFile {
  readonly runId: string;
  readonly outcome: RecoveryOutcome;
  // Source path (before rename if rename happened).
  readonly inflightPath: string;
  // Destination path after rename, or `null` if the file was left in place
  // (e.g., lock held by a live process).
  readonly runsPath: string | null;
}

export interface RecoverySweepResult {
  readonly scanned: number;
  readonly recovered: ReadonlyArray<RecoveredFile>;
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

// Derive the standard `inflight/` and `runs/` sibling layout from a
// caller-supplied `results/` parent. Callers do not need to construct
// `WalPaths` themselves.
export function walPathsFromResultsDir(resultsDir: string): WalPaths {
  return {
    resultsDir,
    inflightDir: path.join(resultsDir, "inflight"),
    runsDir: path.join(resultsDir, "runs"),
  };
}

// ---------------------------------------------------------------------------
// Structured warning log (invariant #12). Every WAL-hot-path fs op that
// throws is routed here so operators can see a WAL silently degraded
// instead of the eval's primary output going missing.
// ---------------------------------------------------------------------------

// Bound the size of payload previews emitted into walWarn so a giant
// payload can't blow up the structured log line. Operators get enough to
// identify the lost event without flooding stderr.
export const PAYLOAD_PREVIEW_MAX_CHARS = 200;

/**
 * Render a payload as a short JSON preview suitable for embedding inline
 * in a structured log line. Returns "<unstringifiable>" for values
 * JSON.stringify cannot represent (functions, symbols, circular refs).
 * Exported for direct property-based testing.
 * @internal
 */
export const UNSTRINGIFIABLE_PAYLOAD = "<unstringifiable>";
export const UNSTRINGIFIABLE_ERROR = "<unstringifiable error>";

export function previewPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) return UNSTRINGIFIABLE_PAYLOAD;
    return serialized.length > PAYLOAD_PREVIEW_MAX_CHARS
      ? `${serialized.slice(0, PAYLOAD_PREVIEW_MAX_CHARS)}…`
      : serialized;
  } catch (err) {
    void err;
    return UNSTRINGIFIABLE_PAYLOAD;
  }
}

function walWarn(event: WalWarnEvent, detail: Readonly<Record<string, unknown>>): void {
  // Single-line JSON for log-aggregator compatibility. `process.stderr`
  // not `console.warn` so test harnesses that capture `console.*` don't
  // drown in expected warnings.
  try {
    const line = JSON.stringify({
      level: "warn",
      source: WAL_WARN_SOURCE,
      event,
      ts: Date.now(),
      ...detail,
    });
    process.stderr.write(`${line}\n`);
  } catch (err) { void err; /* invariant #12: swallow */ }
}

// ---------------------------------------------------------------------------
// Handle internals.
// ---------------------------------------------------------------------------

interface HandleState {
  seq: number;
  closed: boolean;
  locked: boolean;
}

function inflightPathFor(paths: WalPaths, runId: string): string {
  return path.join(paths.inflightDir, `${runId}.jsonl`);
}

function runsPathFor(paths: WalPaths, runId: string): string {
  return path.join(paths.runsDir, `${runId}.jsonl`);
}

function ensureDirsSync(paths: WalPaths): void {
  // mkdirp both siblings. `recursive: true` so pre-existing dirs are a
  // no-op. Wrapped by the caller in try/catch.
  fs.mkdirSync(paths.inflightDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
}

function writeLineSync(file: string, line: WalLine): void {
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

function fsyncFile(file: string): void {
  // Open-fsync-close. We do not hold a long-lived fd (the design doc
  // explicitly says "no fsync per event"); fsync happens once on
  // `close()` before the atomic rename.
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// `openRunLog` — the acquire side of Effect.acquireRelease.
// ---------------------------------------------------------------------------

// Open a WAL handle for `runId`. The returned `Effect` is scoped: on
// scope release the handle's `close()` fires with status="failed" if
// the caller never called `close()` explicitly. Callers that want the
// "completed" path explicit should call `handle.close({ status:
// "completed" })` before the scope exits.
export function openRunLog(
  runIdInput: RunId | string,
  paths: WalPaths,
): Effect.Effect<RunLogHandle, never, Scope.Scope> {
  const runId = String(runIdInput);

  return Effect.acquireRelease(
    Effect.sync(() => {
      const file = inflightPathFor(paths, runId);
      const state: HandleState = { seq: 0, closed: false, locked: false };

      // Create inflight dir (and runs dir, so the close-time rename
      // doesn't fail on first run).
      try {
        ensureDirsSync(paths);
      } catch (err) {
        walWarn(WAL_WARN_EVENT.MkdirFailed, {
          runId,
          inflightDir: paths.inflightDir,
          runsDir: paths.runsDir,
          error: errorToString(err),
        });
      }

      // Pre-create the empty inflight file so proper-lockfile has a
      // target to lock. lockSync with `realpath: false` because the file
      // may live on a tmpfs / overlayfs where realpath is lossy.
      try {
        fs.writeFileSync(file, "", { flag: "a" });
      } catch (err) {
        walWarn(WAL_WARN_EVENT.PrecreateFailed, { runId, file, error: errorToString(err) });
      }

      try {
        lockfile.lockSync(file, { realpath: false, retries: 0 });
        state.locked = true;
      } catch (err) {
        // Another process already owns this runId. Per the spec we still
        // return a handle; the hot-path writes will land in the shared
        // file with best-effort seq. The recovery-sweep contract keys on
        // the LOCK being held, not on our in-memory state, so lock
        // collision here is diagnostic, not fatal.
        walWarn(WAL_WARN_EVENT.LockFailed, { runId, file, error: errorToString(err) });
      }

      return makeHandle(runId, paths, state);
    }),
    (handle) => {
      // Release-path close: fires if the caller never called close()
      // explicitly (scope interrupt, exception in `Effect.scoped`).
      // `close()` itself is idempotent via the `closed` flag, so an
      // explicit close() followed by scope release is a no-op on the
      // second call.
      return handle.close({
        status: RUN_CLOSE_STATUS.Failed,
        reason: "scope released without explicit close",
      });
    },
  );
}

function makeHandle(
  runId: string,
  paths: WalPaths,
  state: HandleState,
): RunLogHandle {
  const file = inflightPathFor(paths, runId);

  // Serialize all appends through an Effect.Semaphore so multi-agent
  // concurrent emissions produce a strictly monotonic `seq` (design
  // doc §"Multi-agent seq race protection").
  // `Effect.makeSemaphore(1)` is synchronous-ish (no IO); we build it
  // once here so every subsequent call reuses the same permit pool.
  const semaphore = Effect.runSync(Effect.makeSemaphore(1));

  // No per-line fsync — see docs/WAL.md "Partial-line loss window" for
  // the durability trade-off and how recovery covers run-level loss.
  function appendOneLocked(input: WalLineInput): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      if (state.closed) {
        // Invariant #12 keeps this Effect non-failing, so post-close appends
        // are dropped on the floor. To make the loss correlatable, walWarn
        // includes runId, kind, and a short payload preview — operators
        // monitoring the WAL_WARN_SOURCE channel can identify exactly which
        // event went missing. A caller that races its own close against an
        // emit will see the warning in stderr; the verdict is unaffected.
        walWarn(WAL_WARN_EVENT.AppendAfterClose, {
          runId,
          kind: input.kind,
          attemptedAt: Date.now(),
          payloadPreview: previewPayload(input.payload),
        });
        return;
      }
      const line: WalLine = {
        v: WAL_LINE_VERSION,
        runId,
        seq: state.seq,
        ts: Date.now(),
        kind: input.kind,
        payload: input.payload,
      };
      try {
        writeLineSync(file, line);
        state.seq += 1;
      } catch (err) {
        walWarn(WAL_WARN_EVENT.AppendFailed, {
          runId,
          kind: input.kind,
          seq: state.seq,
          error: errorToString(err),
        });
      }
    });
  }

  return {
    runId,
    paths,
    isClosed: () => state.closed,
    append(input) {
      return semaphore.withPermits(1)(appendOneLocked(input));
    },
    close(outcome) {
      // Serialized so any in-flight append finishes first and the
      // outcome line is guaranteed last.
      return semaphore.withPermits(1)(Effect.sync(() => {
        if (state.closed) return;
        state.closed = true;

        const outcomeLine: WalLine = {
          v: WAL_LINE_VERSION,
          runId,
          seq: state.seq,
          ts: Date.now(),
          kind: WAL_LINE_KIND.Outcome,
          payload: {
            status: outcome.status,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            ...(outcome.details !== undefined ? { details: outcome.details } : {}),
          },
        };

        try {
          writeLineSync(file, outcomeLine);
          state.seq += 1;
        } catch (err) {
          walWarn(WAL_WARN_EVENT.OutcomeAppendFailed, {
            runId,
            error: errorToString(err),
          });
        }

        try {
          fsyncFile(file);
        } catch (err) {
          walWarn(WAL_WARN_EVENT.FsyncFailed, { runId, file, error: errorToString(err) });
        }

        // Release the lock BEFORE the rename. proper-lockfile's
        // `.lock`/`.unlock` sidecars key on the original path; if we
        // rename first the unlock cannot find its own sidecar.
        if (state.locked) {
          try {
            lockfile.unlockSync(file, { realpath: false });
            state.locked = false;
          } catch (err) {
            walWarn(WAL_WARN_EVENT.UnlockFailed, { runId, file, error: errorToString(err) });
          }
        }

        const dest = runsPathFor(paths, runId);
        try {
          fs.renameSync(file, dest);
        } catch (err) {
          walWarn(WAL_WARN_EVENT.RenameFailed, {
            runId,
            from: file,
            to: dest,
            error: errorToString(err),
          });
        }
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Recovery sweep (startup contract, §"Recovery sweep rule").
//
// For every `inflight/<runId>.jsonl`:
//   - If proper-lockfile reports the file's lock is still held by a
//     live process -> skip entirely.
//   - Else if the file contains a terminal outcome line (kind="outcome")
//     -> rename to `runs/<runId>.jsonl` WITHOUT appending a marker (the
//     run completed cleanly but crashed between outcome-append and
//     rename).
//   - Else -> append `{ "kind": "orphaned", ... }` marker, then rename
//     to `runs/<runId>.jsonl`.
//
// All fs ops are wrapped in try/catch per invariant #12; failure of a
// single file does not abort the sweep.
// ---------------------------------------------------------------------------

export function recoverySweep(
  paths: WalPaths,
): Effect.Effect<RecoverySweepResult, never, never> {
  return Effect.sync(() => {
    const recovered: RecoveredFile[] = [];
    let entries: ReadonlyArray<string>;

    try {
      // The inflight dir may not exist yet (first-ever run). Treat
      // ENOENT as a no-op sweep.
      entries = fs.readdirSync(paths.inflightDir);
    } catch (err) {
      if (!isEnoent(err)) {
        walWarn(WAL_WARN_EVENT.SweepReaddirFailed, {
          inflightDir: paths.inflightDir,
          error: errorToString(err),
        });
      }
      return { scanned: 0, recovered: [] };
    }

    let scanned = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      scanned += 1;

      const runId = entry.slice(0, -".jsonl".length);
      const inflightPath = path.join(paths.inflightDir, entry);
      const result = sweepOneFile(paths, runId, inflightPath);
      recovered.push(result);
    }

    return { scanned, recovered };
  });
}

function sweepOneFile(
  paths: WalPaths,
  runId: string,
  inflightPath: string,
): RecoveredFile {
  // Step 1: lock-held probe. A held lock means some other live process
  // owns this file; leave it alone.
  try {
    const held = lockfile.checkSync(inflightPath, { realpath: false });
    if (held) {
      return {
        runId,
        outcome: RECOVERY_OUTCOME.Locked,
        inflightPath,
        runsPath: null,
      };
    }
  } catch (err) {
    walWarn(WAL_WARN_EVENT.SweepCheckFailed, {
      runId,
      file: inflightPath,
      error: errorToString(err),
    });
    // Fall through: treat an uncheckable lock as "probably stale" and
    // proceed to the outcome-scan step. Worst case we append an
    // orphaned marker onto a file whose owner was briefly unresponsive;
    // that's preferable to leaving stale inflight files around forever.
  }

  // Step 2: scan for a terminal outcome line.
  const hasOutcome = scanFileForOutcome(inflightPath);

  // Step 3: if no outcome, append orphaned marker.
  if (!hasOutcome) {
    try {
      const marker: WalLine = {
        v: WAL_LINE_VERSION,
        runId,
        // seq=-1 so the marker is obvious and doesn't collide with any
        // real append; inspect (#77) keys on kind, not seq.
        seq: -1,
        ts: Date.now(),
        kind: WAL_LINE_KIND.Orphaned,
        payload: { reason: "inflight file recovered without outcome" },
      };
      writeLineSync(inflightPath, marker);
    } catch (err) {
      walWarn(WAL_WARN_EVENT.SweepMarkOrphanedFailed, {
        runId,
        file: inflightPath,
        error: errorToString(err),
      });
      return {
        runId,
        outcome: RECOVERY_OUTCOME.Failed,
        inflightPath,
        runsPath: null,
      };
    }
  }

  // Step 4: rename to runs/.
  const dest = runsPathFor(paths, runId);
  try {
    fs.mkdirSync(paths.runsDir, { recursive: true });
    fs.renameSync(inflightPath, dest);
  } catch (err) {
    walWarn(WAL_WARN_EVENT.SweepRenameFailed, {
      runId,
      from: inflightPath,
      to: dest,
      error: errorToString(err),
    });
    return {
      runId,
      outcome: RECOVERY_OUTCOME.Failed,
      inflightPath,
      runsPath: null,
    };
  }

  return {
    runId,
    outcome: hasOutcome ? RECOVERY_OUTCOME.Completed : RECOVERY_OUTCOME.Orphaned,
    inflightPath,
    runsPath: dest,
  };
}

// Linear-scan the file for a `kind: "outcome"` line. Used only by the
// recovery sweep, where the file size is bounded by one run's event
// count (typically kilobytes-to-megabytes). `readFileSync` is fine.
function scanFileForOutcome(file: string): boolean {
  try {
    const content = fs.readFileSync(file, "utf8");
    if (content.length === 0) return false;
    const lines = content.split("\n");
    for (const raw of lines) {
      if (raw.length === 0) continue;
      // Malformed lines are silently skipped (matches
      // `readRunsJsonl` policy in `src/emit/report.ts`).
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) { void err; continue; }
      if (isOutcomeLine(parsed)) return true;
    }
    return false;
  } catch (err) {
    walWarn(WAL_WARN_EVENT.SweepScanFailed, { file, error: errorToString(err) });
    return false;
  }
}

/** @internal — exported for direct property-based testing. */
export function isOutcomeLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === WAL_LINE_KIND.Outcome;
}

// ---------------------------------------------------------------------------
// Error helpers.
// ---------------------------------------------------------------------------

/** @internal — exported for direct property-based testing. */
export function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch (inner) { void inner; return UNSTRINGIFIABLE_ERROR; }
}

/** @internal — exported for direct property-based testing. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
