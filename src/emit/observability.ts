// ObservabilityEmitter interface + BraintrustEmitter + PromptfooEmitter.
// Invariant #12: emission never changes verdict or exit code.
// Spec Q-OBS-1 (A): array of emitters, each failure isolated.
// Spec Q-OBS-2 (C): both per-run (streaming) and per-report (roll-up).

import { Effect } from "effect";
import { writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { initLogger, type Logger as BraintrustLogger } from "braintrust";
import type { Report, RunRecord } from "../core/schema.js";

export interface ObservabilityEvent {
  readonly record: RunRecord;
}

export interface ObservabilityReport {
  readonly report: Report;
}

export interface ObservabilityEmitter {
  readonly name: string;
  onRun(event: ObservabilityEvent): Effect.Effect<void, never, never>;
  onReport(event: ObservabilityReport): Effect.Effect<void, never, never>;
}

// -------------------- BraintrustEmitter --------------------

export interface BraintrustEmitterOpts {
  readonly project: string;
  readonly apiKey: string;
  readonly experimentName?: string;
}

export class BraintrustEmitter implements ObservabilityEmitter {
  readonly name = "braintrust";
  readonly #opts: BraintrustEmitterOpts;
  #logger: BraintrustLogger<true> | null = null;

  constructor(opts: BraintrustEmitterOpts) {
    this.#opts = opts;
  }

  #ensureLogger(): BraintrustLogger<true> {
    if (this.#logger !== null) return this.#logger;
    this.#logger = initLogger({
      apiKey: this.#opts.apiKey,
      projectName: this.#opts.project,
    });
    return this.#logger;
  }

  onRun(event: ObservabilityEvent): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      try {
        const logger = this.#ensureLogger();
        logger.log({
          input: { scenarioId: event.record.scenarioId, source: event.record.source },
          output: { pass: event.record.pass, reason: event.record.reason },
          scores: { pass: event.record.pass ? 1 : 0 },
          metadata: {
            runNumber: event.record.runNumber,
            modelName: event.record.modelName,
            judgeModel: event.record.judgeModel,
            latencyMs: event.record.latencyMs,
            retryCount: event.record.retryCount,
            toolCallCount: event.record.toolCallCount,
            inputTokens: event.record.inputTokens,
            outputTokens: event.record.outputTokens,
            overallSeverity: event.record.overallSeverity ?? "none",
            ...(event.record.failureKind !== undefined && event.record.failureKind !== null
              ? { failureKind: event.record.failureKind }
              : {}),
          },
        });
      } catch (err) {
        void err;
        // Invariant #12: observability never affects verdict. Drop and move on.
      }
    });
  }

  onReport(_event: ObservabilityReport): Effect.Effect<void, never, never> {
    void _event;
    return Effect.tryPromise({
      try: () => this.#flushLogger(),
      catch: () => null,
    }).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.asVoid,
    );
  }

  #flushLogger() {
    if (this.#logger === null) return Promise.resolve();
    const p = this.#logger.flush();
    return p instanceof Promise ? p : Promise.resolve();
  }
}

// -------------------- PromptfooEmitter --------------------

export interface PromptfooEmitterOpts {
  readonly outputPath: string;
}

export class PromptfooEmitter implements ObservabilityEmitter {
  readonly name = "promptfoo";
  readonly #outputPath: string;

  constructor(opts: PromptfooEmitterOpts) {
    this.#outputPath = opts.outputPath;
  }

  onRun(_event: ObservabilityEvent): Effect.Effect<void, never, never> {
    // Promptfoo's dashboard ingests a single-file results.json (one roll-up
    // per pipeline). We defer to onReport.
    void _event;
    return Effect.void;
  }

  onReport(event: ObservabilityReport): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      try {
        const payload = toPromptfooResults(event.report);
        const abs = path.resolve(this.#outputPath);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(payload, null, 2), "utf8");
      } catch (err) {
        void err;
        // Invariant #12.
      }
    });
  }
}

interface PromptfooResultRow {
  readonly promptId: string;
  readonly testIdx: number;
  readonly success: boolean;
  readonly score: number;
  readonly latencyMs: number;
  readonly response: {
    readonly output: string;
    readonly tokenUsage: { readonly prompt: number; readonly completion: number; readonly cached: number };
  };
  readonly gradingResult: { readonly pass: boolean; readonly score: number; readonly reason: string };
  readonly vars: Readonly<Record<string, string | number | boolean>>;
}

function toPromptfooResults(report: Report): {
  readonly version: 3;
  readonly createdAt: string;
  readonly results: {
    readonly timestamp: string;
    readonly results: ReadonlyArray<PromptfooResultRow>;
    readonly stats: {
      readonly successes: number;
      readonly failures: number;
      readonly tokenUsage: { readonly total: number; readonly prompt: number; readonly completion: number };
    };
  };
} {
  const now = new Date().toISOString();
  const rows: PromptfooResultRow[] = report.runs.map((r, i) => ({
    promptId: r.scenarioId,
    testIdx: i,
    success: r.pass,
    score: r.pass ? 1 : 0,
    latencyMs: r.latencyMs,
    response: {
      output: r.reason,
      tokenUsage: {
        prompt: r.inputTokens,
        completion: r.outputTokens,
        cached: r.cacheReadTokens,
      },
    },
    gradingResult: { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason },
    vars: {
      scenarioId: r.scenarioId,
      runNumber: r.runNumber,
      source: r.source,
    },
  }));
  let totalPrompt = 0;
  let totalCompletion = 0;
  for (const r of report.runs) {
    totalPrompt += r.inputTokens;
    totalCompletion += r.outputTokens;
  }
  return {
    version: 3,
    createdAt: now,
    results: {
      timestamp: now,
      results: rows,
      stats: {
        successes: report.summary.passed,
        failures: report.summary.failed,
        tokenUsage: {
          total: totalPrompt + totalCompletion,
          prompt: totalPrompt,
          completion: totalCompletion,
        },
      },
    },
  };
}
