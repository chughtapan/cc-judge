// JudgeBackend interface + bundled AnthropicJudgeBackend.
// Invariant #3: judge() error channel is `never`. Every internal failure folds
// into a JudgeResult with pass=false, overallSeverity="critical", and the
// retry count reflected on the record so observers can see how hard we tried.

import { Data, Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRef,
  AgentTurn,
  Issue,
  IssueSeverity,
  JudgmentBundle,
  Phase,
  RunRequirements,
  ScenarioId,
  TraceEvent,
  Turn,
  WorkspaceDiff,
} from "../core/types.js";
import {
  type JudgeResult,
  JudgeResultSchema,
} from "../core/schema.js";

export interface JudgeTarget {
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly requirements: RunRequirements;
}

export interface JudgeInput {
  readonly target: JudgeTarget;
  readonly turns: ReadonlyArray<Turn>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly events?: ReadonlyArray<TraceEvent>;
  readonly phases?: ReadonlyArray<Phase>;
  readonly agents?: ReadonlyArray<AgentRef>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
}

export interface JudgeBackend {
  readonly name: string;
  judge(input: JudgeInput): Effect.Effect<JudgeResult, never, never>;
}

export type JudgeBundleInput = JudgmentBundle;

export interface AnthropicJudgeBackendOpts {
  readonly model?: string;
  readonly maxTurns?: number;
  readonly perAttemptTimeoutMs?: number;
  readonly retrySchedule?: ReadonlyArray<number>;
  readonly systemPrompt?: string;
}

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TURNS = 4;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 120_000;
// Exponential backoff in ms (spec assumption #15).
const DEFAULT_RETRY_SCHEDULE: ReadonlyArray<number> = [500, 1_500, 4_500];

// What we ask the judge model to emit. Kept tight so parse errors are rare.
export const JUDGE_SYSTEM_PROMPT = `You are a verdict-only evaluator. Read the evaluation target, the agent transcript, and the workspace diff; then emit a single JSON object and nothing else. Schema:
{
  "pass": boolean,
  "reason": string,
  "issues": [{ "issue": string, "severity": "minor" | "significant" | "critical" }],
  "overallSeverity": "minor" | "significant" | "critical" | null,
  "judgeConfidence": number (0-1)
}
Every validation check in the evaluation target is either met or not; list unmet checks as issues. If pass is true, issues may still list minor nits. overallSeverity is null when pass is true and no issues were listed, otherwise the most severe issue. Do not wrap the JSON in markdown fences.`;

function renderDiff(diff: WorkspaceDiff | undefined): string {
  if (diff === undefined || diff.changed.length === 0) return "(no workspace changes)";
  const lines: string[] = [];
  for (const c of diff.changed) {
    if (c.before === null && c.after !== null) {
      lines.push(`+ added ${c.path} (${c.after.length} bytes)`);
    } else if (c.before !== null && c.after === null) {
      lines.push(`- removed ${c.path}`);
    } else {
      lines.push(`~ modified ${c.path}`);
    }
  }
  return lines.join("\n");
}

function renderTurns(turns: ReadonlyArray<Turn>): string {
  const parts: string[] = [];
  for (const t of turns) {
    parts.push(`--- Turn ${t.index} ---`);
    parts.push(`USER: ${t.prompt}`);
    parts.push(`ASSISTANT: ${t.response}`);
  }
  return parts.join("\n");
}

function renderEvents(events: ReadonlyArray<TraceEvent>): string {
  const parts: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "message":
        parts.push(`[${new Date(e.ts).toISOString()}] [${e.channel}] ${e.from}${e.to ? ` -> ${e.to}` : ""}: ${e.text}`);
        break;
      case "phase":
        parts.push(`[${new Date(e.ts).toISOString()}] PHASE: ${e.phase}${e.round !== undefined ? ` (round ${e.round})` : ""}`);
        break;
      case "action":
        parts.push(`[${new Date(e.ts).toISOString()}] [${e.channel}] ${e.agent} ACTION: ${e.action}`);
        break;
      case "state":
        parts.push(`[${new Date(e.ts).toISOString()}] STATE: ${JSON.stringify(e.snapshot)}`);
        break;
    }
  }
  return parts.join("\n");
}

function renderAgents(agents: ReadonlyArray<AgentRef>): string {
  return agents.map((a) => `- ${a.name} (${a.id})${a.role ? ` role=${a.role}` : ""}`).join("\n");
}

function bundleToJudgeTarget(bundle: JudgmentBundle): JudgeTarget {
  return {
    scenarioId: bundle.scenarioId,
    name: bundle.name,
    description: bundle.description,
    requirements: bundle.requirements,
  };
}

