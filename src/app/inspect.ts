// CLI module for `cc-judge inspect <runId>`.
// Spec: chughtapan/cc-judge#77 (safer:implement-senior).
// Design: §"Recommended Approach step 3" — inspect CLI, §"WAL line schema".
//
// Acceptance (verbatim from #77):
//   * reads WAL (inflight or completed), prints timeline of phases, turns,
//     events, outcome; works mid-run (inflight/ first, runs/ second).
//   * seq-gap detection → stderr warns 'missing seq N'.
//   * duplicate seq → Effect fails with InspectError{DuplicateSeq}.
//   * malformed JSON line → silently skipped (matches report.ts:readRunsJsonl).
//   * unknown envelope v → stderr warns 'newer cc-judge wrote this'; line skipped.
//   * empty inflight → stdout 'no events, no outcome'.

import { Data, Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  WAL_LINE_KIND,
  WAL_LINE_VERSION,
  walPathsFromResultsDir,
  type WalLine,
  type WalLineKind,
  type WalPaths,
} from "../emit/wal.js";

// ---------------------------------------------------------------------------
// Typed error channel (PRINCIPLES.md §3: errors are typed, not thrown).
// ---------------------------------------------------------------------------

export type InspectErrorCause =
  | { readonly _tag: "RunNotFound"; readonly runId: string }
  | { readonly _tag: "DuplicateSeq"; readonly seq: number; readonly runId: string };

export const InspectErrorCause = Data.taggedEnum<InspectErrorCause>();

export const INSPECT_CAUSE = {
  RunNotFound: "RunNotFound",
  DuplicateSeq: "DuplicateSeq",
} as const satisfies { readonly [K in InspectErrorCause["_tag"]]: K };

export class InspectError extends Data.TaggedError("InspectError")<{
  readonly cause: InspectErrorCause;
}> {}

// ---------------------------------------------------------------------------
// WAL file resolution: inflight/ first, runs/ second.
// ---------------------------------------------------------------------------

function resolveWalFile(
  runId: string,
  walPaths: WalPaths,
): { readonly file: string; readonly source: "inflight" | "completed" } | null {
  const inflightFile = path.join(walPaths.inflightDir, `${runId}.jsonl`);
  if (fs.existsSync(inflightFile)) return { file: inflightFile, source: "inflight" };
  const runsFile = path.join(walPaths.runsDir, `${runId}.jsonl`);
  if (fs.existsSync(runsFile)) return { file: runsFile, source: "completed" };
  return null;
}

// ---------------------------------------------------------------------------
// JSONL parsing — three per-line outcomes:
//   1. malformed JSON → silent skip (matching report.ts:readRunsJsonl pattern).
//   2. unknown v → stderr warn + skip.
//   3. valid v=1 line → collected.
// ---------------------------------------------------------------------------

interface ParseResult {
  readonly lines: ReadonlyArray<WalLine>;
}

function parseWalFile(file: string): ParseResult {
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(file, "utf8");
  } catch (err) {
    void err;
    return { lines: [] };
  }
  if (rawContent.length === 0) return { lines: [] };

  const lines: WalLine[] = [];
  for (const rawLine of rawContent.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      void err;
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;

    const v = (parsed as { v?: unknown })["v"];

    if (typeof v !== "number") continue;

    if (v !== WAL_LINE_VERSION) {
      process.stderr.write(
        `cc-judge inspect: newer cc-judge wrote this (v=${String(v)}); line skipped\n`,
      );
      continue;
    }

    lines.push(parsed as WalLine);
  }

  return { lines };
}

// ---------------------------------------------------------------------------
// Seq validation.
// Orphaned marker (seq=-1) is excluded from validation per wal.ts design.
// ---------------------------------------------------------------------------

interface SeqCheck {
  readonly gaps: ReadonlyArray<number>;
  readonly duplicates: ReadonlyArray<number>;
}

