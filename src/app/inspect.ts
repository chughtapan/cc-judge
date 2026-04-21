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

function renderTimeline(
  lines: ReadonlyArray<WalLine>,
  source: "inflight" | "completed",
): void {
  const eventLines = lines.filter(
    (l) => l.kind !== WAL_LINE_KIND.Outcome && l.kind !== WAL_LINE_KIND.Orphaned,
  );
  const outcomeLines = lines.filter((l) => l.kind === WAL_LINE_KIND.Outcome);

  if (eventLines.length === 0 && outcomeLines.length === 0) {
    process.stdout.write("  no events, no outcome\n");
    return;
  }

  const sorted = [...eventLines].sort((a, b) => a.seq - b.seq);
  const lastLine = sorted[sorted.length - 1];
  const maxSeq = lastLine !== undefined ? lastLine.seq : 0;
  const seqWidth = Math.max(String(maxSeq).length, 1);

  const out: string[] = [];
  for (const l of sorted) {
    const seqStr = String(l.seq).padStart(seqWidth, " ");
    const ts = new Date(l.ts).toISOString();
    const kind = l.kind.padEnd(14, " ");
    const summary = summaryForPayload(l.kind, l.payload);
    const tail = summary.length > 0 ? `  ${summary}` : "";
    out.push(`  ${seqStr}  ${ts}  ${kind}${tail}\n`);
  }

  const lastOutcome = outcomeLines[outcomeLines.length - 1];
  if (lastOutcome !== undefined) {
    type OutcomePayload = { status?: unknown; reason?: unknown };
    const p: OutcomePayload =
      typeof lastOutcome.payload === "object" && lastOutcome.payload !== null
        ? (lastOutcome.payload as OutcomePayload)
        : {};
    const status = typeof p.status === "string" ? p.status : "unknown";
    const reason = typeof p.reason === "string" ? ` (${p.reason})` : "";
    out.push(`\n  outcome: ${status}${reason}\n`);
  } else {
    const msg =
      source === "inflight" ? "run still in flight" : "no outcome line found";
    out.push(`\n  outcome: (none — ${msg})\n`);
  }

  process.stdout.write(out.join(""));
}

// ---------------------------------------------------------------------------
// Public entrypoint — exported for SDK use and CLI wiring in cli.ts.
// ---------------------------------------------------------------------------

export function inspectRun(
  runId: string,
  resultsDir: string,
): Effect.Effect<void, InspectError, never> {
  return Effect.suspend(() => {
    const walPaths = walPathsFromResultsDir(path.resolve(resultsDir));
    const resolved = resolveWalFile(runId, walPaths);

    if (resolved === null) {
      return Effect.fail(new InspectError({ cause: { _tag: "RunNotFound", runId } }));
    }

    const { file, source } = resolved;
    const { lines } = parseWalFile(file);
    const { gaps, duplicates } = checkSeqs(lines);

    // Duplicate seq aborts: the file cannot be reliably interpreted.
    const firstDup = duplicates[0];
    if (firstDup !== undefined) {
      return Effect.fail(
        new InspectError({ cause: { _tag: "DuplicateSeq", seq: firstDup, runId } }),
      );
    }

    // Gap detection is advisory: warn but continue rendering.
    for (const missing of gaps) {
      process.stderr.write(
        `cc-judge inspect: warning: missing seq ${String(missing)}\n`,
      );
    }

    process.stdout.write(`cc-judge inspect: run ${runId} [${source}]\n\n`);
    renderTimeline(lines, source);

    return Effect.void;
  });
}
