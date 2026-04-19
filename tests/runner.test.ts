import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { SubprocessRunner } from "../src/runner/index.js";
import { ScenarioId, RUNTIME_KIND } from "../src/core/types.js";
import { ERROR_TAG, AGENT_START_CAUSE } from "../src/core/errors.js";
import type { Scenario } from "../src/core/schema.js";
import { itEffect, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";

// ── Test fixture constants (consolidated; referenced across cases) ────────
const NONEXISTENT_BIN = "/tmp/cc-judge-nonexistent-binary-xyz";
const ESCAPE_REL_PATH = "../escape";
const SCENARIO_ID_MY = "my-scenario";
const FILE_A_NAME = "a.txt";
const FILE_B_NAME = "sub/b.txt";
const CONTENT_HELLO = "hello";
const CONTENT_WORLD = "world";

const FLAG_VERBOSE = "--verbose";
const FLAG_DASH_P = "-p";
const FLAG_OUTPUT_FORMAT = "--output-format";
const FLAG_STREAM_JSON = "stream-json";
const FLAG_CUSTOM = "--custom";
const PROMPT_X = "PROMPT-X";
const PROMPT_MY = "MYPROMPT";

const TIMEOUT_SHORT_MS = 50;
const TURN_INDEX_ZERO = 0;
const TURN_COUNT_ZERO = 0;
const TURN_COUNT_ONE = 1;
const TURN_COUNT_TWO = 2;
const TURN_INDEX_ONE = 1;

const RESP_ASSISTANT_HELLO = "hello from agent";
const RESP_FINAL_ANSWER = "final answer";
const RESP_ASSISTANT_WINS = "assistant said this";
const RESP_PLAIN_TEXT = "plain text output";
const RESP_STRUCTURED = "structured";
const RESP_ERROR_OUTPUT = "error output";
const TOOL_CALL_COUNT_TWO = 2;
const TOOL_CALL_COUNT_ZERO = 0;

const USAGE_INPUT_TOKENS_10 = 10;
const USAGE_OUTPUT_TOKENS_5 = 5;
const USAGE_CACHE_READ_3 = 3;
const USAGE_CACHE_CREATE_2 = 2;
const USAGE_SUM_INPUT_13 = 13;
const USAGE_SUM_OUTPUT_7 = 7;
const TOKENS_ZERO = 0;

const CONTENT_NEW = "new content";
const CONTENT_ORIGINAL = "original";
const CONTENT_MODIFIED = "modified";

const CHANGED_EMPTY_LEN = 0;

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: ScenarioId("runner-test"),
    name: "runner-test",
    description: "test scenario",
    setupPrompt: "noop",
    expectedBehavior: "noop",
    validationChecks: [],
    ...overrides,
  };
}

// ------------------------------------------------------------------
// SubprocessRunner.start()
// ------------------------------------------------------------------

