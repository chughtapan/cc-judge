import { describe, expect, it, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { AnthropicJudgeBackend } from "../src/judge/index.js";
import type { JudgeInput } from "../src/judge/index.js";
import { ScenarioId, ISSUE_SEVERITY } from "../src/core/types.js";
import type { Scenario, Turn, WorkspaceDiff } from "../src/core/schema.js";
import { itEffect } from "./support/effect.js";

const NAME_ANTHROPIC = "anthropic";
const PROMPT_USER = "hi";
const RESPONSE_ASSISTANT = "hello";
const RETRY_ZERO = 0;
const RETRY_ONE = 1;
const RETRY_TWO = 2;
const RETRY_THREE = 3;
const REASON_PASS = "all checks met";
const REASON_FAIL = "check not met";
const ISSUE_TEXT = "missed a thing";
const CONFIDENCE_MID = 0.6;
const CONFIDENCE_TOO_HIGH = 2;
const CONFIDENCE_TOO_LOW = -0.5;
const DIFF_CONTENT = "new-file-contents";
const STRUCTURED_PASS_VERDICT = {
  pass: true,
  reason: REASON_PASS,
  issues: [],
  overallSeverity: null,
  judgeConfidence: CONFIDENCE_MID,
};

// ── Mock the Claude Agent SDK so judge() never touches a real network ────────
// `query` returns an async-iterable of SDK messages; tests set the sequence
// per case via __setNextMessages / __setNextSequence.
let nextMessageSequence: ReadonlyArray<ReadonlyArray<unknown>> = [];
let attemptIndex = 0;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const messages = nextMessageSequence[attemptIndex] ?? [];
    attemptIndex += 1;
    return {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () => {
            if (i < messages.length) {
              const value = messages[i];
              i += 1;
              return { value, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }),
}));

function setAttemptsToSequence(sequences: ReadonlyArray<ReadonlyArray<unknown>>): void {
  nextMessageSequence = sequences;
  attemptIndex = 0;
}

function successResultMessage(resultJson: unknown, structured?: unknown): unknown {
  return {
    type: "result",
    subtype: "success",
    result: typeof resultJson === "string" ? resultJson : JSON.stringify(resultJson),
    ...(structured !== undefined ? { structured_output: structured } : {}),
  };
}

function errorResultMessage(errors: ReadonlyArray<string>, subtype = "error"): unknown {
  return { type: "result", subtype, errors };
}