function bundleTurnsToTurns(bundle: JudgmentBundle): ReadonlyArray<Turn> {
  return bundle.turns?.map((entry) => entry.turn) ?? [];
}

function bundleTurnsToEvents(bundle: JudgmentBundle): ReadonlyArray<TraceEvent> | undefined {
  if (bundle.events !== undefined && bundle.events.length > 0) {
    return bundle.events;
  }
  if (bundle.turns === undefined || bundle.turns.length === 0) {
    return undefined;
  }
  const agentNameById = new Map(bundle.agents.map((agent) => [agent.id, agent.name]));
  const events: TraceEvent[] = [];
  for (const entry of bundle.turns) {
    events.push(...turnEntryToEvents(entry, agentNameById));
  }
  return events;
}

function turnEntryToEvents(
  entry: AgentTurn,
  agentNameById: ReadonlyMap<string, string>,
): ReadonlyArray<TraceEvent> {
  const promptTs = Date.parse(entry.turn.startedAt);
  const safePromptTs = Number.isFinite(promptTs) ? promptTs : Date.now();
  const agentId = entry.agentId;
  const agentName = agentId !== undefined
    ? (agentNameById.get(agentId) ?? agentId)
    : "assistant";
  return [
    {
      type: "message",
      from: "user",
      to: agentName,
      channel: "prompt",
      text: entry.turn.prompt,
      ts: safePromptTs,
    },
    {
      type: "message",
      from: agentName,
      channel: "response",
      text: entry.turn.response,
      ts: safePromptTs + entry.turn.latencyMs,
    },
  ];
}

export function bundleToJudgeInput(bundle: JudgmentBundle, abortSignal?: AbortSignal): JudgeInput {
  const events = bundleTurnsToEvents(bundle);
  const context = {
    ...(bundle.context ?? {}),
    agentOutcomes: bundle.outcomes,
  };
  return {
    target: bundleToJudgeTarget(bundle),
    turns: bundleTurnsToTurns(bundle),
    ...(bundle.workspaceDiff !== undefined ? { workspaceDiff: bundle.workspaceDiff } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(bundle.phases !== undefined ? { phases: bundle.phases } : {}),
    ...(bundle.agents.length > 0 ? { agents: bundle.agents } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  };
}

export function judgeBundle(
  backend: JudgeBackend,
  bundle: JudgmentBundle,
  abortSignal?: AbortSignal,
): Effect.Effect<JudgeResult, never, never> {
  return backend.judge(bundleToJudgeInput(bundle, abortSignal));
}

function renderPrompt(input: JudgeInput): string {
  const target = input.target;
  const checks = target.requirements.validationChecks.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const sections: string[] = [
    `# Evaluation target: ${target.name}`,
    `Description: ${target.description}`,
    `Expected behavior: ${target.requirements.expectedBehavior}`,
    "",
    "Validation checks (each must hold for pass=true):",
    checks,
  ];

  if (input.agents !== undefined && input.agents.length > 0) {
    sections.push("", "# Agents", renderAgents(input.agents));
  }

  if (input.events !== undefined && input.events.length > 0) {
    sections.push("", "# Event timeline", renderEvents(input.events));
  } else {
    sections.push("", "# Transcript", renderTurns(input.turns));
  }

  sections.push("", "# Workspace diff", renderDiff(input.workspaceDiff));

  if (input.context !== undefined && Object.keys(input.context).length > 0) {
    sections.push("", "# Context", JSON.stringify(input.context, null, 2));
  }

  sections.push("", "Return the JSON verdict now.");
  return sections.join("\n");
}

function extractJsonText(text: string): string {
  // The prompt says no markdown fences, but models slip. Strip a leading
  // ```json / ``` fence pair if present. Never tries to repair the JSON body.
  const trimmed = text.trim();
  const fenceStart = /^```(?:json)?\s*/u;
  const fenceEnd = /\s*```\s*$/u;
  return trimmed.replace(fenceStart, "").replace(fenceEnd, "").trim();
}

interface RawJudgeVerdict {
  readonly pass?: unknown;
  readonly reason?: unknown;
  readonly issues?: unknown;
  readonly overallSeverity?: unknown;
  readonly judgeConfidence?: unknown;
}

interface ParsedAssistantResult {
  readonly text: string;
  readonly structured: unknown;
}

function collectAssistantText(messages: ReadonlyArray<SDKMessage>): ParsedAssistantResult {
  let text = "";
  let structured: unknown = undefined;
  for (const m of messages) {
    if (m.type === "result" && m.subtype === "success") {
      text = m.result;
      structured = m.structured_output;
    } else if (m.type === "assistant") {
      const content = m.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: unknown }).type === "text" &&
            "text" in block &&
            typeof (block as { text: unknown }).text === "string"
          ) {
            text += (block as { text: string }).text;
          }
        }
      }
    }
  }
  return { text, structured };
}