describe("SubprocessRunner.start()", () => {
  itEffect("returns AgentStartError{BinaryNotFound} when binary does not exist", function* () {
    const runner = new SubprocessRunner({ bin: NONEXISTENT_BIN });
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentStartError);
      expect(result.left.cause._tag).toBe(AGENT_START_CAUSE.BinaryNotFound);
      expect((result.left.cause as { _tag: "BinaryNotFound"; path: string }).path).toBe(
        NONEXISTENT_BIN,
      );
    }
  });

  itEffect("returns AgentStartError{WorkspacePathEscape} when workspace path escapes root", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({
      // Path escapes root — schema blocks this at decode time; this tests the
      // defense-in-depth path inside makeWorkspace().
      workspace: [{ path: ESCAPE_REL_PATH, content: "bad" }] as Scenario["workspace"],
    });
    const result = yield* Effect.either(runner.start(scenario));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentStartError);
      const cause = result.left.cause;
      expect(cause._tag).toBe(AGENT_START_CAUSE.WorkspacePathEscape);
      if (cause._tag === AGENT_START_CAUSE.WorkspacePathEscape) {
        expect(cause.wfPath).toBe(ESCAPE_REL_PATH);
      }
    }
  });

  itEffect("returns AgentHandle with correct scenarioId and kind on success", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ id: ScenarioId(SCENARIO_ID_MY) });
    const handle = yield* runner.start(scenario);
    expect(handle.kind).toBe(RUNTIME_KIND.Subprocess);
    expect(handle.scenarioId).toBe(SCENARIO_ID_MY);
    expect(handle.workspaceDir.length).toBeGreaterThan(0);
    expect(existsSync(handle.workspaceDir)).toBe(true);
    yield* runner.stop(handle);
  });

  itEffect("snapshots workspace files into initialFiles", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({
      workspace: [
        { path: FILE_A_NAME, content: CONTENT_HELLO },
        { path: FILE_B_NAME, content: CONTENT_WORLD },
      ],
    });
    const handle = yield* runner.start(scenario);
    expect(handle.initialFiles.get(FILE_A_NAME)).toBe(CONTENT_HELLO);
    expect(handle.initialFiles.get(FILE_B_NAME)).toBe(CONTENT_WORLD);
    yield* runner.stop(handle);
  });

  itEffect("starts with turnsExecuted.count === 0", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    expect(handle.turnsExecuted.count).toBe(TURN_COUNT_ZERO);
    yield* runner.stop(handle);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — default args
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() default args", () => {
  itEffect("passes -p, --output-format, stream-json, --verbose, and prompt to binary", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario();
    const handle = yield* runner.start(scenario);
    const turn = yield* runner.turn(handle, PROMPT_X, { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.response).toContain(FLAG_VERBOSE);
    expect(turn.response).toContain(FLAG_DASH_P);
    expect(turn.response).toContain(FLAG_OUTPUT_FORMAT);
    expect(turn.response).toContain(FLAG_STREAM_JSON);
    expect(turn.response).toContain(PROMPT_X);
  });

  itEffect("uses extraArgs instead of defaults when provided", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo", extraArgs: [FLAG_CUSTOM] });
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, PROMPT_MY, { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.response).toContain(FLAG_CUSTOM);
    expect(turn.response).toContain(PROMPT_MY);
    expect(turn.response).not.toContain(FLAG_VERBOSE);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — Turn shape
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() Turn shape", () => {
  itEffect("returns a Turn with index 0 on first call", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    const prompt = "hi";
    const turn = yield* runner.turn(handle, prompt, { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.index).toBe(TURN_INDEX_ZERO);
    expect(turn.prompt).toBe(prompt);
    expect(turn.startedAt).toEqual(expect.any(String));
    expect(turn.latencyMs).toBeGreaterThanOrEqual(0);
  });

  itEffect("increments turnsExecuted.count after each turn", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    expect(handle.turnsExecuted.count).toBe(TURN_COUNT_ZERO);
    yield* runner.turn(handle, "t1", { timeoutMs: 10_000 });
    expect(handle.turnsExecuted.count).toBe(TURN_COUNT_ONE);
    yield* runner.turn(handle, "t2", { timeoutMs: 10_000 });
    expect(handle.turnsExecuted.count).toBe(TURN_COUNT_TWO);
    yield* runner.stop(handle);
  });

  itEffect("second turn has index 1", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    yield* runner.turn(handle, "first", { timeoutMs: 10_000 });
    const t2 = yield* runner.turn(handle, "second", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(t2.index).toBe(TURN_INDEX_ONE);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — timeout + error paths
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() timeout + error paths", () => {
  itEffect("returns AgentRunTimeoutError when process exceeds timeoutMs", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/sleep", extraArgs: [] });
    const handle = yield* runner.start(makeScenario());
    // sleep 60 with 50ms timeout → always times out
    const result = yield* Effect.either(runner.turn(handle, "60", { timeoutMs: TIMEOUT_SHORT_MS }));
    yield* runner.stop(handle);
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentRunTimeoutError);
      expect(result.left.timeoutMs).toBe(TIMEOUT_SHORT_MS);
      expect(result.left.turnIndex).toBe(TURN_INDEX_ZERO);
    }
  });

  itEffect("returns AgentRunTimeoutError on spawn error (non-executable file)", function* () {
    // Create a temp file that exists but is not executable → spawn error event
    const tmpFile = path.join(os.tmpdir(), "cc-judge-notexec-test.txt");
    writeFileSync(tmpFile, "not a binary", { mode: 0o644 });
    // existsSync returns true, so start() succeeds; turn() will get a spawn error.
    const runner = new SubprocessRunner({ bin: tmpFile, extraArgs: [] });
    const handle = yield* runner.start(makeScenario());
    const result = yield* Effect.either(runner.turn(handle, "x", { timeoutMs: 5_000 }));
    yield* runner.stop(handle);
    unlinkSync(tmpFile);
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentRunTimeoutError);
    }
  });

  itEffect("turnsExecuted.count is NOT incremented after a timeout", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/sleep", extraArgs: [] });
    const handle = yield* runner.start(makeScenario());
    yield* Effect.either(runner.turn(handle, "60", { timeoutMs: TIMEOUT_SHORT_MS }));
    yield* runner.stop(handle);
    expect(handle.turnsExecuted.count).toBe(TURN_COUNT_ZERO);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — stream-json parsing
// ------------------------------------------------------------------

// We use node as the subprocess so we can emit precise JSON events to stdout.
// node -e "script" -- "prompt" ignores the prompt arg; the script controls output.
const NODE_BIN = process.execPath;

function nodeScript(script: string): SubprocessRunner {
  return new SubprocessRunner({
    bin: NODE_BIN,
    extraArgs: ["-e", script, "--"],
  });
}

describe("SubprocessRunner.turn() stream-json parsing", () => {
  itEffect("extracts assistant content from 'assistant' event", function* () {
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"assistant",content:"hello from agent"})+"\\n")`,
    );
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.response).toContain(RESP_ASSISTANT_HELLO);
  });

  itEffect("counts tool_use events as toolCallCount", function* () {
    const script = [
      `process.stdout.write(JSON.stringify({type:"tool_use"})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"tool_call"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.toolCallCount).toBe(TOOL_CALL_COUNT_TWO);
  });

  itEffect("uses 'result' field as response when no assistant content precedes it", function* () {
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"result",result:"final answer"})+"\\n")`,
    );
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.response).toBe(RESP_FINAL_ANSWER);
  });

  itEffect("assistant content takes priority over result when both present", function* () {
    const script = [
      `process.stdout.write(JSON.stringify({type:"assistant",content:"assistant said this"})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"result",result:"result said this"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    // result field only fills in when response is empty
    expect(turn.response).toContain(RESP_ASSISTANT_WINS);
  });

  itEffect("extracts token counts from usage object", function* () {
    const usage = {
      input_tokens: USAGE_INPUT_TOKENS_10,
      output_tokens: USAGE_OUTPUT_TOKENS_5,
      cache_read_input_tokens: USAGE_CACHE_READ_3,
      cache_creation_input_tokens: USAGE_CACHE_CREATE_2,
    };
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"system",usage:${JSON.stringify(usage)}})+"\\n")`,
    );
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.inputTokens).toBe(USAGE_INPUT_TOKENS_10);
    expect(turn.outputTokens).toBe(USAGE_OUTPUT_TOKENS_5);
    expect(turn.cacheReadTokens).toBe(USAGE_CACHE_READ_3);
    expect(turn.cacheWriteTokens).toBe(USAGE_CACHE_CREATE_2);
  });

  itEffect("accumulates tokens across multiple usage events", function* () {
    const usage1 = { input_tokens: 10, output_tokens: 5 };
    const usage2 = { input_tokens: 3, output_tokens: 2 };
    const script = [
      `process.stdout.write(JSON.stringify({type:"a",usage:${JSON.stringify(usage1)}})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"b",usage:${JSON.stringify(usage2)}})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.inputTokens).toBe(USAGE_SUM_INPUT_13);
    expect(turn.outputTokens).toBe(USAGE_SUM_OUTPUT_7);
  });

  itEffect("falls back to raw stdout when no JSON lines present", function* () {
    const runner = nodeScript(`process.stdout.write("plain text output\\n")`);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    expect(turn.response).toContain(RESP_PLAIN_TEXT);
    expect(turn.toolCallCount).toBe(TOOL_CALL_COUNT_ZERO);
    expect(turn.inputTokens).toBe(TOKENS_ZERO);
  });

  itEffect("ignores non-JSON lines mixed with JSON lines", function* () {
    const script = [
      `process.stdout.write("not json\\n")`,
      `process.stdout.write(JSON.stringify({type:"assistant",content:"structured"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    // sawStructured=true → uses structured path, response = "structured"
    expect(turn.response).toContain(RESP_STRUCTURED);
  });

  itEffect("uses stderr as fallback response when stdout is empty", function* () {
    const runner = nodeScript(`process.stderr.write("error output\\n")`);
    const handle = yield* runner.start(makeScenario());
    const turn = yield* runner.turn(handle, "x", { timeoutMs: 10_000 });
    yield* runner.stop(handle);
    // stdout empty → response = stderr content
    expect(turn.response).toContain(RESP_ERROR_OUTPUT);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.diff()
// ------------------------------------------------------------------

describe("SubprocessRunner.diff()", () => {
  itEffect("returns empty diff when no files changed", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ workspace: [{ path: "file.txt", content: "unchanged" }] });
    const handle = yield* runner.start(scenario);
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    expect(diff.changed).toHaveLength(CHANGED_EMPTY_LEN);
  });

  itEffect("detects a new file added to workspace", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    const newFileName = "new.txt";
    writeFileSync(path.join(handle.workspaceDir, newFileName), CONTENT_NEW);
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    const entry = diff.changed.find((c) => c.path === newFileName);
    expect(entry).toBeDefined();
    expect(entry?.before).toBeNull();
    expect(entry?.after).toBe(CONTENT_NEW);
  });

  itEffect("detects a modified file in workspace", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ workspace: [{ path: FILE_A_NAME, content: CONTENT_ORIGINAL }] });
    const handle = yield* runner.start(scenario);
    writeFileSync(path.join(handle.workspaceDir, FILE_A_NAME), CONTENT_MODIFIED);
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    const entry = diff.changed.find((c) => c.path === FILE_A_NAME);
    expect(entry).toBeDefined();
    expect(entry?.before).toBe(CONTENT_ORIGINAL);
    expect(entry?.after).toBe(CONTENT_MODIFIED);
  });

  itEffect("detects a deleted file in workspace", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const delFileName = "del.txt";
    const delFileContent = "bye";
    const scenario = makeScenario({ workspace: [{ path: delFileName, content: delFileContent }] });
    const handle = yield* runner.start(scenario);
    unlinkSync(path.join(handle.workspaceDir, delFileName));
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    const entry = diff.changed.find((c) => c.path === delFileName);
    expect(entry).toBeDefined();
    expect(entry?.before).toBe(delFileContent);
    expect(entry?.after).toBeNull();
  });

  itEffect("reports no change for an unchanged file alongside a changed one", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const keepFile = "keep.txt";
    const changeFile = "change.txt";
    const scenario = makeScenario({
      workspace: [
        { path: keepFile, content: "same" },
        { path: changeFile, content: "old" },
      ],
    });
    const handle = yield* runner.start(scenario);
    writeFileSync(path.join(handle.workspaceDir, changeFile), "new");
    const diff = yield* runner.diff(handle);
    yield* runner.stop(handle);
    expect(diff.changed.find((c) => c.path === keepFile)).toBeUndefined();
    expect(diff.changed.find((c) => c.path === changeFile)).toBeDefined();
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.stop()
// ------------------------------------------------------------------

describe("SubprocessRunner.stop()", () => {
  itEffect("removes the workspace directory", function* () {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = yield* runner.start(makeScenario());
    const dir = handle.workspaceDir;
    expect(existsSync(dir)).toBe(true);
    yield* runner.stop(handle);
    expect(existsSync(dir)).toBe(false);
  });

  it("is idempotent — second stop() does not fail", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runner = new SubprocessRunner({ bin: "/bin/echo" });
        const handle = yield* runner.start(makeScenario());
        yield* runner.stop(handle);
        // Directory is gone; second stop() must still succeed (invariant: stop never fails)
        const second = yield* runner.stop(handle);
        expect(second).toBeUndefined();
      }),
    ));
});

// ------------------------------------------------------------------
// Property test: start() never throws — always returns tagged result
// ------------------------------------------------------------------

describe("SubprocessRunner.start() property: never throws", () => {
  // Generates scenarios including deliberately unsafe workspace paths to exercise
  // the WorkspacePathEscape branch, alongside safe paths that succeed.
  const safePathArb = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => !s.includes("/") && !s.includes("\\") && !s.includes("..") && s.trim().length > 0)
    .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, "x") || "file");

  const workspaceArb = fc.option(
    fc.array(
      fc.record({
        path: fc.oneof(
          safePathArb,
          fc.constant("../escape"),
          fc.constant("/abs/path"),
        ),
        content: fc.string(),
      }),
      { maxLength: 4 },
    ),
    { nil: undefined },
  );

  it("for any scenario, start() resolves to a tagged result — never an unhandled exception", () =>
    fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc
            .string({ minLength: 1, maxLength: 50 })
            .filter((s) => s.trim().length > 0)
            .map(ScenarioId),
          name: fc.string({ minLength: 1 }),
          description: fc.string(),
          setupPrompt: fc.string({ minLength: 1 }),
          expectedBehavior: fc.string(),
          validationChecks: fc.array(fc.string({ minLength: 1 })),
          workspace: workspaceArb,
        }),
        (scenario) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const runner = new SubprocessRunner({ bin: "/bin/echo" });
              const result = yield* Effect.either(runner.start(scenario as unknown as Scenario));
              // Must be either Left (AgentStartError) or Right (AgentHandle).
              // The _tag discriminant must be one of the two — never an exception.
              expect([EITHER_LEFT, EITHER_RIGHT]).toContain(result._tag);
              if (result._tag === EITHER_RIGHT) {
                // Clean up the workspace dir
                yield* runner.stop(result.right);
              }
            }),
          ),
      ),
      { numRuns: 30 },
    ));
});
