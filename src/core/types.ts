// Branded primitives and discriminated unions shared across modules.
// Principle 1: types beat tests — branded IDs prevent cross-confusion by construction.

import { Brand } from "effect";

export type ScenarioId = string & Brand.Brand<"ScenarioId">;
export type TraceId = string & Brand.Brand<"TraceId">;
export type RunNumber = number & Brand.Brand<"RunNumber">;

export const ScenarioId = Brand.nominal<ScenarioId>();
export const TraceId = Brand.nominal<TraceId>();
export const RunNumber = Brand.nominal<RunNumber>();

export type IssueSeverity = "minor" | "significant" | "critical";

export type RunSource = "scenario" | "trace";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeKind = "docker" | "subprocess";

export interface Issue {
  readonly issue: string;
  readonly severity: IssueSeverity;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceFileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface WorkspaceDiff {
  readonly changed: ReadonlyArray<WorkspaceFileChange>;
}

export interface Turn {
  readonly index: number;
  readonly prompt: string;
  readonly response: string;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface DeterministicCtx {
  readonly transcript: string;
  readonly diff: WorkspaceDiff;
}

// Utility: make unreachable branches a type error. Principle 4.
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
