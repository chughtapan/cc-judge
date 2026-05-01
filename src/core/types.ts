// Branded primitives and discriminated unions shared across modules.
// Principle 1: types beat tests — branded IDs prevent cross-confusion by construction.

import { Brand } from "effect";

export type ProjectId = string & Brand.Brand<"ProjectId">;
export type RunId = string & Brand.Brand<"RunId">;
export type AgentId = string & Brand.Brand<"AgentId">;
export type ScenarioId = string & Brand.Brand<"ScenarioId">;
export type RunNumber = number & Brand.Brand<"RunNumber">;

export const ProjectId = Brand.nominal<ProjectId>();
export const RunId = Brand.nominal<RunId>();
export const AgentId = Brand.nominal<AgentId>();
export const ScenarioId = Brand.nominal<ScenarioId>();
export const RunNumber = Brand.nominal<RunNumber>();

export type IssueSeverity = "minor" | "significant" | "critical";

export const ISSUE_SEVERITY = {
  Minor: "minor",
  Significant: "significant",
  Critical: "critical",
} as const satisfies { readonly [K in Capitalize<IssueSeverity>]: Uncapitalize<K> };

export type RunSource = "bundle";

export const RUN_SOURCE = {
  Bundle: "bundle",
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

export type ExecutionArtifact =
  | {
      readonly _tag: "DockerBuildArtifact";
      readonly contextPath: string;
      readonly dockerfilePath?: string;
      readonly target?: string;
      readonly buildArgs?: Readonly<Record<string, string>>;
      readonly imageTag?: string;
    }
  | {
      readonly _tag: "DockerImageArtifact";
      readonly image: string;
      readonly pullPolicy?: "always" | "if-missing" | "never";
    }
  // Metadata-only marker; operational opts live on SubprocessRuntimeOpts.
  | {
      readonly _tag: "SubprocessArtifact";
      readonly label?: string;
    };

export const EXECUTION_ARTIFACT_TAG = {
  DockerBuildArtifact: "DockerBuildArtifact",
  DockerImageArtifact: "DockerImageArtifact",
  SubprocessArtifact: "SubprocessArtifact",
} as const satisfies { readonly [K in ExecutionArtifact["_tag"]]: K };

export interface AgentDeclaration {
  readonly id: AgentId;
  readonly name: string;
  readonly role?: string;
  readonly artifact: ExecutionArtifact;
  readonly promptInputs: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RunRequirements {
  readonly expectedBehavior: string;
  readonly validationChecks: ReadonlyArray<string>;
  readonly judgeRubric?: string;
}

export interface RunPlan {
  readonly project: ProjectId;
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly agents: readonly [AgentDeclaration, ...AgentDeclaration[]];
  readonly requirements: RunRequirements;
  readonly metadata?: Readonly<Record<string, unknown>>;
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

export const TRACE_EVENT_TYPE = {
  Message: "message",
  Phase: "phase",
  Action: "action",
  State: "state",
} as const satisfies { readonly [K in Capitalize<TraceEvent["type"]>]: Uncapitalize<K> };

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

export interface AgentTurn {
  readonly turn: Turn;
  readonly agentId?: AgentId;
}

export type AgentLifecycleStatus =
  | "completed"
  | "timed_out"
  | "failed_to_start"
  | "runtime_error"
  | "cancelled";

export const AGENT_LIFECYCLE_STATUS = {
  Completed: "completed",
  TimedOut: "timed_out",
  FailedToStart: "failed_to_start",
  RuntimeError: "runtime_error",
  Cancelled: "cancelled",
} as const;

export interface AgentOutcome {
  readonly agentId: AgentId;
  readonly status: AgentLifecycleStatus;
  readonly startedAt?: string;
  readonly endedAt: string;
  readonly exitCode?: number;
  readonly reason?: string;
}

export interface JudgmentBundle {
  readonly runId: RunId;
  readonly project: ProjectId;
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly requirements: RunRequirements;
  readonly agents: ReadonlyArray<AgentRef>;
  readonly turns?: ReadonlyArray<AgentTurn>;
  readonly events?: ReadonlyArray<TraceEvent>;
  readonly phases?: ReadonlyArray<Phase>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly outcomes: ReadonlyArray<AgentOutcome>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function agentRefFromDeclaration(agent: AgentDeclaration): AgentRef {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.role !== undefined ? { role: agent.role } : {}),
    ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
  };
}

// Utility: make unreachable branches a type error. Principle 4.
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
