// Tests for `src/app/inspect.ts` — spec chughtapan/cc-judge#77.
//
// Each describe-block maps to one acceptance criterion:
//   seq-gap detection .......... warns 'missing seq 2'
//   duplicate seq .............. aborts with InspectError{DuplicateSeq}
//   malformed JSON line ........ skipped silently
//   unknown envelope v ......... warns 'newer cc-judge wrote this'
//   empty inflight ............. renders 'no events, no outcome'

import { describe, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WAL_LINE_KIND, WAL_LINE_VERSION } from "../src/emit/wal.js";
import { inspectRun, InspectError } from "../src/app/inspect.js";
import { itEffect } from "./support/effect.js";

// ---------------------------------------------------------------------------
// I/O capture helpers (mirrors cli.test.ts installStderrCapture pattern).
// ---------------------------------------------------------------------------

type WriteFn = typeof process.stdout.write;
type Writable = { write: WriteFn };

interface CaptureHandle {
  readonly chunks: string[];
  readonly restore: () => void;
}

function captureStream(stream: NodeJS.WriteStream): CaptureHandle {
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  const spy: WriteFn = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as WriteFn;
  (stream as unknown as Writable).write = spy;
  const restore = (): void => {
    (stream as unknown as Writable).write = original;
  };
  return { chunks, restore };
}

// ---------------------------------------------------------------------------
// WAL line fixture helpers.
// ---------------------------------------------------------------------------

function mkTmpResultsDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cc-judge-inspect-${tag}-`));
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
): string {
  fs.mkdirSync(inflightDir, { recursive: true });
  const file = path.join(inflightDir, `${runId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function writeRunsFile(
  runsDir: string,
  runId: string,
  lines: ReadonlyArray<WalLineFixture>,
): string {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `${runId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// 1. seq-gap detection: seq 0, 1, 3 → warns 'missing seq 2'.
// ---------------------------------------------------------------------------

describe("inspect seq-gap detection", () => {
  let stdoutCapture: CaptureHandle;
  let stderrCapture: CaptureHandle;

  beforeEach(() => {
    stdoutCapture = captureStream(process.stdout);
    stderrCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    stdoutCapture.restore();
    stderrCapture.restore();
  });

  itEffect("warns 'missing seq 2' when seq jumps from 1 to 3", function* () {
    const resultsDir = mkTmpResultsDir("gap");
    const runId = "run-gap-test";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "setup" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      // seq 2 is intentionally missing
      walLine(runId, 3, WAL_LINE_KIND.Event, { type: "tool_use" }),
    ]);

    const result = yield* Effect.exit(inspectRun(runId, resultsDir));
    // Gap detection is advisory — the Effect resolves successfully.
    expect(result._tag).toBe("Success");

    const stderr = stderrCapture.chunks.join("");
    expect(stderr).toContain("missing seq 2");
  });

  itEffect("warns once per missing seq (multiple gaps each emitted)", function* () {
    const resultsDir = mkTmpResultsDir("gap-multi");
    const runId = "run-gap-multi";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      // seqs 1 and 2 missing
      walLine(runId, 3, WAL_LINE_KIND.Turn, { index: 0 }),
    ]);

    yield* inspectRun(runId, resultsDir);

    const stderr = stderrCapture.chunks.join("");
    expect(stderr).toContain("missing seq 1");
    expect(stderr).toContain("missing seq 2");
  });

  itEffect("no gap warning when seqs are contiguous", function* () {
    const resultsDir = mkTmpResultsDir("gap-none");
    const runId = "run-gap-none";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 2, WAL_LINE_KIND.Event, { type: "t" }),
    ]);

    yield* inspectRun(runId, resultsDir);

    const stderr = stderrCapture.chunks.join("");
    expect(stderr).not.toContain("missing seq");
  });
});

// ---------------------------------------------------------------------------
// 2. duplicate seq: aborts with InspectError{DuplicateSeq}.
// ---------------------------------------------------------------------------

describe("inspect duplicate-seq detection", () => {
  itEffect("fails with InspectError{DuplicateSeq} when seq is repeated", function* () {
    const resultsDir = mkTmpResultsDir("dup");
    const runId = "run-dup-test";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 1 }), // duplicate seq=1
    ]);

    const result = yield* Effect.exit(inspectRun(runId, resultsDir));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const err = result.cause;
      // Effect wraps the error in a Cause; unwrap to get the InspectError.
      const inspectErr = (err as { _tag?: string; error?: InspectError }).error;
      expect(inspectErr).toBeInstanceOf(InspectError);
      if (inspectErr instanceof InspectError) {
        expect(inspectErr.cause._tag).toBe("DuplicateSeq");
        if (inspectErr.cause._tag === "DuplicateSeq") {
          expect(inspectErr.cause.seq).toBe(1);
          expect(inspectErr.cause.runId).toBe(runId);
        }
      }
    }
  });

  itEffect("reports the lowest duplicate seq when multiple seqs are repeated", function* () {
    const resultsDir = mkTmpResultsDir("dup-multi");
    const runId = "run-dup-multi";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}),
      walLine(runId, 0, WAL_LINE_KIND.Phase, {}), // dup at 0
      walLine(runId, 2, WAL_LINE_KIND.Turn, {}),
      walLine(runId, 2, WAL_LINE_KIND.Turn, {}), // dup at 2
    ]);

    const result = yield* Effect.either(inspectRun(runId, resultsDir));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.cause._tag).toBe("DuplicateSeq");
      if (result.left.cause._tag === "DuplicateSeq") {
        // duplicates are sorted ascending; lowest dup is 0.
        expect(result.left.cause.seq).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. malformed JSON line: skipped silently (Effect resolves, output intact).
// ---------------------------------------------------------------------------

describe("inspect malformed-JSON line handling", () => {
  itEffect("skips malformed lines silently and renders valid lines", function* () {
    const resultsDir = mkTmpResultsDir("malformed");
    const runId = "run-malformed";
    const inflightDir = path.join(resultsDir, "inflight");

    // Write mix of valid + malformed content manually.
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

    const stdoutCapture = captureStream(process.stdout);
    const result = yield* Effect.ensuring(
      Effect.exit(inspectRun(runId, resultsDir)),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    expect(result._tag).toBe("Success");
    const stdout = stdoutCapture.chunks.join("");
    // The valid phase line must appear in the timeline.
    expect(stdout).toContain("phase");
    expect(stdout).toContain("planning");
  });

  itEffect("handles a file that is entirely malformed JSON (zero valid lines)", function* () {
    const resultsDir = mkTmpResultsDir("all-malformed");
    const runId = "run-all-malformed";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    const file = path.join(inflightDir, `${runId}.jsonl`);
    fs.writeFileSync(file, "not json at all\n{broken\n", "utf8");

    const stdoutCapture = captureStream(process.stdout);
    const result = yield* Effect.ensuring(
      Effect.exit(inspectRun(runId, resultsDir)),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    // All lines malformed → zero valid lines → renders 'no events, no outcome'.
    expect(result._tag).toBe("Success");
    const stdout = stdoutCapture.chunks.join("");
    expect(stdout).toContain("no events, no outcome");
  });
});

// ---------------------------------------------------------------------------
// 4. unknown envelope v: warns 'newer cc-judge wrote this'; line skipped.
// ---------------------------------------------------------------------------

describe("inspect unknown-v handling", () => {
  itEffect("warns 'newer cc-judge wrote this' for v≠1 lines", function* () {
    const resultsDir = mkTmpResultsDir("unknown-v");
    const runId = "run-unknown-v";
    const inflightDir = path.join(resultsDir, "inflight");

    // One v=2 (unknown) line and one v=1 (known) line.
    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }, 2), // unknown v
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }, WAL_LINE_VERSION), // known v
    ]);

    const stderrCapture = captureStream(process.stderr);
    const result = yield* Effect.ensuring(
      Effect.exit(inspectRun(runId, resultsDir)),
      Effect.sync(() => { stderrCapture.restore(); }),
    );

    // The unknown-v line is skipped but the Effect must still resolve.
    expect(result._tag).toBe("Success");

    const stderr = stderrCapture.chunks.join("");
    expect(stderr).toContain("newer cc-judge wrote this");
    // The v= value should appear in the message.
    expect(stderr).toContain("v=2");
  });

  itEffect("does not warn when all lines have v=1", function* () {
    const resultsDir = mkTmpResultsDir("known-v");
    const runId = "run-known-v";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "p" }),
    ]);

    const stderrCapture = captureStream(process.stderr);
    yield* Effect.ensuring(
      inspectRun(runId, resultsDir),
      Effect.sync(() => { stderrCapture.restore(); }),
    );

    expect(stderrCapture.chunks.join("")).not.toContain("newer cc-judge");
  });
});

// ---------------------------------------------------------------------------
// 5. empty inflight: renders 'no events, no outcome'.
// ---------------------------------------------------------------------------

describe("inspect empty-inflight handling", () => {
  itEffect("renders 'no events, no outcome' for an empty inflight file", function* () {
    const resultsDir = mkTmpResultsDir("empty");
    const runId = "run-empty";
    const inflightDir = path.join(resultsDir, "inflight");

    // Stage an empty file in inflight/.
    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, `${runId}.jsonl`), "", "utf8");

    const stdoutCapture = captureStream(process.stdout);
    const result = yield* Effect.ensuring(
      Effect.exit(inspectRun(runId, resultsDir)),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    expect(result._tag).toBe("Success");
    const stdout = stdoutCapture.chunks.join("");
    expect(stdout).toContain("no events, no outcome");
  });

  itEffect("labels the run 'inflight' when file is in inflight/", function* () {
    const resultsDir = mkTmpResultsDir("label-inflight");
    const runId = "run-label-inflight";
    const inflightDir = path.join(resultsDir, "inflight");

    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, `${runId}.jsonl`), "", "utf8");

    const stdoutCapture = captureStream(process.stdout);
    yield* Effect.ensuring(
      inspectRun(runId, resultsDir),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    expect(stdoutCapture.chunks.join("")).toContain("[inflight]");
  });

  itEffect("labels the run 'completed' when file is in runs/", function* () {
    const resultsDir = mkTmpResultsDir("label-completed");
    const runId = "run-label-completed";
    const runsDir = path.join(resultsDir, "runs");

    writeRunsFile(runsDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Outcome, { status: "completed" }),
    ]);

    const stdoutCapture = captureStream(process.stdout);
    yield* Effect.ensuring(
      inspectRun(runId, resultsDir),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    expect(stdoutCapture.chunks.join("")).toContain("[completed]");
  });

  itEffect("fails with RunNotFound when run does not exist in either location", function* () {
    const resultsDir = mkTmpResultsDir("not-found");
    const runId = "run-does-not-exist";

    const result = yield* Effect.either(inspectRun(runId, resultsDir));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.cause._tag).toBe("RunNotFound");
      if (result.left.cause._tag === "RunNotFound") {
        expect(result.left.cause.runId).toBe(runId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Timeline rendering: outcome line and event lines appear in output.
// ---------------------------------------------------------------------------

describe("inspect timeline rendering", () => {
  itEffect("prints the outcome status from a completed run", function* () {
    const resultsDir = mkTmpResultsDir("render-outcome");
    const runId = "run-render-outcome";
    const runsDir = path.join(resultsDir, "runs");

    writeRunsFile(runsDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "run" }),
      walLine(runId, 1, WAL_LINE_KIND.Turn, { index: 0 }),
      walLine(runId, 2, WAL_LINE_KIND.Outcome, { status: "completed" }),
    ]);

    const stdoutCapture = captureStream(process.stdout);
    yield* Effect.ensuring(
      inspectRun(runId, resultsDir),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    const stdout = stdoutCapture.chunks.join("");
    expect(stdout).toContain("outcome: completed");
    expect(stdout).toContain("phase");
    expect(stdout).toContain("name=run");
    expect(stdout).toContain("turn");
    expect(stdout).toContain("index=0");
  });

  itEffect("inflight run with no outcome line shows 'run still in flight'", function* () {
    const resultsDir = mkTmpResultsDir("render-inflight");
    const runId = "run-render-inflight";
    const inflightDir = path.join(resultsDir, "inflight");

    writeInflightFile(inflightDir, runId, [
      walLine(runId, 0, WAL_LINE_KIND.Phase, { name: "setup" }),
    ]);

    const stdoutCapture = captureStream(process.stdout);
    yield* Effect.ensuring(
      inspectRun(runId, resultsDir),
      Effect.sync(() => { stdoutCapture.restore(); }),
    );

    const stdout = stdoutCapture.chunks.join("");
    expect(stdout).toContain("run still in flight");
  });
});
