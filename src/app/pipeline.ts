// Pipeline orchestration: composes runner + judge + report + observability.
// Public SDK entrypoints. Invariant #3: error channel is `never` — all internal
// failures fold into per-run RunRecords; the pipeline always produces a Report.

import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { Report, RunRecord, Trace, JudgeResult } from "../core/schema.js";
import type {
  JudgmentBundle,
  RunPlan,
  AgentTurn,
  Turn,
  WorkspaceDiff,
  IssueSeverity,
  ScenarioId as ScenarioIdType,
  RunNumber as RunNumberType,
  TraceId as TraceIdType,
} from "../core/types.js";
import {
  RUN_SOURCE,
  RunId,
  RunNumber,
  agentRefFromDeclaration,
  scenarioIdFromTraceId,
} from "../core/types.js";
import { AnthropicJudgeBackend, judgeBundle, type JudgeBackend } from "../judge/index.js";
import {
  DefaultRunCoordinator,
  DockerRuntime,
  type RunCoordinator,
} from "../runner/index.js";
import { makeReportEmitter, type ReportEmitter } from "../emit/report.js";
import type { ObservabilityEmitter } from "../emit/observability.js";
import {
  RunCoordinationError,
  type AgentStartErrorCause,
  type BundleBuildCause,
  type HarnessExecutionCause,
} from "../core/errors.js";
import type { HarnessRunOpts, PlannedRunInput, ScoreOpts, SharedOpts } from "./opts.js";

const DEFAULT_CONCURRENCY = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function withManagedAbortSignal<A, E>(
  opts: SharedOpts,
  run: (abortSignal: AbortSignal | undefined) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> {
  if (opts.totalTimeoutMs === undefined) {
    return run(opts.abortSignal);
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const parentSignal = opts.abortSignal;
      const onParentAbort = () => {
        controller.abort(parentSignal?.reason);
      };
      if (parentSignal !== undefined) {
        if (parentSignal.aborted) {
          controller.abort(parentSignal.reason);
        } else {
          parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }
      const timer = setTimeout(() => {
        controller.abort(new Error(`total timeout after ${String(opts.totalTimeoutMs)}ms`));
      }, opts.totalTimeoutMs);
      return {
        signal: controller.signal,
        cleanup: () => {
          clearTimeout(timer);
          parentSignal?.removeEventListener("abort", onParentAbort);
        },
      };
    }),
    ({ signal }) => run(signal),
    ({ cleanup }) => Effect.sync(cleanup),
  );
}

function summarizeDiff(
  diff: WorkspaceDiff | undefined,
): { readonly changed: number; readonly added: number; readonly removed: number } {
  if (diff === undefined) return { changed: 0, added: 0, removed: 0 };
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const c of diff.changed) {
    if (c.before === null && c.after !== null) added += 1;
    else if (c.before !== null && c.after === null) removed += 1;
    else changed += 1;
  }
  return { changed, added, removed };
}

