// Options surfaces for the two SDK entrypoints.
// Shared fields live in a common base; run/score specialize.

import type { JudgeBackend } from "../judge/index.js";
import type { ObservabilityEmitter } from "../emit/observability.js";
import type { AgentRunner } from "../runner/index.js";
import type { LogLevel } from "../core/types.js";
import type { TraceFormat } from "../emit/trace-adapter.js";

export interface SharedOpts {
  readonly judge?: JudgeBackend;
  readonly resultsDir?: string;
  readonly runsPerScenario?: number;
  readonly concurrency?: number;
  readonly logLevel?: LogLevel;
  readonly totalTimeoutMs?: number;
  readonly emitters?: ReadonlyArray<ObservabilityEmitter>;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
  readonly abortSignal?: AbortSignal;
}

export interface RunOpts extends SharedOpts {
  readonly runner?: AgentRunner;
  readonly scenarioIdFilter?: ReadonlyArray<string>;
}

export interface ScoreOpts extends SharedOpts {
  readonly traceFormat?: TraceFormat;
}