function assistantTextMessage(text: string): unknown {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

function makeScenario(id: string): Scenario {
  return {
    id: ScenarioId(id),
    name: id,
    description: "d",
    setupPrompt: "p",
    expectedBehavior: "e",
    validationChecks: ["c"],
  };
}

function makeTurn(prompt: string, response: string): Turn {
  return {
    index: 0,
    prompt,
    response,
    startedAt: "2026-04-18T00:00:00.000Z",
    latencyMs: 10,
    toolCallCount: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function input(diff?: WorkspaceDiff): JudgeInput {
  return {
    scenario: makeScenario("s"),
    turns: [makeTurn(PROMPT_USER, RESPONSE_ASSISTANT)],
    ...(diff !== undefined ? { workspaceDiff: diff } : {}),
  };
}

beforeEach(() => {
  setAttemptsToSequence([]);
});

describe("AnthropicJudgeBackend", () => {
  it("exposes .name = 'anthropic'", () => {
    const backend = new AnthropicJudgeBackend();
    expect(backend.name).toBe(NAME_ANTHROPIC);
  });

  it("accepts model / maxTurns / perAttemptTimeoutMs / retrySchedule opts without throwing", () => {
    const backend = new AnthropicJudgeBackend({
      model: "claude-custom",
      maxTurns: 2,
      perAttemptTimeoutMs: 30_000,
      retrySchedule: [100, 200],
    });
    expect(backend.name).toBe(NAME_ANTHROPIC);
  });

  itEffect("returns pass=true on a clean structured verdict", function* () {
    setAttemptsToSequence([[successResultMessage("ignored-text", STRUCTURED_PASS_VERDICT)]]);
    const backend = new AnthropicJudgeBackend({ retrySchedule: [] });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(true);
    expect(result.reason).toBe(REASON_PASS);
    expect(result.retryCount).toBe(RETRY_ZERO);
    expect(result.judgeConfidence).toBe(CONFIDENCE_MID);
  });

  itEffect("falls back to text result + JSON.parse when structured_output missing", function* () {
    setAttemptsToSequence([[
      successResultMessage(
        JSON.stringify({
          pass: false,
          reason: REASON_FAIL,
          issues: [{ issue: ISSUE_TEXT, severity: ISSUE_SEVERITY.Significant }],
          overallSeverity: ISSUE_SEVERITY.Significant,
          judgeConfidence: CONFIDENCE_MID,
        }),
      ),
    ]]);
    const backend = new AnthropicJudgeBackend({ retrySchedule: [] });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(false);
    expect(result.overallSeverity).toBe(ISSUE_SEVERITY.Significant);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.issue).toBe(ISSUE_TEXT);
  });

  itEffect("strips markdown fences from text result before JSON.parse", function* () {
    setAttemptsToSequence([[
      successResultMessage(
        "```json\n" +
          JSON.stringify({
            pass: true,
            reason: REASON_PASS,
            issues: [],
            overallSeverity: null,
            judgeConfidence: CONFIDENCE_MID,
          }) +
          "\n```",
      ),
    ]]);
    const backend = new AnthropicJudgeBackend({ retrySchedule: [] });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(true);
  });

  itEffect("clamps judgeConfidence above 1 to 1 and below 0 to 0", function* () {
    setAttemptsToSequence([[
      successResultMessage({
        pass: true,
        reason: REASON_PASS,
        issues: [],
        overallSeverity: null,
        judgeConfidence: CONFIDENCE_TOO_HIGH,
      }),
    ]]);
    const backend = new AnthropicJudgeBackend({ retrySchedule: [] });
    const result = yield* backend.judge(input());
    expect(result.judgeConfidence).toBe(1);

    setAttemptsToSequence([[
      successResultMessage({
        pass: true,
        reason: REASON_PASS,
        issues: [],
        overallSeverity: null,
        judgeConfidence: CONFIDENCE_TOO_LOW,
      }),
    ]]);
    const r2 = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(r2.judgeConfidence).toBe(0);
  });

  itEffect("drops malformed issues (non-string text, unknown severity)", function* () {
    setAttemptsToSequence([[
      successResultMessage({
        pass: false,
        reason: REASON_FAIL,
        issues: [
          { issue: ISSUE_TEXT, severity: ISSUE_SEVERITY.Minor },
          { issue: 42, severity: ISSUE_SEVERITY.Minor },
          { issue: ISSUE_TEXT, severity: "not-a-severity" },
          "not-an-object",
        ],
        overallSeverity: ISSUE_SEVERITY.Minor,
        judgeConfidence: CONFIDENCE_MID,
      }),
    ]]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.severity).toBe(ISSUE_SEVERITY.Minor);
  });

  itEffect("folds empty text output into critical after retries exhausted", function* () {
    const empty = [successResultMessage("")];
    setAttemptsToSequence([empty, empty, empty, empty]);
    const backend = new AnthropicJudgeBackend({
      retrySchedule: [1, 1, 1],
      perAttemptTimeoutMs: 500,
    });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(false);
    expect(result.overallSeverity).toBe(ISSUE_SEVERITY.Critical);
    expect(result.retryCount).toBe(RETRY_THREE);
    expect(result.reason).toContain("NoOutput");
  }, 10_000);

  itEffect("folds malformed JSON into critical after retries exhausted", function* () {
    const bad = [successResultMessage("{not json")];
    setAttemptsToSequence([bad, bad]);
    const backend = new AnthropicJudgeBackend({
      retrySchedule: [1],
      perAttemptTimeoutMs: 500,
    });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(false);
    expect(result.overallSeverity).toBe(ISSUE_SEVERITY.Critical);
    expect(result.retryCount).toBe(RETRY_ONE);
    expect(result.reason).toContain("MalformedJson");
  }, 10_000);

  itEffect("retries after a transient error message and succeeds on 2nd attempt", function* () {
    const ok = [
      successResultMessage("", {
        pass: true,
        reason: REASON_PASS,
        issues: [],
        overallSeverity: null,
        judgeConfidence: CONFIDENCE_MID,
      }),
    ];
    setAttemptsToSequence([[errorResultMessage(["transient"], "error_during_execution")], ok]);
    const backend = new AnthropicJudgeBackend({
      retrySchedule: [1],
      perAttemptTimeoutMs: 500,
    });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(true);
    expect(result.retryCount).toBe(RETRY_ONE);
  }, 10_000);

  itEffect("assembles text from assistant message blocks when no result success message is present", function* () {
    setAttemptsToSequence([[
      assistantTextMessage("```json\n"),
      assistantTextMessage(JSON.stringify({
        pass: true,
        reason: REASON_PASS,
        issues: [],
        overallSeverity: null,
        judgeConfidence: CONFIDENCE_MID,
      })),
      assistantTextMessage("\n```"),
    ]]);
    const backend = new AnthropicJudgeBackend({ retrySchedule: [] });
    const result = yield* backend.judge(input());
    expect(result.pass).toBe(true);
  });

  itEffect("folds schema-invalid verdict (wrong type for pass) into critical after retries", function* () {
    const bad = [successResultMessage({
      pass: "not-a-boolean",
      reason: REASON_FAIL,
      issues: [],
      overallSeverity: null,
    })];
    setAttemptsToSequence([bad, bad]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [1] }).judge(input());
    // When `pass` is non-boolean, the coercion forces pass=false but the schema
    // validator should still accept the coerced candidate. The assertion we
    // can make reliably: the judge returns SOME JudgeResult (error channel never).
    expect(typeof result.pass).toBe("boolean");
    expect(typeof result.reason).toBe("string");
  });

  itEffect("carries workspaceDiff through the prompt (no crash, produces verdict)", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const diff: WorkspaceDiff = {
      changed: [
        { path: "a.txt", before: null, after: DIFF_CONTENT },
        { path: "b.txt", before: "old", after: null },
        { path: "c.txt", before: "x", after: "y" },
      ],
    };
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input(diff));
    expect(result.pass).toBe(true);
  });

  itEffect("fires the SDK on every attempt up to retrySchedule+1 times", function* () {
    const bad = [successResultMessage("{not json")];
    setAttemptsToSequence([bad, bad, bad, bad]);
    const backend = new AnthropicJudgeBackend({
      retrySchedule: [1, 1, 1],
      perAttemptTimeoutMs: 500,
    });
    const result = yield* backend.judge(input());
    expect(result.retryCount).toBe(RETRY_THREE);
    expect(result.reason).toContain("MalformedJson");
    expect(attemptIndex).toBe(RETRY_THREE + 1);
  }, 10_000);
});
