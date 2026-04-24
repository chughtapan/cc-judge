import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { randomUUID } from "node:crypto";
import {
  AgentRunTimeoutError,
  AgentStartError,
  BundleBuildError,
  BundleBuildCause,
  HarnessExecutionError,
  HarnessExecutionCause,
  RunCoordinationError,
  RunCoordinationCause,
} from "../core/errors.js";
import { JudgmentBundleSchema, formatSchemaErrors } from "../core/schema.js";
import {
  AGENT_LIFECYCLE_STATUS,
  AgentId,
  RunId,
  agentRefFromDeclaration,
  type AgentOutcome,
  type AgentTurn,
  type JudgmentBundle,
  type Phase,
  type RunPlan,
  type TraceEvent,
  type WorkspaceDiff,
  type WorkspaceFile,
} from "../core/types.js";
import { type AgentRuntime, type RuntimeHandle } from "./runtime.js";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

export interface NormalizedBundleSink {
  recordTurn(turn: AgentTurn): Effect.Effect<void, BundleBuildError, never>;
  recordEvent(event: TraceEvent): Effect.Effect<void, BundleBuildError, never>;
  recordPhase(phase: Phase): Effect.Effect<void, BundleBuildError, never>;
  recordContextPatch(patch: Readonly<Record<string, unknown>>): Effect.Effect<void, BundleBuildError, never>;
  setWorkspaceDiff(diff: WorkspaceDiff): Effect.Effect<void, BundleBuildError, never>;
  recordOutcome(outcome: AgentOutcome): Effect.Effect<void, BundleBuildError, never>;
  finalize(): Effect.Effect<JudgmentBundle, BundleBuildError, never>;
}

export interface PreparedRunContext {
  readonly handles: ReadonlyMap<AgentId, RuntimeHandle>;
  getHandle(agentId: AgentId): Effect.Effect<RuntimeHandle, HarnessExecutionError, never>;
}

export interface ExecutionHarness {
  readonly name: string;
  run(
    plan: RunPlan,
    execution: PreparedRunContext,
    sink: NormalizedBundleSink,
    opts: { readonly abortSignal?: AbortSignal },
  ): Effect.Effect<void, HarnessExecutionError | AgentRunTimeoutError, never>;
}

export interface RunCoordinator {
  execute(
    plan: RunPlan,
    harness: ExecutionHarness,
    opts?: RunCoordinatorOpts,
  ): Effect.Effect<JudgmentBundle, RunCoordinationError, never>;
}

export interface RunCoordinatorOpts {
  readonly abortSignal?: AbortSignal;
  readonly runId?: string;
}

export interface PromptWorkspaceHarnessConfig {
  readonly prompts: readonly [string, ...string[]];
  readonly workspace?: ReadonlyArray<WorkspaceFile>;
  readonly turnTimeoutMs?: number;
}

export class DefaultRunCoordinator implements RunCoordinator {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  execute(
    plan: RunPlan,
    harness: ExecutionHarness,
    opts: RunCoordinatorOpts = {},
  ): Effect.Effect<JudgmentBundle, RunCoordinationError, never> {
    const runId = RunId(opts.runId ?? randomUUID());
    const sink = makeNormalizedBundleSink(plan, runId);
    const handles: RuntimeHandle[] = [];
    const harnessOpts = opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {};

    return Effect.forEach(
      plan.agents,
      (agent) =>
        this.#runtime.prepare(agent, plan).pipe(
          Effect.tap((handle) =>
            Effect.sync(() => {
              handles.push(handle);
            }),
          ),
        ),
      { concurrency: plan.agents.length },
    ).pipe(
      Effect.flatMap((preparedHandles) =>
        harness.run(
          plan,
          makePreparedRunContext(preparedHandles),
          sink,
          harnessOpts,
        ).pipe(
          Effect.flatMap(() => sink.finalize()),
        ),
      ),
      Effect.mapError((error) => mapRunCoordinationError(error)),
      Effect.ensuring(
        Effect.forEach(handles, (handle) => this.#runtime.stop(handle), {
          concurrency: Math.max(1, handles.length),
          discard: true,
        }),
      ),
    );
  }
}

