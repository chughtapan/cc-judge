// ObservabilityEmitter interface + BraintrustEmitter + PromptfooEmitter.
// Invariant #12: emission never changes verdict or exit code.
// Spec Q-OBS-1 (A): array of emitters, each failure isolated.
// Spec Q-OBS-2 (C): both per-run (streaming) and per-report (roll-up).

import type { Effect } from "effect";
import type { Report, RunRecord } from "../core/schema.js";

export interface ObservabilityEvent {
  readonly record: RunRecord;
}

export interface ObservabilityReport {
  readonly report: Report;
}

export interface ObservabilityEmitter {
  readonly name: string;

  // Per-run streaming event. No-op implementations return Effect.void.
  onRun(event: ObservabilityEvent): Effect.Effect<void, never, never>;

  // Per-report roll-up. No-op implementations return Effect.void.
  onReport(event: ObservabilityReport): Effect.Effect<void, never, never>;
}

export interface BraintrustEmitterOpts {
  readonly project: string;
  readonly apiKey: string;
  readonly experimentName?: string;
}

export declare class BraintrustEmitter implements ObservabilityEmitter {
  readonly name: "braintrust";
  constructor(opts: BraintrustEmitterOpts);
  onRun(event: ObservabilityEvent): Effect.Effect<void, never, never>;
  onReport(event: ObservabilityReport): Effect.Effect<void, never, never>;
}

export interface PromptfooEmitterOpts {
  // cc-judge writes a promptfoo-shaped results file. We do not pull promptfoo as a runtime dep.
  readonly outputPath: string;
}

export declare class PromptfooEmitter implements ObservabilityEmitter {
  readonly name: "promptfoo";
  constructor(opts: PromptfooEmitterOpts);
  onRun(event: ObservabilityEvent): Effect.Effect<void, never, never>;
  onReport(event: ObservabilityReport): Effect.Effect<void, never, never>;
}
