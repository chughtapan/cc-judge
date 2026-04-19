// Branded primitives and discriminated unions shared across modules.
// Principle 1: types beat tests — branded IDs prevent cross-confusion by construction.

import { Brand } from "effect";

export type ScenarioId = string & Brand.Brand<"ScenarioId">;
export type TraceId = string & Brand.Brand<"TraceId">;
export type RunNumber = number & Brand.Brand<"RunNumber">;

export const ScenarioId = Brand.nominal<ScenarioId>();
export const TraceId = Brand.nominal<TraceId>();
export const RunNumber = Brand.nominal<RunNumber>();

// Explicit, named conversion from TraceId to ScenarioId. Used only by the
// trace-scoring path when a Trace omits scenarioId — the trace is synthesized
// into a pseudo-Scenario so the judge can consume it. Naming the conversion
// makes the brand crossing auditable (Principle 1: no silent brand laundering).
export function scenarioIdFromTraceId(t: TraceId): ScenarioId {
  return ScenarioId(t);
}

export type IssueSeverity = "minor" | "significant" | "critical";

export const ISSUE_SEVERITY = {
  Minor: "minor",
  Significant: "significant",
  Critical: "critical",
} as const satisfies { readonly [K in Capitalize<IssueSeverity>]: Uncapitalize<K> };

export type RunSource = "scenario" | "trace";

export const RUN_SOURCE = {
  Scenario: "scenario",
  Trace: "trace",
} as const satisfies { readonly [K in Capitalize<RunSource>]: Uncapitalize<K> };

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeKind = "docker" | "subprocess";

export const RUNTIME_KIND = {
  Docker: "docker",
  Subprocess: "subprocess",
} as const satisfies { readonly [K in Capitalize<RuntimeKind>]: Uncapitalize<K> };

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

// Multi-agent event types for extended traces.
export type TraceEvent =
  | { readonly type: "message"; readonly from: string; readonly to?: string; readonly channel: string; readonly text: string; readonly ts: number }
  | { readonly type: "phase"; readonly phase: string; readonly round?: number; readonly ts: number }
  | { readonly type: "action"; readonly agent: string; readonly action: string; readonly channel: string; readonly ts: number }
  | { readonly type: "state"; readonly snapshot: Readonly<Record<string, unknown>>; readonly ts: number };

export interface Phase {
  readonly id: string;
  readonly name: string;
  readonly tsStart: number;
  readonly tsEnd?: number;
}

export interface AgentRef {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DeterministicCtx {
  readonly transcript: string;
  readonly diff: WorkspaceDiff;
}

// Utility: make unreachable branches a type error. Principle 4.
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
