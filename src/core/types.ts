// Branded primitives and discriminated unions shared across modules.
// Stubs only. Implement-staff provides runtime constructors after /safer:setup.

import type { Brand } from "effect";

export type ScenarioId = string & Brand.Brand<"ScenarioId">;
export type TraceId = string & Brand.Brand<"TraceId">;
export type RunNumber = number & Brand.Brand<"RunNumber">;

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