function checkSeqs(lines: ReadonlyArray<WalLine>): SeqCheck {
  // Orphaned marker uses seq=-1 by WAL spec; excluded from seq counting.
  const real = lines.filter((l) => l.kind !== WAL_LINE_KIND.Orphaned);
  if (real.length === 0) return { gaps: [], duplicates: [] };

  const seen = new Map<number, number>();
  for (const l of real) {
    seen.set(l.seq, (seen.get(l.seq) ?? 0) + 1);
  }

  const duplicates: number[] = [];
  for (const [s, count] of seen) {
    if (count > 1) duplicates.push(s);
  }
  duplicates.sort((a, b) => a - b);

  const seqList = [...seen.keys()].sort((a, b) => a - b);
  if (seqList.length <= 1) return { gaps: [], duplicates };

  const first = seqList[0] as number;
  const last = seqList[seqList.length - 1] as number;
  const gaps: number[] = [];
  for (let i = first + 1; i < last; i++) {
    if (!seen.has(i)) gaps.push(i);
  }

  return { gaps, duplicates };
}

// ---------------------------------------------------------------------------
// Timeline rendering (PRINCIPLES.md §4: exhaustive switch on WalLineKind).
// ---------------------------------------------------------------------------

function summaryForPayload(kind: WalLineKind, payload: unknown): string {
  // Typed field accessors avoid the record-cast lint rule while keeping the
  // switch exhaustive (PRINCIPLES.md §4: default: exhaustiveCheck(kind)).
  type Obj = {
    name?: unknown;
    index?: unknown;
    type?: unknown;
    status?: unknown;
    reason?: unknown;
  };
  const obj: Obj =
    typeof payload === "object" && payload !== null ? (payload as Obj) : {};

  switch (kind) {
    case WAL_LINE_KIND.Phase:
      return typeof obj.name === "string" ? `name=${obj.name}` : "";
    case WAL_LINE_KIND.Turn:
      return typeof obj.index === "number" ? `index=${String(obj.index)}` : "";
    case WAL_LINE_KIND.Event:
      return typeof obj.type === "string" ? `type=${obj.type}` : "";
    case WAL_LINE_KIND.Context:
      return "";
    case WAL_LINE_KIND.WorkspaceDiff:
      return "";
    case WAL_LINE_KIND.Outcome: {
      if (typeof obj.status !== "string") return "";
      const reason =
        typeof obj.reason === "string" ? ` reason=${obj.reason}` : "";
      return `status=${obj.status}${reason}`;
    }
    case WAL_LINE_KIND.Orphaned:
      return "(orphaned)";
    default: {
      // Compile-time exhaustiveness: TypeScript errors here if a new
      // WalLineKind is added without a matching case (PRINCIPLES.md §4).
      const exhaustiveCheck: never = kind;
      void exhaustiveCheck;
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Structured report — the testable surface of inspect.
//
// `inspectRun` returns this report; `formatInspectReport` turns it into the
// CLI's stdout/stderr strings. Tests assert on the report; rendering is just
// presentation.
// ---------------------------------------------------------------------------

export type InspectSource = "inflight" | "completed";

export const INSPECT_SOURCE = {
  Inflight: "inflight",
  Completed: "completed",
} as const satisfies { readonly [K in Capitalize<InspectSource>]: Uncapitalize<K> };

export interface InspectOutcomeView {
  readonly status: string | null;
  readonly reason: string | null;
}

export interface InspectReport {
  readonly runId: string;
  readonly source: InspectSource;
  readonly events: ReadonlyArray<WalLine>;
  readonly outcome: InspectOutcomeView | null;
  readonly gaps: ReadonlyArray<number>;
}

function readOutcomePayload(line: WalLine): InspectOutcomeView {
  type OutcomePayload = { status?: unknown; reason?: unknown };
  const p: OutcomePayload =
    typeof line.payload === "object" && line.payload !== null
      ? (line.payload as OutcomePayload)
      : {};
  return {
    status: typeof p.status === "string" ? p.status : null,
    reason: typeof p.reason === "string" ? p.reason : null,
  };
}

function buildReport(
  runId: string,
  source: InspectSource,
  lines: ReadonlyArray<WalLine>,
  gaps: ReadonlyArray<number>,
): InspectReport {
  const events = lines
    .filter((l) => l.kind !== WAL_LINE_KIND.Outcome && l.kind !== WAL_LINE_KIND.Orphaned)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const outcomeLines = lines.filter((l) => l.kind === WAL_LINE_KIND.Outcome);
  const lastOutcome = outcomeLines[outcomeLines.length - 1];

  return {
    runId,
    source,
    events,
    outcome: lastOutcome !== undefined ? readOutcomePayload(lastOutcome) : null,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Rendering — pure string formatting. Not unit-tested directly.
// ---------------------------------------------------------------------------

export interface InspectRenderOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export function formatInspectReport(report: InspectReport): InspectRenderOutput {
  const stderrParts: string[] = [];
  for (const missing of report.gaps) {
    stderrParts.push(
      `cc-judge inspect: warning: missing seq ${String(missing)}\n`,
    );
  }

  const stdoutParts: string[] = [];
  stdoutParts.push(`cc-judge inspect: run ${report.runId} [${report.source}]\n\n`);

  if (report.events.length === 0 && report.outcome === null) {
    stdoutParts.push("  no events, no outcome\n");
    return { stdout: stdoutParts.join(""), stderr: stderrParts.join("") };
  }

  const lastEvent = report.events[report.events.length - 1];
  const maxSeq = lastEvent !== undefined ? lastEvent.seq : 0;
  const seqWidth = Math.max(String(maxSeq).length, 1);

  for (const l of report.events) {
    const seqStr = String(l.seq).padStart(seqWidth, " ");
    const ts = new Date(l.ts).toISOString();
    const kind = l.kind.padEnd(14, " ");
    const summary = summaryForPayload(l.kind, l.payload);
    const tail = summary.length > 0 ? `  ${summary}` : "";
    stdoutParts.push(`  ${seqStr}  ${ts}  ${kind}${tail}\n`);
  }

  if (report.outcome !== null) {
    const status = report.outcome.status ?? "unknown";
    const reason = report.outcome.reason !== null ? ` (${report.outcome.reason})` : "";
    stdoutParts.push(`\n  outcome: ${status}${reason}\n`);
  } else {
    const msg =
      report.source === "inflight" ? "run still in flight" : "no outcome line found";
    stdoutParts.push(`\n  outcome: (none — ${msg})\n`);
  }

  return { stdout: stdoutParts.join(""), stderr: stderrParts.join("") };
}

// ---------------------------------------------------------------------------
// Public entrypoint — exported for SDK use and CLI wiring in cli.ts.
// `inspectRun` returns the structured report; CLI wraps it with rendering.
// ---------------------------------------------------------------------------

export function inspectRun(
  runId: string,
  resultsDir: string,
): Effect.Effect<InspectReport, InspectError, never> {
  return Effect.suspend(() => {
    const walPaths = walPathsFromResultsDir(path.resolve(resultsDir));
    const resolved = resolveWalFile(runId, walPaths);

    if (resolved === null) {
      return Effect.fail(new InspectError({ cause: InspectErrorCause.RunNotFound({ runId }) }));
    }

    const { file, source } = resolved;
    const { lines } = parseWalFile(file);
    const { gaps, duplicates } = checkSeqs(lines);

    const firstDup = duplicates[0];
    if (firstDup !== undefined) {
      return Effect.fail(
        new InspectError({ cause: InspectErrorCause.DuplicateSeq({ seq: firstDup, runId }) }),
      );
    }

    return Effect.succeed(buildReport(runId, source, lines, gaps));
  });
}

export function inspectRunAndPrint(
  runId: string,
  resultsDir: string,
): Effect.Effect<void, InspectError, never> {
  return Effect.flatMap(inspectRun(runId, resultsDir), (report) =>
    Effect.sync(() => {
      const { stdout, stderr } = formatInspectReport(report);
      if (stderr.length > 0) process.stderr.write(stderr);
      if (stdout.length > 0) process.stdout.write(stdout);
    }),
  );
}
