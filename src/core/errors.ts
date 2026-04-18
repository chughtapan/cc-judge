// Tagged error classes for every public Effect error channel.
// Principle 3: errors are typed, not thrown. Every cause is a discriminated tag.

import { Data } from "effect";
import type { ScenarioId } from "./types.js";

export class LoadError extends Data.TaggedError("LoadError")<{
  readonly cause: LoadErrorCause;
}> {}

export type LoadErrorCause =
  | { readonly _tag: "FileNotFound"; readonly path: string }
  | { readonly _tag: "GlobNoMatches"; readonly pattern: string }
  | { readonly _tag: "ParseFailure"; readonly path: string; readonly message: string }
  | { readonly _tag: "SchemaInvalid"; readonly path: string; readonly errors: ReadonlyArray<string> }
  | { readonly _tag: "DuplicateId"; readonly id: ScenarioId; readonly paths: readonly [string, string] };

export class AgentStartError extends Data.TaggedError("AgentStartError")<{
  readonly scenarioId: ScenarioId;
  readonly cause: AgentStartErrorCause;
}> {}

export type AgentStartErrorCause =
  | { readonly _tag: "ImageMissing"; readonly image: string }
  | { readonly _tag: "ContainerStartFailed"; readonly message: string }
  | { readonly _tag: "BinaryNotFound"; readonly path: string }
  | { readonly _tag: "WorkspaceSetupFailed"; readonly message: string };

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

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly cause: PublishErrorCause;
}> {}

export type PublishErrorCause =
  | { readonly _tag: "GhCliMissing" }
  | { readonly _tag: "GhCliFailed"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "BodyTooLarge"; readonly chars: number; readonly limit: number };