export class PromptWorkspaceHarness implements ExecutionHarness {
  readonly name = "prompt-workspace";
  readonly #config: PromptWorkspaceHarnessConfig;

  constructor(config: PromptWorkspaceHarnessConfig) {
    this.#config = config;
  }

  run(
    plan: RunPlan,
    execution: PreparedRunContext,
    sink: NormalizedBundleSink,
    opts: { readonly abortSignal?: AbortSignal },
  ): Effect.Effect<void, HarnessExecutionError | AgentRunTimeoutError, never> {
    const config = this.#config;
    return Effect.gen(function* () {
      const perAgentDiffs = new Map<AgentId, WorkspaceDiff>();
      yield* Effect.forEach(
        plan.agents,
        (agent) =>
          runPromptSequence(agent.id, execution, sink, config, opts.abortSignal).pipe(
            Effect.tap(({ diff }) =>
              Effect.sync(() => {
                perAgentDiffs.set(agent.id, diff);
              }),
            ),
          ),
        { concurrency: plan.agents.length, discard: true },
      );
      if (plan.agents.length === 1) {
        const onlyAgent = plan.agents[0];
        const diff = onlyAgent !== undefined ? perAgentDiffs.get(onlyAgent.id) : undefined;
        if (diff !== undefined) {
          yield* sink.setWorkspaceDiff(diff).pipe(Effect.mapError(bundleBuildToHarness));
        }
        return;
      }
      const workspaceDiffByAgent = Object.fromEntries(perAgentDiffs.entries());
      yield* sink.recordContextPatch({ workspaceDiffByAgent }).pipe(Effect.mapError(bundleBuildToHarness));
    });
  }
}