// Tagged errors used internally by the judge pipeline. None escape — they are
// folded into a synthetic JudgeResult before leaving `judge()` (invariant #3).
class JudgeAttemptError extends Data.TaggedError("JudgeAttemptError")<{
  readonly kind:
    | "SdkFailed"
    | "NoOutput"
    | "MalformedJson"
    | "SchemaInvalid"
    | "Timeout"
    | "ResultError";
  readonly message: string;
}> {}

function collectSdkMessages(
  prompt: string,
  model: string,
  maxTurns: number,
  abortController: AbortController,
  systemPrompt: string,
  timeoutMs: number,
): Effect.Effect<ReadonlyArray<SDKMessage>, JudgeAttemptError, never> {
  return Effect.suspend(() => {
    const q = query({
      prompt,
      options: {
        model,
        maxTurns,
        abortController,
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
        allowDangerouslySkipPermissions: true,
      },
    });
    const iter = q[Symbol.asyncIterator]();
    const collected: SDKMessage[] = [];
    const deadline = Date.now() + timeoutMs;

    const nextWithTimeout = Effect.tryPromise({
      try: () => iter.next(),
      catch: (error) =>
        new JudgeAttemptError({
          kind: "SdkFailed",
          message: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: Math.max(1, deadline - Date.now()),
        onTimeout: () =>
          new JudgeAttemptError({
            kind: "Timeout",
            message: `per-attempt timeout after ${timeoutMs}ms`,
          }),
      }),
      Effect.tapError((error) =>
        error.kind === "Timeout"
          ? Effect.sync(() => {
              abortController.abort();
            }).pipe(
              Effect.zipRight(
                Effect.tryPromise({
                  try: () => iter.return?.() ?? Promise.resolve(undefined),
                  catch: (returnError) => returnError,
                }).pipe(
                  Effect.catchAll((returnError) => {
                    void returnError;
                    return Effect.void;
                  }),
                ),
              ),
            )
          : Effect.void,
      ),
    );

      const step: Effect.Effect<ReadonlyArray<SDKMessage>, JudgeAttemptError, never> = nextWithTimeout.pipe(
        Effect.flatMap((result) => {
          if (result.done === true) {
            return Effect.succeed(collected as ReadonlyArray<SDKMessage>);
        }
        collected.push(result.value);
        return step;
      }),
    );

    return step;
  });
}

function parseVerdict(parsed: ParsedAssistantResult): Effect.Effect<JudgeResult, JudgeAttemptError, never> {
  let value: unknown;
  if (parsed.structured !== undefined && parsed.structured !== null) {
    value = parsed.structured;
  } else {
    const raw = extractJsonText(parsed.text);
    if (raw.length === 0) {
      return Effect.fail(
        new JudgeAttemptError({
          kind: "NoOutput",
          message: "judge model returned empty output",
        }),
      );
    }
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return Effect.fail(
        new JudgeAttemptError({
          kind: "MalformedJson",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return buildResult(value, 0);
}

function buildResult(
  value: unknown,
  retryCount: number,
): Effect.Effect<JudgeResult, JudgeAttemptError, never> {
  if (typeof value !== "object" || value === null) {
    return Effect.fail(
      new JudgeAttemptError({
        kind: "SchemaInvalid",
        message: "verdict is not an object",
      }),
    );
  }
  const raw: RawJudgeVerdict = value;
  const candidate = {
    pass: typeof raw.pass === "boolean" ? raw.pass : false,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    issues: coerceIssues(raw.issues),
    overallSeverity: coerceSeverity(raw.overallSeverity),
    judgeConfidence: coerceConfidence(raw.judgeConfidence),
    retryCount,
  };
  const errs: string[] = [];
  for (const e of Value.Errors(JudgeResultSchema, candidate)) {
    errs.push(`${e.path} ${e.message}`);
  }
  if (errs.length > 0) {
    return Effect.fail(
      new JudgeAttemptError({
        kind: "SchemaInvalid",
        message: errs.join("; "),
      }),
    );
  }
  const decoded = Value.Decode(JudgeResultSchema, candidate);
  const result: JudgeResult = {
    pass: decoded.pass,
    reason: decoded.reason,
    issues: decoded.issues as ReadonlyArray<Issue>,
    overallSeverity: decoded.overallSeverity as IssueSeverity | null,
    retryCount: decoded.retryCount,
    ...(decoded.judgeConfidence !== undefined ? { judgeConfidence: decoded.judgeConfidence } : {}),
  };
  return Effect.succeed(result);
}

function coerceIssues(v: unknown): ReadonlyArray<Issue> {
  if (!Array.isArray(v)) return [];
  const out: Issue[] = [];
  for (const entry of v) {
    if (typeof entry !== "object" || entry === null) continue;
    const e: { issue?: unknown; severity?: unknown } = entry;
    if (typeof e.issue !== "string") continue;
    const severity = coerceSeverity(e.severity);
    if (severity === null) continue;
    out.push({ issue: e.issue, severity });
  }
  return out;
}

function coerceSeverity(v: unknown): IssueSeverity | null {
  if (v === "minor" || v === "significant" || v === "critical") return v;
  return null;
}

function coerceConfidence(v: unknown): number | undefined {
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function sleepEff(ms: number): Effect.Effect<void, never, never> {
  return Effect.async<void, never, never>((resume) => {
    const t = setTimeout(() => resume(Effect.succeed(undefined)), ms);
    return Effect.sync(() => {
      clearTimeout(t);
    });
  });
}

function criticalFallback(
  err: JudgeAttemptError,
  retryCount: number,
): JudgeResult {
  const issues: ReadonlyArray<Issue> = [
    { issue: `judge ${err.kind}: ${err.message}`, severity: "critical" },
  ];
  return {
    pass: false,
    reason: `judge could not produce a verdict (${err.kind})`,
    issues,
    overallSeverity: "critical",
    retryCount,
  };
}

function runAttempt(
  input: JudgeInput,
  systemPrompt: string,
  model: string,
  maxTurns: number,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  attempt: number,
): Effect.Effect<JudgeResult, JudgeAttemptError, never> {
  const abortController = new AbortController();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) abortController.abort();
    else parentSignal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  const prompt = renderPrompt(input);
  return collectSdkMessages(
    prompt,
    model,
    maxTurns,
    abortController,
    systemPrompt,
    timeoutMs,
  ).pipe(
    Effect.flatMap((messages) => {
      for (const m of messages) {
        if (m.type === "result" && m.subtype !== "success") {
          return Effect.fail(
            new JudgeAttemptError({
              kind: "ResultError",
              message: m.errors.length > 0 ? m.errors.join("; ") : m.subtype,
            }),
          );
        }
      }
      return parseVerdict(collectAssistantText(messages));
    }),
    Effect.map((r): JudgeResult => ({ ...r, retryCount: attempt })),
  );
}

export class AnthropicJudgeBackend implements JudgeBackend {
  readonly name = "anthropic";
  readonly #model: string;
  readonly #maxTurns: number;
  readonly #perAttemptTimeoutMs: number;
  readonly #retrySchedule: ReadonlyArray<number>;
  readonly #systemPrompt: string;

  constructor(opts: AnthropicJudgeBackendOpts = {}) {
    this.#model = opts.model ?? DEFAULT_MODEL;
    this.#maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.#perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
    this.#retrySchedule = opts.retrySchedule ?? DEFAULT_RETRY_SCHEDULE;
    this.#systemPrompt = opts.systemPrompt ?? JUDGE_SYSTEM_PROMPT;
  }

  judge(input: JudgeInput): Effect.Effect<JudgeResult, never, never> {
    const model = this.#model;
    const maxTurns = this.#maxTurns;
    const timeoutMs = this.#perAttemptTimeoutMs;
    const schedule = this.#retrySchedule;
    const basePrompt = this.#systemPrompt;
    const rubric = input.target.requirements.judgeRubric;
    const effectivePrompt = rubric !== undefined && rubric.length > 0
      ? `${basePrompt}\n\n${rubric}`
      : basePrompt;

    const loop = Effect.gen(function* () {
      let attempt = 0;
      let lastErr: JudgeAttemptError = new JudgeAttemptError({
        kind: "NoOutput",
        message: "no attempts ran",
      });
      while (attempt <= schedule.length) {
        if (attempt > 0) {
          const delay = schedule[attempt - 1] ?? 0;
          yield* sleepEff(delay);
        }
        const result = yield* runAttempt(
          input,
          effectivePrompt,
          model,
          maxTurns,
          timeoutMs,
          input.abortSignal,
          attempt,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ success: false as const, error }),
            onSuccess: (verdict) => ({ success: true as const, verdict }),
          }),
        );
        if (result.success) return result.verdict;
        lastErr = result.error;
        if (lastErr.kind === "ResultError") {
          return criticalFallback(lastErr, attempt);
        }
        attempt += 1;
      }
      return criticalFallback(lastErr, attempt - 1);
    });
    return loop;
  }
}
