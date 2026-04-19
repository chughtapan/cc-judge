// Pipeline orchestration: composes runner + judge + report + observability.
// Public SDK entrypoints. Invariant #3: error channel is `never` — all internal
// failures fold into per-run RunRecords; the pipeline always produces a Report.

import { Effect } from "effect";
import type { Report, RunRecord, Scenario, Trace, JudgeResult } from "../core/schema.js";
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
  DockerRunner,
  SubprocessRunner,
  type AgentRunner,
  type AgentHandle,
} from "../runner/index.js";
import { makeReportEmitter, type ReportEmitter } from "../emit/report.js";
import type { ObservabilityEmitter } from "../emit/observability.js";
import {
  RunCoordinationError,
  RunnerResolutionError,
  type AgentStartErrorCause,
  type BundleBuildCause,
  type HarnessExecutionCause,
} from "../core/errors.js";
import type { HarnessRunOpts, PlannedRunInput, RunOpts, ScoreOpts } from "./opts.js";

const DEFAULT_RUNS_PER_SCENARIO = 1;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
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

function criticalJudgeFromError(message: string): JudgeResult {
  return {
    pass: false,
    reason: `pipeline error: ${message}`,
    issues: [{ issue: message, severity: "critical" }],
    overallSeverity: "critical",
    retryCount: 0,
  };
}

