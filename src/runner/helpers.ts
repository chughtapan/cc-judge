// Pure helpers extracted from runtime.ts for direct testing. Same
// pattern as src/judge/helpers.ts: tests import from here without
// having to weaken runtime.ts's encapsulation.

import { Effect } from "effect";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceDiff, WorkspaceFileChange } from "../core/types.js";

// ── stream-json parser ──────────────────────────────────────────────────────

export interface ParsedTurn {
  readonly response: string;
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface StreamJsonEvent {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly result?: unknown;
  readonly usage?: unknown;
}

interface StreamJsonUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

const ZERO_TURN: ParsedTurn = {
  response: "",
  toolCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    void err;
    return null;
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function aggregateUsage(acc: ParsedTurn, usage: unknown): ParsedTurn {
  if (typeof usage !== "object" || usage === null) return acc;
  const tokens = usage as StreamJsonUsage;
  return {
    ...acc,
    inputTokens: acc.inputTokens + readNumber(tokens.input_tokens),
    outputTokens: acc.outputTokens + readNumber(tokens.output_tokens),
    cacheReadTokens: acc.cacheReadTokens + readNumber(tokens.cache_read_input_tokens),
    cacheWriteTokens: acc.cacheWriteTokens + readNumber(tokens.cache_creation_input_tokens),
  };
}

function applyEvent(acc: ParsedTurn, obj: StreamJsonEvent): ParsedTurn {
  const type = typeof obj.type === "string" ? obj.type : "";
  switch (type) {
    case "assistant":
      return typeof obj.content === "string"
        ? { ...acc, response: acc.response + obj.content }
        : acc;
    case "result":
      // First non-empty result wins; assistant content takes precedence.
      return typeof obj.result === "string" && acc.response.length === 0
        ? { ...acc, response: obj.result }
        : acc;
    case "tool_use":
    case "tool_call":
      return { ...acc, toolCallCount: acc.toolCallCount + 1 };
    default:
      return acc;
  }
}

/**
 * Parse the stream-json output of a `claude -p` invocation. Each line
 * is one JSON event (assistant content, result, tool_use, usage tokens).
 * Falls back to the raw stdout when no structured event was seen — that
 * covers the case where the binary printed plain text or errored out
 * before emitting any JSON.
 */
export function parseStreamJson(stdout: string): ParsedTurn {
  let acc = ZERO_TURN;
  let sawStructured = false;
  for (const line of stdout.split("\n")) {
    const parsed = parseLine(line);
    if (typeof parsed !== "object" || parsed === null) continue;
    sawStructured = true;
    const obj = parsed as StreamJsonEvent;
    acc = applyEvent(acc, obj);
    acc = aggregateUsage(acc, obj.usage);
  }
  return sawStructured ? acc : { ...acc, response: stdout };
}

// ── workspace walk + diff ───────────────────────────────────────────────────

/**
 * Recursively walk a workspace directory, collecting every readable file
 * keyed by its path relative to the root. Errors at every step are
 * swallowed (best-effort): a directory that can't be read contributes
 * nothing; a file that can't be read is skipped. Returns an empty map
 * when the root itself is missing.
 */
export function walkWorkspace(dir: string): Effect.Effect<ReadonlyMap<string, string>, never, never> {
  const output = new Map<string, string>();
  return walkInto(dir, dir, output).pipe(
    Effect.map(() => output as ReadonlyMap<string, string>),
  );
}

function walkInto(
  root: string,
  currentDir: string,
  output: Map<string, string>,
): Effect.Effect<void, never, never> {
  return Effect.tryPromise({
    try: () => readdir(currentDir, { withFileTypes: true }),
    catch: () => [],
  }).pipe(
    Effect.catchAll(() => Effect.succeed([])),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) => {
          const absolutePath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            return walkInto(root, absolutePath, output);
          }
          if (!entry.isFile()) {
            return Effect.void;
          }
          return Effect.tryPromise({
            try: () => readFile(absolutePath, "utf8"),
            catch: () => null,
          }).pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (content: string | null) => {
                if (content !== null) {
                  output.set(path.relative(root, absolutePath), content);
                }
              },
            }),
          );
        },
        { discard: true },
      ),
    ),
  );
}

/**
 * Compute the changed-file list between two workspace snapshots.
 * - File in baseline but not in current → removed (after = null)
 * - File in current but not in baseline → added (before = null)
 * - File in both with different contents → modified
 * - File in both with identical contents → omitted from the diff
 */
export function computeDiff(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): WorkspaceDiff {
  const changed: WorkspaceFileChange[] = [];
  const seen = new Set<string>();
  for (const [relativePath, before] of baseline) {
    seen.add(relativePath);
    const after = current.get(relativePath);
    if (after === undefined) {
      changed.push({ path: relativePath, before, after: null });
    } else if (after !== before) {
      changed.push({ path: relativePath, before, after });
    }
  }
  for (const [relativePath, after] of current) {
    if (!seen.has(relativePath)) {
      changed.push({ path: relativePath, before: null, after });
    }
  }
  return { changed };
}
