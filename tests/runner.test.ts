import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { existsSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { SubprocessRunner } from "../src/runner/index.js";
import { ScenarioId } from "../src/core/types.js";
import type { Scenario } from "../src/core/schema.js";

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
  it("returns AgentStartError{BinaryNotFound} when binary does not exist", async () => {
    const runner = new SubprocessRunner({ bin: "/tmp/cc-judge-nonexistent-binary-xyz" });
    const result = await Effect.runPromise(Effect.either(runner.start(makeScenario())));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentStartError");
      expect(result.left.cause._tag).toBe("BinaryNotFound");
      expect((result.left.cause as { _tag: "BinaryNotFound"; path: string }).path).toBe(
        "/tmp/cc-judge-nonexistent-binary-xyz",
      );
    }
  });

  it("returns AgentStartError{WorkspacePathEscape} when workspace path escapes root", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const escapeRelPath = "../escape";
    const scenario = makeScenario({
      // Path escapes root — schema blocks this at decode time; this tests the
      // defense-in-depth path inside makeWorkspace().
      workspace: [{ path: escapeRelPath, content: "bad" }] as Scenario["workspace"],
    });
    const result = await Effect.runPromise(Effect.either(runner.start(scenario)));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentStartError");
      const cause = result.left.cause;
      expect(cause._tag).toBe("WorkspacePathEscape");
      if (cause._tag === "WorkspacePathEscape") {
        expect(cause.wfPath).toBe(escapeRelPath);
      }
    }
  });

  it("returns AgentHandle with correct scenarioId and kind on success", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ id: ScenarioId("my-scenario") });
    const handle = await Effect.runPromise(runner.start(scenario));
    expect(handle.kind).toBe("subprocess");
    expect(handle.scenarioId).toBe("my-scenario");
    expect(handle.workspaceDir.length).toBeGreaterThan(0);
    expect(existsSync(handle.workspaceDir)).toBe(true);
    await Effect.runPromise(runner.stop(handle));
  });

  it("snapshots workspace files into initialFiles", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({
      workspace: [
        { path: "a.txt", content: "hello" },
        { path: "sub/b.txt", content: "world" },
      ],
    });
    const handle = await Effect.runPromise(runner.start(scenario));
    expect(handle.initialFiles.get("a.txt")).toBe("hello");
    expect(handle.initialFiles.get("sub/b.txt")).toBe("world");
    await Effect.runPromise(runner.stop(handle));
  });

  it("starts with turnsExecuted.count === 0", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    expect(handle.turnsExecuted.count).toBe(0);
    await Effect.runPromise(runner.stop(handle));
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — default args
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() default args", () => {
  it("passes -p, --output-format, stream-json, --verbose, and prompt to binary", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario();
    const handle = await Effect.runPromise(runner.start(scenario));
    const turn = await Effect.runPromise(runner.turn(handle, "PROMPT-X", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toContain("--verbose");
    expect(turn.response).toContain("-p");
    expect(turn.response).toContain("--output-format");
    expect(turn.response).toContain("stream-json");
    expect(turn.response).toContain("PROMPT-X");
  });

  it("uses extraArgs instead of defaults when provided", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo", extraArgs: ["--custom"] });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "MYPROMPT", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toContain("--custom");
    expect(turn.response).toContain("MYPROMPT");
    expect(turn.response).not.toContain("--verbose");
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — Turn shape
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() Turn shape", () => {
  it("returns a Turn with index 0 on first call", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "hi", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.index).toBe(0);
    expect(turn.prompt).toBe("hi");
    expect(typeof turn.startedAt).toBe("string");
    expect(turn.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("increments turnsExecuted.count after each turn", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    expect(handle.turnsExecuted.count).toBe(0);
    await Effect.runPromise(runner.turn(handle, "t1", { timeoutMs: 10_000 }));
    expect(handle.turnsExecuted.count).toBe(1);
    await Effect.runPromise(runner.turn(handle, "t2", { timeoutMs: 10_000 }));
    expect(handle.turnsExecuted.count).toBe(2);
    await Effect.runPromise(runner.stop(handle));
  });

  it("second turn has index 1", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    await Effect.runPromise(runner.turn(handle, "first", { timeoutMs: 10_000 }));
    const t2 = await Effect.runPromise(runner.turn(handle, "second", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(t2.index).toBe(1);
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.turn() — timeout + error paths
// ------------------------------------------------------------------

describe("SubprocessRunner.turn() timeout + error paths", () => {
  it("returns AgentRunTimeoutError when process exceeds timeoutMs", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/sleep", extraArgs: [] });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    // sleep 60 with 50ms timeout → always times out
    const result = await Effect.runPromise(
      Effect.either(runner.turn(handle, "60", { timeoutMs: 50 })),
    );
    await Effect.runPromise(runner.stop(handle));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentRunTimeoutError");
      expect(result.left.timeoutMs).toBe(50);
      expect(result.left.turnIndex).toBe(0);
    }
  });

  it("returns AgentRunTimeoutError on spawn error (non-executable file)", async () => {
    // Create a temp file that exists but is not executable → spawn error event
    const tmpFile = path.join(os.tmpdir(), "cc-judge-notexec-test.txt");
    writeFileSync(tmpFile, "not a binary", { mode: 0o644 });
    // existsSync returns true, so start() succeeds; turn() will get a spawn error.
    const runner = new SubprocessRunner({ bin: tmpFile, extraArgs: [] });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const result = await Effect.runPromise(
      Effect.either(runner.turn(handle, "x", { timeoutMs: 5_000 })),
    );
    await Effect.runPromise(runner.stop(handle));
    unlinkSync(tmpFile);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentRunTimeoutError");
    }
  });

  it("turnsExecuted.count is NOT incremented after a timeout", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/sleep", extraArgs: [] });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    await Effect.runPromise(Effect.either(runner.turn(handle, "60", { timeoutMs: 50 })));
    await Effect.runPromise(runner.stop(handle));
    expect(handle.turnsExecuted.count).toBe(0);
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
  it("extracts assistant content from 'assistant' event", async () => {
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"assistant",content:"hello from agent"})+"\\n")`,
    );
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toContain("hello from agent");
  });

  it("counts tool_use events as toolCallCount", async () => {
    const script = [
      `process.stdout.write(JSON.stringify({type:"tool_use"})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"tool_call"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.toolCallCount).toBe(2);
  });

  it("uses 'result' field as response when no assistant content precedes it", async () => {
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"result",result:"final answer"})+"\\n")`,
    );
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toBe("final answer");
  });

  it("assistant content takes priority over result when both present", async () => {
    const script = [
      `process.stdout.write(JSON.stringify({type:"assistant",content:"assistant said this"})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"result",result:"result said this"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    // result field only fills in when response is empty
    expect(turn.response).toContain("assistant said this");
  });

  it("extracts token counts from usage object", async () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    };
    const runner = nodeScript(
      `process.stdout.write(JSON.stringify({type:"system",usage:${JSON.stringify(usage)}})+"\\n")`,
    );
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.inputTokens).toBe(10);
    expect(turn.outputTokens).toBe(5);
    expect(turn.cacheReadTokens).toBe(3);
    expect(turn.cacheWriteTokens).toBe(2);
  });

  it("accumulates tokens across multiple usage events", async () => {
    const usage1 = { input_tokens: 10, output_tokens: 5 };
    const usage2 = { input_tokens: 3, output_tokens: 2 };
    const script = [
      `process.stdout.write(JSON.stringify({type:"a",usage:${JSON.stringify(usage1)}})+"\\n")`,
      `process.stdout.write(JSON.stringify({type:"b",usage:${JSON.stringify(usage2)}})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.inputTokens).toBe(13);
    expect(turn.outputTokens).toBe(7);
  });

  it("falls back to raw stdout when no JSON lines present", async () => {
    const runner = nodeScript(`process.stdout.write("plain text output\\n")`);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    expect(turn.response).toContain("plain text output");
    expect(turn.toolCallCount).toBe(0);
    expect(turn.inputTokens).toBe(0);
  });

  it("ignores non-JSON lines mixed with JSON lines", async () => {
    const script = [
      `process.stdout.write("not json\\n")`,
      `process.stdout.write(JSON.stringify({type:"assistant",content:"structured"})+"\\n")`,
    ].join(";");
    const runner = nodeScript(script);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    // sawStructured=true → uses structured path, response = "structured"
    expect(turn.response).toContain("structured");
  });

  it("uses stderr as fallback response when stdout is empty", async () => {
    const runner = nodeScript(`process.stderr.write("error output\\n")`);
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const turn = await Effect.runPromise(runner.turn(handle, "x", { timeoutMs: 10_000 }));
    await Effect.runPromise(runner.stop(handle));
    // stdout empty → response = stderr content
    expect(turn.response).toContain("error output");
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.diff()
// ------------------------------------------------------------------

describe("SubprocessRunner.diff()", () => {
  it("returns empty diff when no files changed", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ workspace: [{ path: "file.txt", content: "unchanged" }] });
    const handle = await Effect.runPromise(runner.start(scenario));
    const diff = await Effect.runPromise(runner.diff(handle));
    await Effect.runPromise(runner.stop(handle));
    expect(diff.changed).toHaveLength(0);
  });

  it("detects a new file added to workspace", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    writeFileSync(path.join(handle.workspaceDir, "new.txt"), "new content");
    const diff = await Effect.runPromise(runner.diff(handle));
    await Effect.runPromise(runner.stop(handle));
    const entry = diff.changed.find((c) => c.path === "new.txt");
    expect(entry).toBeDefined();
    expect(entry?.before).toBeNull();
    expect(entry?.after).toBe("new content");
  });

  it("detects a modified file in workspace", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ workspace: [{ path: "a.txt", content: "original" }] });
    const handle = await Effect.runPromise(runner.start(scenario));
    writeFileSync(path.join(handle.workspaceDir, "a.txt"), "modified");
    const diff = await Effect.runPromise(runner.diff(handle));
    await Effect.runPromise(runner.stop(handle));
    const entry = diff.changed.find((c) => c.path === "a.txt");
    expect(entry).toBeDefined();
    expect(entry?.before).toBe("original");
    expect(entry?.after).toBe("modified");
  });

  it("detects a deleted file in workspace", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({ workspace: [{ path: "del.txt", content: "bye" }] });
    const handle = await Effect.runPromise(runner.start(scenario));
    unlinkSync(path.join(handle.workspaceDir, "del.txt"));
    const diff = await Effect.runPromise(runner.diff(handle));
    await Effect.runPromise(runner.stop(handle));
    const entry = diff.changed.find((c) => c.path === "del.txt");
    expect(entry).toBeDefined();
    expect(entry?.before).toBe("bye");
    expect(entry?.after).toBeNull();
  });

  it("reports no change for an unchanged file alongside a changed one", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const scenario = makeScenario({
      workspace: [
        { path: "keep.txt", content: "same" },
        { path: "change.txt", content: "old" },
      ],
    });
    const handle = await Effect.runPromise(runner.start(scenario));
    writeFileSync(path.join(handle.workspaceDir, "change.txt"), "new");
    const diff = await Effect.runPromise(runner.diff(handle));
    await Effect.runPromise(runner.stop(handle));
    expect(diff.changed.find((c) => c.path === "keep.txt")).toBeUndefined();
    expect(diff.changed.find((c) => c.path === "change.txt")).toBeDefined();
  });
});

// ------------------------------------------------------------------
// SubprocessRunner.stop()
// ------------------------------------------------------------------

describe("SubprocessRunner.stop()", () => {
  it("removes the workspace directory", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    const dir = handle.workspaceDir;
    expect(existsSync(dir)).toBe(true);
    await Effect.runPromise(runner.stop(handle));
    expect(existsSync(dir)).toBe(false);
  });

  it("is idempotent — second stop() does not fail", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    const handle = await Effect.runPromise(runner.start(makeScenario()));
    await Effect.runPromise(runner.stop(handle));
    // Directory is gone; second stop() must still succeed (invariant: stop never fails)
    await expect(Effect.runPromise(runner.stop(handle))).resolves.toBeUndefined();
  });
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

  it("for any scenario, start() resolves to a tagged result — never an unhandled exception", async () => {
    const runner = new SubprocessRunner({ bin: "/bin/echo" });
    await fc.assert(
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
        async (scenario) => {
          const result = await Effect.runPromise(
            Effect.either(runner.start(scenario as unknown as Scenario)),
          );
          // Must be either Left (AgentStartError) or Right (AgentHandle).
          // The _tag discriminant must be one of the two — never an exception.
          expect(["Left", "Right"]).toContain(result._tag);
          if (result._tag === "Right") {
            // Clean up the workspace dir
            await Effect.runPromise(runner.stop(result.right));
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