export function makeNormalizedBundleSink(
  plan: RunPlan,
  runId: string,
): NormalizedBundleSink {
  const turns: AgentTurn[] = [];
  const events: TraceEvent[] = [];
  const phases: Phase[] = [];
  const outcomes = new Map<string, AgentOutcome>();
  let context: Readonly<Record<string, unknown>> | undefined = plan.metadata;
  let workspaceDiff: WorkspaceDiff | undefined = undefined;
  const knownAgents = new Set(plan.agents.map((agent) => agent.id));

  return {
    recordTurn(turn) {
      return Effect.sync(() => {
        if (turn.agentId !== undefined && !knownAgents.has(turn.agentId)) {
          throw new BundleBuildError({
            cause: BundleBuildCause.UnknownAgent({
              agentId: turn.agentId,
            }),
          });
        }
        turns.push(turn);
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    recordEvent(event) {
      return Effect.sync(() => {
        events.push(event);
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    recordPhase(phase) {
      return Effect.sync(() => {
        phases.push(phase);
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    recordContextPatch(patch) {
      return Effect.sync(() => {
        context = {
          ...(context ?? {}),
          ...patch,
        };
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    setWorkspaceDiff(diff) {
      return Effect.sync(() => {
        workspaceDiff = diff;
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    recordOutcome(outcome) {
      return Effect.sync(() => {
        if (!knownAgents.has(outcome.agentId)) {
          throw new BundleBuildError({
            cause: BundleBuildCause.UnknownAgent({
              agentId: outcome.agentId,
            }),
          });
        }
        if (outcomes.has(outcome.agentId)) {
          throw new BundleBuildError({
            cause: BundleBuildCause.DuplicateOutcome({
              agentId: outcome.agentId,
            }),
          });
        }
        outcomes.set(outcome.agentId, outcome);
      }).pipe(Effect.catchAll(asBundleBuildError));
    },

    finalize() {
      return Effect.sync(() => {
        const missingOutcomes = plan.agents
          .map((agent) => agent.id)
          .filter((agentId) => !outcomes.has(agentId));
        if (missingOutcomes.length > 0) {
          throw new BundleBuildError({
            cause: BundleBuildCause.MissingOutcomes({
              agentIds: missingOutcomes,
            }),
          });
        }
        const bundle: JudgmentBundle = {
          runId: RunId(runId),
          project: plan.project,
          scenarioId: plan.scenarioId,
          name: plan.name,
          description: plan.description,
          requirements: plan.requirements,
          agents: plan.agents.map(agentRefFromDeclaration),
          ...(turns.length > 0 ? { turns: sortTurns(turns) } : {}),
          ...(events.length > 0 ? { events: sortEvents(events) } : {}),
          ...(phases.length > 0 ? { phases: sortPhases(phases) } : {}),
          ...(context !== undefined && Object.keys(context).length > 0 ? { context } : {}),
          ...(workspaceDiff !== undefined ? { workspaceDiff } : {}),
          outcomes: Array.from(outcomes.values()),
        };
        const errors = formatSchemaErrors(Value.Errors(JudgmentBundleSchema, bundle));
        if (errors.length > 0) {
          throw new BundleBuildError({
            cause: BundleBuildCause.SchemaInvalid({
              errors,
            }),
          });
        }
        return bundle;
      }).pipe(Effect.catchAll(asBundleBuildError));
    },
  };
}

function makePreparedRunContext(handles: ReadonlyArray<RuntimeHandle>): PreparedRunContext {
  const handleMap = new Map<AgentId, RuntimeHandle>(handles.map((handle) => [handle.agent.id, handle]));
  return {
    handles: handleMap,
    getHandle(agentId) {
      const handle = handleMap.get(agentId);
      if (handle === undefined) {
        return Effect.fail(
          new HarnessExecutionError({
            cause: HarnessExecutionCause.MissingRuntimeHandle({
              agentId,
            }),
          }),
        );
      }
      return Effect.succeed(handle);
    },
  };
}

function runPromptSequence(
  agentId: AgentId,
  execution: PreparedRunContext,
  sink: NormalizedBundleSink,
  config: PromptWorkspaceHarnessConfig,
  abortSignal: AbortSignal | undefined,
): Effect.Effect<{ readonly diff: WorkspaceDiff }, HarnessExecutionError | AgentRunTimeoutError, never> {
  return Effect.gen(function* () {
    const handle = yield* execution.getHandle(agentId);
    if (config.workspace !== undefined && config.workspace.length > 0) {
      yield* handle.writeWorkspace(config.workspace);
    }
    const startedAt = new Date().toISOString();
    let finishedWithFailure = false;
    for (const prompt of config.prompts) {
      const result = yield* handle.executePrompt(prompt, {
          timeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ success: false as const, error }),
            onSuccess: (turn) => ({ success: true as const, turn }),
          }),
        );
      if (!result.success) {
        if (abortSignal?.aborted === true) {
          return yield* Effect.fail(result.error);
        }
        const endedAt = new Date().toISOString();
        if (result.error instanceof AgentRunTimeoutError) {
          yield* sink.recordOutcome({
            agentId,
            status: AGENT_LIFECYCLE_STATUS.TimedOut,
            startedAt,
            endedAt,
            reason: `agent timed out after ${String(result.error.timeoutMs)}ms`,
          }).pipe(Effect.mapError(bundleBuildToHarness));
        } else {
          yield* sink.recordOutcome({
            agentId,
            status: AGENT_LIFECYCLE_STATUS.RuntimeError,
            startedAt,
            endedAt,
            reason: renderHarnessCause(result.error.cause),
          }).pipe(Effect.mapError(bundleBuildToHarness));
        }
        finishedWithFailure = true;
        break;
      }
      const turn = result.turn;
      const promptTs = Date.parse(turn.startedAt);
      const safePromptTs = Number.isFinite(promptTs) ? promptTs : Date.now();
      yield* sink.recordTurn({
        agentId,
        turn,
      }).pipe(Effect.mapError(bundleBuildToHarness));
      yield* sink.recordEvent({
        type: "message",
        from: "user",
        to: handle.agent.name,
        channel: "prompt",
        text: prompt,
        ts: safePromptTs,
      }).pipe(Effect.mapError(bundleBuildToHarness));
      yield* sink.recordEvent({
        type: "message",
        from: handle.agent.name,
        channel: "response",
        text: turn.response,
        ts: safePromptTs + turn.latencyMs,
      }).pipe(Effect.mapError(bundleBuildToHarness));
    }
    const diff = yield* handle.diffWorkspace();
    if (!finishedWithFailure) {
      yield* sink.recordOutcome({
        agentId,
        status: AGENT_LIFECYCLE_STATUS.Completed,
        startedAt,
        endedAt: new Date().toISOString(),
      }).pipe(Effect.mapError(bundleBuildToHarness));
    }
    return { diff };
  });
}

function sortTurns(turns: ReadonlyArray<AgentTurn>): ReadonlyArray<AgentTurn> {
  return [...turns].sort((left, right) => {
    const leftTs = Date.parse(left.turn.startedAt);
    const rightTs = Date.parse(right.turn.startedAt);
    return leftTs - rightTs;
  });
}

function sortEvents(events: ReadonlyArray<TraceEvent>): ReadonlyArray<TraceEvent> {
  return [...events].sort((left, right) => left.ts - right.ts);
}

function sortPhases(phases: ReadonlyArray<Phase>): ReadonlyArray<Phase> {
  return [...phases].sort((left, right) => left.tsStart - right.tsStart);
}

function asBundleBuildError(error: unknown): Effect.Effect<never, BundleBuildError, never> {
  if (error instanceof BundleBuildError) {
    return Effect.fail(error);
  }
  return Effect.fail(
    new BundleBuildError({
      cause: BundleBuildCause.SchemaInvalid({
        errors: [error instanceof Error ? error.message : String(error)],
      }),
    }),
  );
}

function mapRunCoordinationError(error: unknown): RunCoordinationError {
  if (error instanceof RunCoordinationError) {
    return error;
  }
  if (error instanceof BundleBuildError) {
    return new RunCoordinationError({
      cause: RunCoordinationCause.BundleBuildFailed({
        detail: error.cause,
      }),
    });
  }
  if (error instanceof HarnessExecutionError) {
    return new RunCoordinationError({
      cause: RunCoordinationCause.HarnessFailed({
        detail: error.cause,
      }),
    });
  }
  if (error instanceof AgentStartError) {
    return new RunCoordinationError({
      cause: RunCoordinationCause.AgentStartFailed({
        agentId: error.agentId ?? "unknown-agent",
        detail: error.cause,
      }),
    });
  }
  return new RunCoordinationError({
    cause: RunCoordinationCause.HarnessFailed({
      detail: HarnessExecutionCause.ExecutionFailed({
        message: error instanceof Error ? error.message : String(error),
      }),
    }),
  });
}

function bundleBuildToHarness(error: BundleBuildError): HarnessExecutionError {
  return new HarnessExecutionError({
    cause: HarnessExecutionCause.ExecutionFailed({
      message: renderBundleBuildCause(error.cause),
    }),
  });
}

function renderBundleBuildCause(cause: BundleBuildCause): string {
  switch (cause._tag) {
    case "DuplicateOutcome":
      return `duplicate outcome for ${cause.agentId}`;
    case "MissingOutcomes":
      return `missing outcomes for ${cause.agentIds.join(", ")}`;
    case "UnknownAgent":
      return `unknown agent ${cause.agentId}`;
    case "EventOrderViolation":
      return `event order violated: ${String(cause.previousTs)} > ${String(cause.nextTs)}`;
    case "SchemaInvalid":
      return `bundle schema invalid: ${cause.errors.join("; ")}`;
  }
}

function renderHarnessCause(cause: HarnessExecutionCause): string {
  switch (cause._tag) {
    case "MissingRuntimeHandle":
      return `missing runtime handle for ${cause.agentId}`;
    case "InvalidPlanMetadata":
      return cause.message;
    case "ExecutionFailed":
      return cause.message;
  }
}

void AGENT_LIFECYCLE_STATUS.Cancelled;
void AGENT_LIFECYCLE_STATUS.FailedToStart;
