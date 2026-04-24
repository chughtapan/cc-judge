// Tagged error classes for every public Effect error channel.
// Principle 3: errors are typed, not thrown. Every cause is a discriminated tag.

import { Data } from "effect";
import type { AgentId, ScenarioId } from "./types.js";

export class AgentStartError extends Data.TaggedError("AgentStartError")<{
  readonly scenarioId: ScenarioId;
  readonly agentId?: AgentId;
  readonly cause: AgentStartErrorCause;
}> {}

export type AgentStartErrorCause =
  | { readonly _tag: "BuildContextMissing"; readonly path: string }
  | { readonly _tag: "DockerBuildFailed"; readonly message: string }
  | { readonly _tag: "ImageMissing"; readonly image: string }
  | { readonly _tag: "ImagePullFailed"; readonly image: string; readonly message: string }
  | { readonly _tag: "ContainerStartFailed"; readonly message: string }
  | { readonly _tag: "BinaryNotFound"; readonly path: string }
  | { readonly _tag: "WorkspacePathEscape"; readonly wfPath: string }
  | { readonly _tag: "WorkspaceSetupFailed"; readonly message: string };

export const AgentStartErrorCause = Data.taggedEnum<AgentStartErrorCause>();

export class AgentRunTimeoutError extends Data.TaggedError("AgentRunTimeoutError")<{
  readonly scenarioId: ScenarioId;
  readonly turnIndex: number;
  readonly timeoutMs: number;
}> {}

export class TotalTimeoutExceeded extends Data.TaggedError("TotalTimeoutExceeded")<{
  readonly totalTimeoutMs: number;
  readonly completedRuns: number;
}> {}

export class TraceDecodeError extends Data.TaggedError("TraceDecodeError")<{
  readonly cause: TraceDecodeCause;
}> {}

export type TraceDecodeCause =
  | { readonly _tag: "UnknownFormat"; readonly path: string }
  | { readonly _tag: "SchemaInvalid"; readonly path: string; readonly errors: ReadonlyArray<string> };

export const TraceDecodeCause = Data.taggedEnum<TraceDecodeCause>();

export class BundleDecodeError extends Data.TaggedError("BundleDecodeError")<{
  readonly cause: BundleDecodeCause;
}> {}

export type BundleDecodeCause =
  | { readonly _tag: "UnknownFormat"; readonly path: string }
  | { readonly _tag: "SchemaInvalid"; readonly path: string; readonly errors: ReadonlyArray<string> };

export const BundleDecodeCause = Data.taggedEnum<BundleDecodeCause>();

export class BundleBuildError extends Data.TaggedError("BundleBuildError")<{
  readonly cause: BundleBuildCause;
}> {}

export type BundleBuildCause =
  | { readonly _tag: "DuplicateOutcome"; readonly agentId: string }
  | { readonly _tag: "MissingOutcomes"; readonly agentIds: ReadonlyArray<string> }
  | { readonly _tag: "UnknownAgent"; readonly agentId: string }
  | { readonly _tag: "EventOrderViolation"; readonly previousTs: number; readonly nextTs: number }
  | { readonly _tag: "SchemaInvalid"; readonly errors: ReadonlyArray<string> };

export const BundleBuildCause = Data.taggedEnum<BundleBuildCause>();

export class HarnessExecutionError extends Data.TaggedError("HarnessExecutionError")<{
  readonly cause: HarnessExecutionCause;
}> {}

export type HarnessExecutionCause =
  | { readonly _tag: "MissingRuntimeHandle"; readonly agentId: string }
  | { readonly _tag: "InvalidPlanMetadata"; readonly message: string }
  | { readonly _tag: "ExecutionFailed"; readonly message: string };

export const HarnessExecutionCause = Data.taggedEnum<HarnessExecutionCause>();

export class RunCoordinationError extends Data.TaggedError("RunCoordinationError")<{
  readonly cause: RunCoordinationCause;
}> {}

export type RunCoordinationCause =
  | { readonly _tag: "AgentStartFailed"; readonly agentId: string; readonly detail: AgentStartErrorCause }
  | { readonly _tag: "HarnessFailed"; readonly detail: HarnessExecutionCause }
  | { readonly _tag: "BundleBuildFailed"; readonly detail: BundleBuildCause };

export const RunCoordinationCause = Data.taggedEnum<RunCoordinationCause>();

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly cause: PublishErrorCause;
}> {}

export type PublishErrorCause =
  | { readonly _tag: "GhCliMissing" }
  | { readonly _tag: "GhCliFailed"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "BodyTooLarge"; readonly chars: number; readonly limit: number };

export const PublishErrorCause = Data.taggedEnum<PublishErrorCause>();

export class RunnerResolutionError extends Data.TaggedError("RunnerResolutionError")<{
  readonly cause: RunnerResolutionCause;
}> {}

export type RunnerResolutionCause =
  { readonly _tag: "InvalidRuntime"; readonly value: string };

export const RunnerResolutionCause = Data.taggedEnum<RunnerResolutionCause>();

// Tag constants. Identity-mapped objects over the `_tag` union members;
// the mapped-type `satisfies` forces value == key at the type level, so a
// silent rename of a cause variant breaks compilation here.

export const ERROR_TAG = {
  AgentStartError: "AgentStartError",
  AgentRunTimeoutError: "AgentRunTimeoutError",
} as const;

export const AGENT_START_CAUSE = {
  BuildContextMissing: "BuildContextMissing",
  DockerBuildFailed: "DockerBuildFailed",
  ImageMissing: "ImageMissing",
  ImagePullFailed: "ImagePullFailed",
  ContainerStartFailed: "ContainerStartFailed",
  BinaryNotFound: "BinaryNotFound",
  WorkspacePathEscape: "WorkspacePathEscape",
  WorkspaceSetupFailed: "WorkspaceSetupFailed",
} as const satisfies { readonly [K in AgentStartErrorCause["_tag"]]: K };
