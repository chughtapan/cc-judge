// Pure helpers extracted from judge/index.ts for direct testing.
//
// Two reasons to keep these here rather than as @internal exports on
// the main module:
// 1. Test files don't have to thread `@internal` through application
//    code; the helper module IS the public surface for tests.
// 2. The helpers compose without the JudgeBackend / SDK / retry
//    machinery — they're shape-only transforms over the existing core
//    types. Co-locating them with that domain logic obscures their
//    purity.

import {
  type AgentRef,
  type AgentTurn,
  type Issue,
  type IssueSeverity,
  type JudgmentBundle,
  type TraceEvent,
  type Turn,
  type WorkspaceDiff,
  type WorkspaceFileChange,
} from "../core/types.js";

// ── workspace diff ──────────────────────────────────────────────────────────

export const PROMPT_NO_DIFF = "(no workspace changes)";
export const DIFF_PREFIX = {
  Added: "+ added",
  Removed: "- removed",
  Modified: "~ modified",
} as const;

function renderChange(c: WorkspaceFileChange): string {
  if (c.before === null && c.after !== null) {
    return `${DIFF_PREFIX.Added} ${c.path} (${c.after.length} bytes)`;
  }
  if (c.before !== null && c.after === null) {
    return `${DIFF_PREFIX.Removed} ${c.path}`;
  }
  return `${DIFF_PREFIX.Modified} ${c.path}`;
}

export function renderDiff(diff: WorkspaceDiff | undefined): string {
  const changes = diff?.changed ?? [];
  if (changes.length === 0) return PROMPT_NO_DIFF;
  return changes.map(renderChange).join("\n");
}

// ── turns ───────────────────────────────────────────────────────────────────

export const TURN_LABEL = {
  User: "USER",
  Assistant: "ASSISTANT",
} as const;

export function turnHeader(index: number): string {
  return `--- Turn ${index} ---`;
}

export function renderTurns(turns: ReadonlyArray<Turn>): string {
  return turns
    .flatMap((t) => [
      turnHeader(t.index),
      `${TURN_LABEL.User}: ${t.prompt}`,
      `${TURN_LABEL.Assistant}: ${t.response}`,
    ])
    .join("\n");
}

// ── events ──────────────────────────────────────────────────────────────────

export const EVENT_PREFIX = {
  Phase: "PHASE:",
  Action: "ACTION:",
  State: "STATE:",
  MessageArrow: " -> ",
} as const;

function isoTs(ts: number): string {
  return new Date(ts).toISOString();
}

function renderEvent(e: TraceEvent): string {
  const ts = isoTs(e.ts);
  switch (e.type) {
    case "message": {
      const target = e.to !== undefined ? `${EVENT_PREFIX.MessageArrow}${e.to}` : "";
      return `[${ts}] [${e.channel}] ${e.from}${target}: ${e.text}`;
    }
    case "phase": {
      const round = e.round !== undefined ? ` (round ${e.round})` : "";
      return `[${ts}] ${EVENT_PREFIX.Phase} ${e.phase}${round}`;
    }
    case "action":
      return `[${ts}] [${e.channel}] ${e.agent} ${EVENT_PREFIX.Action} ${e.action}`;
    case "state":
      return `[${ts}] ${EVENT_PREFIX.State} ${JSON.stringify(e.snapshot)}`;
  }
}

export function renderEvents(events: ReadonlyArray<TraceEvent>): string {
  return events.map(renderEvent).join("\n");
}

// ── agents ──────────────────────────────────────────────────────────────────

function renderAgentLine(a: AgentRef): string {
  const role = a.role !== undefined ? ` role=${a.role}` : "";
  return `- ${a.name} (${a.id})${role}`;
}

export function renderAgents(agents: ReadonlyArray<AgentRef>): string {
  return agents.map(renderAgentLine).join("\n");
}

// ── bundle → events ─────────────────────────────────────────────────────────

export const DEFAULT_AGENT_NAME = "assistant";
export const PROMPT_CHANNEL = "prompt";
export const RESPONSE_CHANNEL = "response";
export const USER_FROM = "user";

function safeTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function turnEntryToEvents(
  entry: AgentTurn,
  agentNameById: ReadonlyMap<string, string>,
): ReadonlyArray<TraceEvent> {
  const promptTs = safeTimestamp(entry.turn.startedAt);
  const agentId = entry.agentId;
  const agentName = agentId !== undefined
    ? (agentNameById.get(agentId) ?? agentId)
    : DEFAULT_AGENT_NAME;
  return [
    {
      type: "message",
      from: USER_FROM,
      to: agentName,
      channel: PROMPT_CHANNEL,
      text: entry.turn.prompt,
      ts: promptTs,
    },
    {
      type: "message",
      from: agentName,
      channel: RESPONSE_CHANNEL,
      text: entry.turn.response,
      ts: promptTs + entry.turn.latencyMs,
    },
  ];
}

export function bundleTurnsToEvents(
  bundle: JudgmentBundle,
): ReadonlyArray<TraceEvent> | undefined {
  if (bundle.events !== undefined && bundle.events.length > 0) {
    return bundle.events;
  }
  const turns = bundle.turns ?? [];
  if (turns.length === 0) return undefined;
  const agentNameById = new Map(bundle.agents.map((a) => [a.id, a.name]));
  return turns.flatMap((entry) => turnEntryToEvents(entry, agentNameById));
}

// ── judge response parsing ──────────────────────────────────────────────────

const FENCE_START = /^```(?:json)?\s*/u;
const FENCE_END = /\s*```\s*$/u;

/**
 * Strip a leading `\`\`\`json` / `\`\`\`` fence and a matching trailing
 * fence from text the model produced. Never tries to repair the JSON
 * body itself; bad JSON downstream is the caller's problem.
 */
export function extractJsonText(text: string): string {
  return text.trim().replace(FENCE_START, "").replace(FENCE_END, "").trim();
}

// ── verdict coercion ────────────────────────────────────────────────────────

const VALID_SEVERITIES: ReadonlyArray<IssueSeverity> = ["minor", "significant", "critical"];

export function coerceSeverity(v: unknown): IssueSeverity | null {
  return typeof v === "string" && (VALID_SEVERITIES as ReadonlyArray<string>).includes(v)
    ? (v as IssueSeverity)
    : null;
}

interface RawIssueEntry {
  readonly issue?: unknown;
  readonly severity?: unknown;
}

function coerceIssue(entry: unknown): Issue | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as RawIssueEntry;
  if (typeof e.issue !== "string") return null;
  const severity = coerceSeverity(e.severity);
  if (severity === null) return null;
  return { issue: e.issue, severity };
}

export function coerceIssues(v: unknown): ReadonlyArray<Issue> {
  if (!Array.isArray(v)) return [];
  const out: Issue[] = [];
  for (const entry of v) {
    const issue = coerceIssue(entry);
    if (issue !== null) out.push(issue);
  }
  return out;
}

/**
 * Clamp a confidence value to [0, 1]. Returns undefined for non-numeric
 * or NaN inputs so the caller can decide how to render "no confidence
 * provided" vs "model said 0".
 */
export function coerceConfidence(v: unknown): number | undefined {
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  return Math.max(0, Math.min(1, v));
}