function buildRecord(params: {
  readonly source: "scenario" | "trace";
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

function runAgentTurns(
  runner: AgentRunner,
  handle: AgentHandle,
  scenario: Scenario,
  timeoutMs: number,
): Effect.Effect<
  { readonly turns: ReadonlyArray<Turn>; readonly error: string | null },
  never,
  never
> {
  const prompts: ReadonlyArray<string> = [scenario.setupPrompt, ...(scenario.followUps ?? [])];
  return Effect.gen(function* () {
    const turns: Turn[] = [];
    let error: string | null = null;
    for (const prompt of prompts) {
      const attempt = yield* Effect.either(runner.turn(handle, prompt, { timeoutMs }));
      if (attempt._tag === "Left") {
        error = `agent turn timed out after ${String(timeoutMs)}ms (turn ${String(attempt.left.turnIndex)})`;
        break;
      }
      turns.push(attempt.right);
    }
    return { turns: turns as ReadonlyArray<Turn>, error };
  });
}

function runOneScenarioOnce(
  scenario: Scenario,
  runNumber: RunNumberType,
  runner: AgentRunner,
  judge: JudgeBackend,
  emitter: ReportEmitter,
  obs: ReadonlyArray<ObservabilityEmitter>,
  modelName: string,
  judgeModel: string,
  abortSignal: AbortSignal | undefined,
): Effect.Effect<RunRecord, never, never> {
  return Effect.gen(function* () {
    const startedAt = nowIso();
    const startMs = Date.now();
    const startRes = yield* Effect.either(runner.start(scenario));
    if (startRes._tag === "Left") {
      const msg = `agent start failed: ${startRes.left.cause._tag}`;
      const record = buildRecord({
        source: "scenario",
        scenarioId: scenario.id,
        runNumber,
        modelName,
        judgeModel,
        startedAt,
        latencyMs: Date.now() - startMs,
        judge: criticalJudgeFromError(msg),
        turns: [],
        transcriptPath: "",
      });
      yield* emitter.emitRun(record);
      yield* Effect.forEach(obs, (e) => e.onRun({ record }), { discard: true });
      return record;
    }
    const handle = startRes.right;
    const turnTimeout = scenario.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const turnRes = yield* runAgentTurns(runner, handle, scenario, turnTimeout);
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    const judgeResult = turnRes.error !== null
      ? criticalJudgeFromError(turnRes.error)
      : yield* judge.judge({ scenario, turns: turnRes.turns, workspaceDiff: diff, ...(abortSignal !== undefined ? { abortSignal } : {}) });
    const record = buildRecord({
      source: "scenario",
      scenarioId: scenario.id,
      runNumber,
      modelName,
      judgeModel,
      startedAt,
      latencyMs: Date.now() - startMs,
      judge: judgeResult,
      turns: turnRes.turns,
      workspaceDiff: diff,
      transcriptPath: handle.workspaceDir,
    });
    yield* emitter.emitRun(record);
    yield* Effect.forEach(obs, (e) => e.onRun({ record }), { discard: true });
    return record;
  });
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

function resolveRunner(opts: RunOpts): Effect.Effect<AgentRunner, RunnerResolutionError, never> {
  if (opts.runner !== undefined) return Effect.succeed(opts.runner);
  if (process.env["CC_JUDGE_SUBPROCESS_BIN"] !== undefined) {
    return Effect.succeed(new SubprocessRunner({ bin: process.env["CC_JUDGE_SUBPROCESS_BIN"] }));
  }
  const image = process.env["CC_JUDGE_DOCKER_IMAGE"];
  if (image === undefined) {
    return Effect.fail(new RunnerResolutionError({ cause: { _tag: "NoRunnerConfigured" } }));
  }
  return Effect.succeed(new DockerRunner({ image }));
}

export function runScenarios(
  scenarios: ReadonlyArray<Scenario>,
  opts: RunOpts = {},
): Effect.Effect<Report, RunnerResolutionError, never> {
  return Effect.gen(function* () {
    const runner = yield* resolveRunner(opts);
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
    const runsPer = opts.runsPerScenario ?? DEFAULT_RUNS_PER_SCENARIO;
    const modelName = runner.kind === "docker" ? "claude-agent-sdk/docker" : "claude-agent-sdk/subprocess";
    const judgeModel = judge.name;

    const filter = opts.scenarioIdFilter;
    const selected = filter !== undefined && filter.length > 0
      ? scenarios.filter((s) => filter.includes(s.id))
      : scenarios;

    const jobs: Array<{ readonly scenario: Scenario; readonly runNumber: RunNumberType }> = [];
    for (const s of selected) {
      for (let i = 1; i <= runsPer; i += 1) jobs.push({ scenario: s, runNumber: RunNumber(i) });
    }

    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    const records = yield* Effect.forEach(
      jobs,
      (j) =>
        runOneScenarioOnce(
          j.scenario,
          j.runNumber,
          runner,
          judge,
          emitter,
          obs,
          modelName,
          judgeModel,
          opts.abortSignal,
        ),
      { concurrency },
    );
    const report = buildReport(records, resultsDir);
    yield* emitter.emitReport(report);
    yield* Effect.forEach(obs, (e) => e.onReport({ report }), { discard: true });
    if (opts.githubComment !== undefined) {
      yield* emitter.publishGithubComment(report).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
    return report;
  });
}

export function runScenario(scenario: Scenario, opts: RunOpts = {}): Effect.Effect<Report, RunnerResolutionError, never> {
  return runScenarios([scenario], opts);
}

function resolveCoordinator(opts: HarnessRunOpts) {
  return opts.coordinator ?? new DefaultRunCoordinator(opts.runtime ?? new DockerRuntime());
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
  return Effect.gen(function* () {
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
    const coordinator = resolveCoordinator(opts);
    const records = yield* Effect.forEach(
      inputs,
      (input) => runOnePlannedInput(input, coordinator, judge, emitter, obs, opts.abortSignal),
      { concurrency },
    );
    const report = buildReport(records, resultsDir);
    yield* emitter.emitReport(report);
    yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
    if (opts.githubComment !== undefined) {
      yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
    }
    return report;
  });
}

function runOnePlannedInput(
  input: PlannedRunInput,
  coordinator: ReturnType<typeof resolveCoordinator>,
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
  return Effect.gen(function* () {
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
      (bundle) => scoreOneBundle(bundle, judge, emitter, obs, opts.abortSignal),
      { concurrency },
    );
    const report = buildReport(records, resultsDir);
    yield* emitter.emitReport(report);
    yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
    if (opts.githubComment !== undefined) {
      yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
    }
    return report;
  });
}

export function scoreTraces(
  traces: ReadonlyArray<Trace>,
  opts: ScoreOpts = {},
): Effect.Effect<Report, never, never> {
  return Effect.gen(function* () {
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
      (trace) => scoreOneTrace(trace, judge, emitter, obs, opts.abortSignal),
      { concurrency },
    );
    const report = buildReport(records, resultsDir);
    yield* emitter.emitReport(report);
    yield* Effect.forEach(obs, (observer) => observer.onReport({ report }), { discard: true });
    if (opts.githubComment !== undefined) {
      yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
    }
    return report;
  });
}

function traceToScenario(trace: Trace): Scenario {
  return {
    id: trace.scenarioId ?? scenarioIdFromTraceId(trace.traceId),
    name: trace.name,
    description: "",
    setupPrompt: trace.turns.length > 0 ? (trace.turns[0]?.prompt ?? "") : "",
    expectedBehavior: trace.expectedBehavior,
    validationChecks: trace.validationChecks,
    ...(trace.judgeRubric !== undefined ? { judgeRubric: trace.judgeRubric } : {}),
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
    const scenario = traceToScenario(trace);
    const judgeResult = yield* judge.judge({
      scenario,
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
      scenarioId: scenario.id,
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
    runId: RunId(`${plan.project}:${plan.scenarioId}:failed:${Date.now()}`),
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
