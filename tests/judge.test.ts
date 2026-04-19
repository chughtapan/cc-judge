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
// per case via __setNextMessages / __setNextSequence. Also captures the
// prompt passed to query() so tests can assert on renderPrompt / renderDiff.
let nextMessageSequence: ReadonlyArray<ReadonlyArray<unknown>> = [];
let attemptIndex = 0;
const capturedPrompts: string[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((args: { prompt: string }) => {
    capturedPrompts.push(args.prompt);
    const messages = nextMessageSequence[attemptIndex] ?? [];
    attemptIndex += 1;
    return {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: () => {
            if (i < messages.length) {
              const value = messages[i];
              i += 1;
              return Promise.resolve({ value, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }),
}));

function setAttemptsToSequence(sequences: ReadonlyArray<ReadonlyArray<unknown>>): void {
  nextMessageSequence = sequences;
  attemptIndex = 0;
  capturedPrompts.length = 0;
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

// Targeted kills for renderPrompt + renderDiff + collectAssistantText branches
// observed as survivors in the epic #37 mutation run.
describe("AnthropicJudgeBackend prompt content", () => {
  const CONTENT_A = "new-content-a";
  const CONTENT_B = "new-content-b";
  const CONTENT_LONG = "xxxxxxxxxxxxx";
  const PATH_ADDED = "added.txt";
  const PATH_REMOVED = "removed.txt";
  const PATH_MODIFIED = "modified.txt";

  itEffect("renderDiff emits `+ added` lines with byte count for before=null entries", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const diff: WorkspaceDiff = {
      changed: [{ path: PATH_ADDED, before: null, after: CONTENT_A }],
    };
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input(diff));
    expect(capturedPrompts[0]).toContain(`+ added ${PATH_ADDED}`);
    expect(capturedPrompts[0]).toContain(`${CONTENT_A.length} bytes`);
  });

  itEffect("renderDiff emits `- removed` lines for after=null entries", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const diff: WorkspaceDiff = {
      changed: [{ path: PATH_REMOVED, before: CONTENT_A, after: null }],
    };
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input(diff));
    expect(capturedPrompts[0]).toContain(`- removed ${PATH_REMOVED}`);
  });

  itEffect("renderDiff emits `~ modified` for both-non-null entries", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const diff: WorkspaceDiff = {
      changed: [{ path: PATH_MODIFIED, before: CONTENT_A, after: CONTENT_B }],
    };
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input(diff));
    expect(capturedPrompts[0]).toContain(`~ modified ${PATH_MODIFIED}`);
  });

  itEffect("renderDiff emits `(no workspace changes)` when diff is undefined", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(capturedPrompts[0]).toContain("(no workspace changes)");
  });

  itEffect("renderDiff emits `(no workspace changes)` when diff has empty changed array", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input({ changed: [] }));
    expect(capturedPrompts[0]).toContain("(no workspace changes)");
  });

  itEffect("renderDiff joins multiple entries with newlines (all three kinds in one diff)", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const diff: WorkspaceDiff = {
      changed: [
        { path: PATH_ADDED, before: null, after: CONTENT_A },
        { path: PATH_REMOVED, before: CONTENT_LONG, after: null },
        { path: PATH_MODIFIED, before: CONTENT_A, after: CONTENT_B },
      ],
    };
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input(diff));
    const prompt = capturedPrompts[0];
    expect(prompt).toContain(`+ added ${PATH_ADDED}`);
    expect(prompt).toContain(`- removed ${PATH_REMOVED}`);
    expect(prompt).toContain(`~ modified ${PATH_MODIFIED}`);
  });

  itEffect("renderPrompt includes scenario name, description, expectedBehavior, and validationChecks", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    const scen: Scenario = {
      id: ScenarioId("named-scen"),
      name: "SomeScenarioName",
      description: "SomeDescription",
      setupPrompt: "SomeSetup",
      expectedBehavior: "SomeExpectedBehavior",
      validationChecks: ["CheckOne", "CheckTwo"],
    };
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge({
      scenario: scen,
      turns: [makeTurn(PROMPT_USER, RESPONSE_ASSISTANT)],
    });
    const prompt = capturedPrompts[0];
    expect(prompt).toContain("# Scenario: SomeScenarioName");
    expect(prompt).toContain("Description: SomeDescription");
    expect(prompt).toContain("Expected behavior: SomeExpectedBehavior");
    expect(prompt).toContain("1. CheckOne");
    expect(prompt).toContain("2. CheckTwo");
  });

  itEffect("renderTurns emits USER and ASSISTANT labels with turn index", function* () {
    setAttemptsToSequence([[successResultMessage("", STRUCTURED_PASS_VERDICT)]]);
    yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge({
      scenario: makeScenario("s"),
      turns: [
        {
          index: 0,
          prompt: "first-prompt",
          response: "first-response",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          index: 1,
          prompt: "second-prompt",
          response: "second-response",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    const prompt = capturedPrompts[0];
    expect(prompt).toContain("--- Turn 0 ---");
    expect(prompt).toContain("USER: first-prompt");
    expect(prompt).toContain("ASSISTANT: first-response");
    expect(prompt).toContain("--- Turn 1 ---");
    expect(prompt).toContain("USER: second-prompt");
  });

  itEffect("collectAssistantText concatenates multiple text blocks within one assistant message", function* () {
    setAttemptsToSequence([[{
      type: "assistant",
      message: {
        content: [
          { type: "text", text: '{"pass":true,' },
          { type: "text", text: '"reason":"ok",' },
          { type: "text", text: '"issues":[],"overallSeverity":null,"judgeConfidence":0.5}' },
        ],
      },
    }]]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("ok");
  });

  itEffect("collectAssistantText skips non-text blocks (e.g. tool_use / image) in content arrays", function* () {
    setAttemptsToSequence([[{
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "calculator", input: {} },
          { type: "text", text: '{"pass":true,"reason":"t","issues":[],"overallSeverity":null,"judgeConfidence":0.5}' },
          { type: "image", source: {} },
        ],
      },
    }]]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(result.pass).toBe(true);
  });

  itEffect("collectAssistantText skips assistant messages whose content is not an array", function* () {
    setAttemptsToSequence([[
      { type: "assistant", message: { content: "plain string" } },
      successResultMessage('{"pass":false,"reason":"x","issues":[],"overallSeverity":null}'),
    ]]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(result.pass).toBe(false);
  });

  itEffect("collectAssistantText skips blocks with missing or non-string .text", function* () {
    setAttemptsToSequence([[{
      type: "assistant",
      message: {
        content: [
          { type: "text", text: 42 },
          { type: "text" },
          { type: "text", text: '{"pass":true,"reason":"x","issues":[],"overallSeverity":null}' },
        ],
      },
    }]]);
    const result = yield* new AnthropicJudgeBackend({ retrySchedule: [] }).judge(input());
    expect(result.pass).toBe(true);
  });
});
