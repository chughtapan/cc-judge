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
//   1. malformed JSON → silent skip (matching report.ts:readRunsJsonl).
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
  } catch (_err) {
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
    } catch (_err) {
      // Malformed JSON: skip silently, per report.ts:readRunsJsonl pattern.
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;

    const obj = parsed as Record<string, unknown>;
    const v = obj["v"];

    if (typeof v !== "number") {
      // Non-numeric v: treat as malformed, skip silently.
      continue;
    }

    if (v !== WAL_LINE_VERSION) {
      // Future/unknown version: warn with spec-mandated message, then skip.
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
  // Orphaned marker uses seq=-1 by WAL spec; it is not a real event seq.
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
  const gaps: number[] = [];
  if (seqList.length > 1) {
    const first = seqList[0];
    const last = seqList[seqList.length - 1];
    if (first !== undefined && last !== undefined) {
      const seqSet = new Set(seqList);
      for (let i = first + 1; i < last; i++) {
        if (!seqSet.has(i)) gaps.push(i);
      }
    }
  }

  return { gaps, duplicates };
}

// ---------------------------------------------------------------------------
// Timeline rendering (PRINCIPLES.md §4: exhaustive switch on WalLineKind).
// ---------------------------------------------------------------------------

function neverKind(x: never): never {
  throw new Error(`unreachable WalLineKind: ${String(x)}`);
}

function summaryForPayload(kind: WalLineKind, payload: unknown): string {
  const obj =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  switch (kind) {
    case WAL_LINE_KIND.Phase:
      return typeof obj["name"] === "string" ? `name=${obj["name"]}` : "";
    case WAL_LINE_KIND.Turn:
      return typeof obj["index"] === "number" ? `index=${String(obj["index"])}` : "";
    case WAL_LINE_KIND.Event:
      return typeof obj["type"] === "string" ? `type=${obj["type"]}` : "";
    case WAL_LINE_KIND.Context:
      return "";
    case WAL_LINE_KIND.WorkspaceDiff:
      return "";
    case WAL_LINE_KIND.Outcome: {
      if (typeof obj["status"] !== "string") return "";
      const reason =
        typeof obj["reason"] === "string" ? ` reason=${obj["reason"]}` : "";
      return `status=${obj["status"]}${reason}`;
    }
    case WAL_LINE_KIND.Orphaned:
      return "(orphaned)";
    default:
      return neverKind(kind);
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

  for (const l of sorted) {
    const seqStr = String(l.seq).padStart(seqWidth, " ");
    const ts = new Date(l.ts).toISOString();
    const kind = l.kind.padEnd(14, " ");
    const summary = summaryForPayload(l.kind, l.payload);
    const tail = summary.length > 0 ? `  ${summary}` : "";
    process.stdout.write(`  ${seqStr}  ${ts}  ${kind}${tail}\n`);
  }

  const lastOutcome = outcomeLines[outcomeLines.length - 1];
  if (lastOutcome !== undefined) {
    const p = lastOutcome.payload as Record<string, unknown>;
    const status = typeof p["status"] === "string" ? p["status"] : "unknown";
    const reason =
      typeof p["reason"] === "string" ? ` (${p["reason"]})` : "";
    process.stdout.write(`\n  outcome: ${status}${reason}\n`);
  } else {
    const msg =
      source === "inflight" ? "run still in flight" : "no outcome line found";
    process.stdout.write(`\n  outcome: (none — ${msg})\n`);
  }
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

    const label = source === "inflight" ? "inflight" : "completed";
    process.stdout.write(`cc-judge inspect: run ${runId} [${label}]\n\n`);
    renderTimeline(lines, source);

    return Effect.void;
  });
}