function sumTurns(turns: ReadonlyArray<Turn>): {
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
} {
  let toolCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const t of turns) {
    toolCallCount += t.toolCallCount;
    inputTokens += t.inputTokens;
    outputTokens += t.outputTokens;
    cacheReadTokens += t.cacheReadTokens;
    cacheWriteTokens += t.cacheWriteTokens;
  }
  return { toolCallCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function buildRecord(params: {
  readonly source: "trace";
  readonly scenarioId: ScenarioIdType;
  readonly runNumber: RunNumberType;
  readonly modelName: string;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly judge: JudgeResult;
  readonly turns: ReadonlyArray<Turn>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly transcriptPath: string;
  readonly traceId?: TraceIdType;
}): RunRecord {
  const agg = sumTurns(params.turns);
  const summary = summarizeDiff(params.workspaceDiff);
  const base: RunRecord = {
    source: params.source,
    scenarioId: params.scenarioId,
    runNumber: params.runNumber,
    modelName: params.modelName,
    judgeModel: params.judgeModel,
    startedAt: params.startedAt,
    latencyMs: params.latencyMs,
    pass: params.judge.pass,
    reason: params.judge.reason,
    issues: params.judge.issues,
    overallSeverity: params.judge.overallSeverity as IssueSeverity | null,
    judgeConfidence: params.judge.judgeConfidence ?? null,
    retryCount: params.judge.retryCount,
    toolCallCount: agg.toolCallCount,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    transcriptPath: params.transcriptPath,
    workspaceDiffSummary: summary,
  };
  return params.traceId !== undefined ? { ...base, traceId: params.traceId } : base;
}

function sumAgentTurns(turns: ReadonlyArray<AgentTurn> | undefined): {
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
} {
  if (turns === undefined) {
    return {
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  return sumTurns(turns.map((entry) => entry.turn));
}

function bundleModelName(bundle: JudgmentBundle): string {
  const modelName = bundle.metadata?.["modelName"];
  return typeof modelName === "string" && modelName.length > 0
    ? modelName
    : `${bundle.project}/bundle`;
}

function buildBundleRecord(params: {
  readonly bundle: JudgmentBundle;
  readonly judge: JudgeResult;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly latencyMs: number;
}): RunRecord {
  const agg = sumAgentTurns(params.bundle.turns);
  const summary = summarizeDiff(params.bundle.workspaceDiff);
  return {
    source: RUN_SOURCE.Bundle,
    scenarioId: params.bundle.scenarioId,
    runNumber: RunNumber(1),
    modelName: bundleModelName(params.bundle),
    judgeModel: params.judgeModel,
    startedAt: params.startedAt,
    latencyMs: params.latencyMs,
    pass: params.judge.pass,
    reason: params.judge.reason,
    issues: params.judge.issues,
    overallSeverity: params.judge.overallSeverity as IssueSeverity | null,
    judgeConfidence: params.judge.judgeConfidence ?? null,
    retryCount: params.judge.retryCount,
    toolCallCount: agg.toolCallCount,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    transcriptPath: "",
    workspaceDiffSummary: summary,
  };
}

function buildReport(runs: ReadonlyArray<RunRecord>, artifactsDir: string | undefined): Report {
  let passed = 0;
  let latencyTotal = 0;
  for (const r of runs) {
    if (r.pass) passed += 1;
    latencyTotal += r.latencyMs;
  }
  const total = runs.length;
  return {
    runs,
    summary: {
      total,
      passed,
      failed: total - passed,
      avgLatencyMs: total === 0 ? 0 : latencyTotal / total,
    },
    ...(artifactsDir !== undefined ? { artifactsDir } : {}),
  };
}

function resolveCoordinatorForInput(
  input: PlannedRunInput,
  opts: HarnessRunOpts,
): RunCoordinator {
  return input.coordinator
    ?? opts.coordinator
    ?? new DefaultRunCoordinator(input.runtime ?? opts.runtime ?? new DockerRuntime());
}

export function runWithHarness(
  plan: RunPlan,
  harness: PlannedRunInput["harness"],
  opts: HarnessRunOpts = {},
): Effect.Effect<Report, never, never> {
  return runPlans([{ plan, harness }], opts);
}

export function runPlans(
  inputs: ReadonlyArray<PlannedRunInput>,
  opts: HarnessRunOpts = {},
): Effect.Effect<Report, never, never> {
  return withManagedAbortSignal(opts, (abortSignal) =>
    Effect.gen(function* () {
      const judge = opts.judge ?? new AnthropicJudgeBackend();
      const resultsDir = opts.resultsDir ?? "./eval-results";
      const emitter = makeReportEmitter({
        resultsDir,
        ...(opts.githubComment !== undefined ? { githubComment: opts.githubComment } : {}),
        ...(opts.githubCommentArtifactUrl !== undefined
          ? { githubCommentArtifactUrl: opts.githubCommentArtifactUrl }
          : {}),
      });
      const obs = opts.emitters ?? [];
      const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
      const records = yield* Effect.forEach(
        inputs,
        (input) =>
          runOnePlannedInput(
            input,
            resolveCoordinatorForInput(input, opts),
            judge,
            emitter,
            obs,
            abortSignal,
          ),
        { concurrency },
      );
      const report = buildReport(records, resultsDir);
      yield* emitter.emitReport(report);
      yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
      if (opts.githubComment !== undefined) {
        yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
      }
      return report;
    }),
  );
}

function runOnePlannedInput(
  input: PlannedRunInput,
  coordinator: RunCoordinator,
  judge: JudgeBackend,
  emitter: ReportEmitter,
  obs: ReadonlyArray<ObservabilityEmitter>,
  abortSignal: AbortSignal | undefined,
): Effect.Effect<RunRecord, never, never> {
  return Effect.gen(function* () {
    const startedAt = nowIso();
    const startMs = Date.now();
    const executionOpts = abortSignal !== undefined ? { abortSignal } : {};
    const execution = yield* Effect.either(coordinator.execute(input.plan, input.harness, executionOpts));
    const latencyMs = Date.now() - startMs;
    const record = execution._tag === "Right"
      ? buildBundleRecord({
          bundle: execution.right,
          judge: yield* judgeBundle(judge, execution.right, abortSignal),
          judgeModel: judge.name,
          startedAt,
          latencyMs,
        })
      : buildBundleRecord(
          coordinationFailureRecordInput(input.plan, execution.left, startedAt, latencyMs, abortSignal),
        );
    yield* emitter.emitRun(record);
    yield* Effect.forEach(obs, (observer) => observer.onRun({ record }), { discard: true });
    return record;
  });
}

export function scoreBundles(
  bundles: ReadonlyArray<JudgmentBundle>,
  opts: ScoreOpts = {},
): Effect.Effect<Report, never, never> {
  return withManagedAbortSignal(opts, (abortSignal) =>
    Effect.gen(function* () {
      const judge = opts.judge ?? new AnthropicJudgeBackend();
      const resultsDir = opts.resultsDir ?? "./eval-results";
      const emitter = makeReportEmitter({
        resultsDir,
        ...(opts.githubComment !== undefined ? { githubComment: opts.githubComment } : {}),
        ...(opts.githubCommentArtifactUrl !== undefined
          ? { githubCommentArtifactUrl: opts.githubCommentArtifactUrl }
          : {}),
      });
      const obs = opts.emitters ?? [];
      const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
      const records = yield* Effect.forEach(
        bundles,
        (bundle) => scoreOneBundle(bundle, judge, emitter, obs, abortSignal),
        { concurrency },
      );
      const report = buildReport(records, resultsDir);
      yield* emitter.emitReport(report);
      yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
      if (opts.githubComment !== undefined) {
        yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
      }
      return report;
    }),
  );
}

export function scoreTraces(
  traces: ReadonlyArray<Trace>,
  opts: ScoreOpts = {},
): Effect.Effect<Report, never, never> {
  return withManagedAbortSignal(opts, (abortSignal) =>
    Effect.gen(function* () {
      const judge = opts.judge ?? new AnthropicJudgeBackend();
      const resultsDir = opts.resultsDir ?? "./eval-results";
      const emitter = makeReportEmitter({
        resultsDir,
        ...(opts.githubComment !== undefined ? { githubComment: opts.githubComment } : {}),
        ...(opts.githubCommentArtifactUrl !== undefined
          ? { githubCommentArtifactUrl: opts.githubCommentArtifactUrl }
          : {}),
      });
      const obs = opts.emitters ?? [];
      const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

      const records = yield* Effect.forEach(
        traces,
        (trace) => scoreOneTrace(trace, judge, emitter, obs, abortSignal),
        { concurrency },
      );
      const report = buildReport(records, resultsDir);
      yield* emitter.emitReport(report);
      yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
      if (opts.githubComment !== undefined) {
        yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
      }
      return report;
    }),
  );
}

function traceToJudgeTarget(trace: Trace): {
  readonly scenarioId: ScenarioIdType;
  readonly name: string;
  readonly description: string;
  readonly requirements: {
    readonly expectedBehavior: string;
    readonly validationChecks: ReadonlyArray<string>;
    readonly judgeRubric?: string;
  };
} {
  return {
    scenarioId: trace.scenarioId ?? scenarioIdFromTraceId(trace.traceId),
    name: trace.name,
    description: "",
    requirements: {
      expectedBehavior: trace.expectedBehavior,
      validationChecks: trace.validationChecks,
      ...(trace.judgeRubric !== undefined ? { judgeRubric: trace.judgeRubric } : {}),
    },
  };
}

function scoreOneTrace(
  trace: Trace,
  judge: JudgeBackend,
  emitter: ReportEmitter,
  obs: ReadonlyArray<ObservabilityEmitter>,
  abortSignal: AbortSignal | undefined,
): Effect.Effect<RunRecord, never, never> {
  return Effect.gen(function* () {
    const startedAt = nowIso();
    const startMs = Date.now();
    const target = traceToJudgeTarget(trace);
    const judgeResult = yield* judge.judge({
      target,
      turns: trace.turns,
      ...(trace.workspaceDiff !== undefined ? { workspaceDiff: trace.workspaceDiff } : {}),
      ...(trace.events !== undefined ? { events: trace.events } : {}),
      ...(trace.phases !== undefined ? { phases: trace.phases } : {}),
      ...(trace.agents !== undefined ? { agents: trace.agents } : {}),
      ...(trace.context !== undefined ? { context: trace.context } : {}),
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
    const record = buildRecord({
      source: "trace",
      scenarioId: target.scenarioId,
      runNumber: RunNumber(1),
      modelName: "trace",
      judgeModel: judge.name,
      startedAt,
      latencyMs: Date.now() - startMs,
      judge: judgeResult,
      turns: trace.turns,
      ...(trace.workspaceDiff !== undefined ? { workspaceDiff: trace.workspaceDiff } : {}),
      transcriptPath: "",
      traceId: trace.traceId,
    });
    yield* emitter.emitRun(record);
    yield* Effect.forEach(obs, (observer) => observer.onRun({ record }), { discard: true });
    return record;
  });
}

function scoreOneBundle(
  bundle: JudgmentBundle,
  judge: JudgeBackend,
  emitter: ReportEmitter,
  obs: ReadonlyArray<ObservabilityEmitter>,
  abortSignal: AbortSignal | undefined,
): Effect.Effect<RunRecord, never, never> {
  return Effect.gen(function* () {
    const startedAt = nowIso();
    const startMs = Date.now();
    const judgeResult = yield* judgeBundle(judge, bundle, abortSignal);
    const record = buildBundleRecord({
      bundle,
      judge: judgeResult,
      judgeModel: judge.name,
      startedAt,
      latencyMs: Date.now() - startMs,
    });
    yield* emitter.emitRun(record);
    yield* Effect.forEach(obs, (e) => e.onRun({ record }), { discard: true });
    return record;
  });
}

function coordinationFailureRecordInput(
  plan: RunPlan,
  error: RunCoordinationError,
  startedAt: string,
  latencyMs: number,
  abortSignal: AbortSignal | undefined,
): {
  readonly bundle: JudgmentBundle;
  readonly judge: JudgeResult;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly latencyMs: number;
} {
  const endedAt = nowIso();
  const outcomes = coordinationFailureOutcomes(plan, error, endedAt, abortSignal);
  const judge = deterministicFailureJudge(outcomes);
  return {
    bundle: coordinationFailureBundle(plan, error, outcomes),
    judge,
    judgeModel: "deterministic/coordinator",
    startedAt,
    latencyMs,
  };
}

function coordinationFailureBundle(
  plan: RunPlan,
  error: RunCoordinationError,
  outcomes: ReadonlyArray<JudgmentBundle["outcomes"][number]>,
): JudgmentBundle {
  return {
    runId: RunId(randomUUID()),
    project: plan.project,
    scenarioId: plan.scenarioId,
    name: plan.name,
    description: plan.description,
    requirements: plan.requirements,
    agents: plan.agents.map(agentRefFromDeclaration),
    outcomes: [...outcomes],
    metadata: {
      coordinationFailure: error.cause._tag,
      modelName: `${plan.project}/coordinator`,
      failureFold: "deterministic",
    },
  };
}

function coordinationFailureOutcomes(
  plan: RunPlan,
  error: RunCoordinationError,
  endedAt: string,
  abortSignal: AbortSignal | undefined,
): ReadonlyArray<JudgmentBundle["outcomes"][number]> {
  const cancelledReason = abortSignal?.aborted === true
    ? "run cancelled via abort signal"
    : "run cancelled after another agent failed";
  const cause = error.cause;
  switch (cause._tag) {
    case "AgentStartFailed":
      return plan.agents.map((agent) =>
        agent.id === cause.agentId
          ? {
              agentId: agent.id,
              status: "failed_to_start" as const,
              endedAt,
              reason: renderAgentStartCause(cause.detail),
            }
          : {
              agentId: agent.id,
              status: "cancelled" as const,
              endedAt,
              reason: cancelledReason,
            });
    case "HarnessFailed":
      return plan.agents.map((agent) => ({
        agentId: agent.id,
        status: abortSignal?.aborted === true ? "cancelled" as const : "runtime_error" as const,
        endedAt,
        reason: abortSignal?.aborted === true ? cancelledReason : renderHarnessFailureCause(cause.detail),
      }));
    case "BundleBuildFailed":
      return plan.agents.map((agent) => ({
        agentId: agent.id,
        status: abortSignal?.aborted === true ? "cancelled" as const : "runtime_error" as const,
        endedAt,
        reason: abortSignal?.aborted === true ? cancelledReason : renderBundleBuildFailureCause(cause.detail),
      }));
    default:
      return plan.agents.map((agent) => ({
        agentId: agent.id,
        status: abortSignal?.aborted === true ? "cancelled" as const : "runtime_error" as const,
        endedAt,
        reason: abortSignal?.aborted === true
          ? cancelledReason
          : renderUnknownCoordinationFailure(cause),
      }));
  }
}

function deterministicFailureJudge(
  outcomes: ReadonlyArray<JudgmentBundle["outcomes"][number]>,
): JudgeResult {
  const issues = outcomes.map((outcome) => ({
    issue: `${outcome.agentId} ${outcome.status}${outcome.reason !== undefined ? `: ${outcome.reason}` : ""}`,
    severity: "critical" as const,
  }));
  return {
    pass: false,
    reason: `coordination failed: ${issues.map((issue) => issue.issue).join("; ")}`,
    issues,
    overallSeverity: "critical",
    retryCount: 0,
  };
}

function renderUnknownCoordinationFailure(
  cause: RunCoordinationError["cause"],
): string {
  const detail = JSON.stringify(cause);
  return detail === undefined
    ? "unexpected coordination failure"
    : `unexpected coordination failure: ${detail}`;
}

function renderAgentStartCause(cause: AgentStartErrorCause): string {
  switch (cause._tag) {
    case "BuildContextMissing":
      return `build context missing at ${cause.path}`;
    case "DockerBuildFailed":
      return `docker build failed: ${cause.message}`;
    case "ImageMissing":
      return `image missing: ${cause.image}`;
    case "ImagePullFailed":
      return `image pull failed for ${cause.image}: ${cause.message}`;
    case "ContainerStartFailed":
      return `container start failed: ${cause.message}`;
    case "BinaryNotFound":
      return `binary not found: ${cause.path}`;
    case "WorkspacePathEscape":
      return `workspace path escaped root: ${cause.wfPath}`;
    case "WorkspaceSetupFailed":
      return `workspace setup failed: ${cause.message}`;
  }
}

function renderHarnessFailureCause(cause: HarnessExecutionCause): string {
  switch (cause._tag) {
    case "MissingRuntimeHandle":
      return `missing runtime handle for ${cause.agentId}`;
    case "InvalidPlanMetadata":
      return cause.message;
    case "ExecutionFailed":
      return cause.message;
  }
}

function renderBundleBuildFailureCause(cause: BundleBuildCause): string {
  switch (cause._tag) {
    case "DuplicateOutcome":
      return `duplicate outcome emitted for ${cause.agentId}`;
    case "MissingOutcomes":
      return `missing outcomes for ${cause.agentIds.join(", ")}`;
    case "UnknownAgent":
      return `unknown agent ${cause.agentId}`;
    case "EventOrderViolation":
      return `event order violated: ${String(cause.previousTs)} before ${String(cause.nextTs)}`;
    case "SchemaInvalid":
      return `bundle schema invalid: ${cause.errors.join("; ")}`;
  }
}
