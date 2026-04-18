// JudgeBackend interface + bundled AnthropicJudgeBackend.
// Responsibility: score (scenario, turns, diff?) into a JudgeResult.
// Invariant #3: judge() error channel is `never`. Internal failures fold into a critical-severity result.

import type { Effect } from "effect";
import type { Turn, WorkspaceDiff } from "../core/types.js";
import type { JudgeResult, Scenario } from "../core/schema.js";

export interface JudgeInput {
  readonly scenario: Scenario;
  readonly turns: ReadonlyArray<Turn>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly abortSignal?: AbortSignal;
}

export interface JudgeBackend {
  readonly name: string;

  // Verdict is owned here. Internal errors (network, malformed structured output,
  // retry exhaustion) fold into a JudgeResult with pass=false, overallSeverity="critical".
  judge(input: JudgeInput): Effect.Effect<JudgeResult, never, never>;
}

export interface AnthropicJudgeBackendOpts {
  // Spec assumption #13: default judge model is "claude-opus-4-7".
  readonly model?: string;
  readonly maxTurns?: number;
  readonly perAttemptTimeoutMs?: number;
  readonly retrySchedule?: ReadonlyArray<number>;
}

export declare class AnthropicJudgeBackend implements JudgeBackend {
  readonly name: "anthropic";
  constructor(opts?: AnthropicJudgeBackendOpts);
  judge(input: JudgeInput): Effect.Effect<JudgeResult, never, never>;
}
