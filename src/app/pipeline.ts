// Pipeline orchestration: composes runner + judge + report + observability.
// Public SDK entrypoints. Invariant #3: error channel is `never` — all internal
// failures fold into per-run RunRecords; the pipeline always produces a Report.

import { Effect } from "effect";
import type { Report, RunRecord, Scenario, Trace, JudgeResult } from "../core/schema.js";
import type { Turn, WorkspaceDiff, IssueSeverity } from "../core/types.js";
import { ScenarioId, RunNumber, TraceId } from "../core/types.js";
import { AnthropicJudgeBackend, type JudgeBackend } from "../judge/index.js";
import { DockerRunner, SubprocessRunner, type AgentRunner, type AgentHandle } from "../runner/index.js";
import { makeReportEmitter, type ReportEmitter } from "../emit/report.js";
import type { ObservabilityEmitter } from "../emit/observability.js";
import { RunnerResolutionError } from "../core/errors.js";
import type { RunOpts, ScoreOpts } from "./opts.js";

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
  readonly scenarioId: string;
  readonly runNumber: number;
  readonly modelName: string;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly judge: JudgeResult;
  readonly turns: ReadonlyArray<Turn>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly transcriptPath: string;
  readonly traceId?: string;
}): RunRecord {
  const agg = sumTurns(params.turns);
  const summary = summarizeDiff(params.workspaceDiff);
  const base: RunRecord = {
    source: params.source,
    scenarioId: ScenarioId(params.scenarioId),
    runNumber: RunNumber(params.runNumber),
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
  return params.traceId !== undefined ? { ...base, traceId: TraceId(params.traceId) } : base;
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
  runNumber: number,
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

    const jobs: Array<{ readonly scenario: Scenario; readonly runNumber: number }> = [];
    for (const s of selected) {
      for (let i = 1; i <= runsPer; i += 1) jobs.push({ scenario: s, runNumber: i });
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
    yield* Effect.forEach(obs, (e) => e.onReport({ report }), { discard: true });
    if (opts.githubComment !== undefined) {
      yield* emitter.publishGithubComment(report).pipe(Effect.catchAll(() => Effect.void));
    }
    return report;
  });
}

function traceToScenario(trace: Trace): Scenario {
  return {
    id: trace.scenarioId ?? ScenarioId(trace.traceId),
    name: trace.name,
    description: "",
    setupPrompt: trace.turns.length > 0 ? (trace.turns[0]?.prompt ?? "") : "",
    expectedBehavior: trace.expectedBehavior,
    validationChecks: trace.validationChecks,
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
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
    const record = buildRecord({
      source: "trace",
      scenarioId: scenario.id,
      runNumber: 1,
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
    yield* Effect.forEach(obs, (e) => e.onRun({ record }), { discard: true });
    return record;
  });
}
