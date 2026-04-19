// DockerRunner unit tests with mocked execSync and spawn.
// Real Docker integration lives in tests/integration/docker-runner.integration.test.ts.

import { vi, describe, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { itEffect, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";

// createRequire keeps the vi.mock factory synchronous so the mocked module is
// ready before the dynamic imports below pull in the code under test.
const { childProcessActual } = vi.hoisted(() => {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const req = createRequire(import.meta.url);
  return {
    childProcessActual: req("node:child_process") as typeof import("node:child_process"),
  };
});
vi.mock("node:child_process", () => ({
  ...childProcessActual,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Import after vi.mock so the module sees the mock.
const { DockerRunner } = await import("../src/runner/index.js");
const { ScenarioId, RUNTIME_KIND } = await import("../src/core/types.js");
const { ERROR_TAG, AGENT_START_CAUSE } = await import("../src/core/errors.js");
import * as childProcess from "node:child_process";

const execSyncMock = vi.mocked(childProcess.execSync);
const spawnMock = vi.mocked(childProcess.spawn);

// ── FakeChildProcess ──────────────────────────────────────────────────────────
// A minimal ChildProcess stand-in used to drive DockerRunner.turn() tests.
// Exposes .stdout and .stderr as EventEmitter instances plus the process-level
// events (close, error) on the root object.
class FakeChildProcess extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly killed: boolean = false;
  private readonly _spawnKill: () => void;

  constructor(spawnKill?: () => void) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this._spawnKill = spawnKill ?? (() => undefined);
  }

  kill(_signal?: string): boolean {
    this._spawnKill();
    return true;
  }
}

// Helper: build a FakeChildProcess that emits stdout data then closes.
function fakeChild(
  stdoutChunks: string[],
  stderrChunks: string[] = [],
  killFn?: () => void,
): FakeChildProcess {
  const child = new FakeChildProcess(killFn);
  // Emit asynchronously so the caller's `.on()` wiring has already run.
  setImmediate(() => {
    for (const chunk of stdoutChunks) {
      child.stdout.emit("data", Buffer.from(chunk));
    }
    for (const chunk of stderrChunks) {
      child.stderr.emit("data", Buffer.from(chunk));
    }
    child.emit("close", 0);
  });
  return child;
}

// Helper: build a FakeChildProcess that emits an "error" event.
function fakeErrorChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  setImmediate(() => {
    child.emit("error", new Error("spawn error"));
  });
  return child;
}

// Helper: build a FakeChildProcess that never closes (used to test timeout).
function fakeHangingChild(): FakeChildProcess {
  return new FakeChildProcess();
}

// Named constants for DockerRunner.turn() tests.
const DOCKER_TURN_TIMEOUT_SHORT = 60;
const DOCKER_CONTAINER_ID = "docker-cid-test";
const DOCKER_ASSISTANT_CONTENT = "docker-assistant-response";
const DOCKER_STDERR_CONTENT = "docker-stderr-fallback";
const DOCKER_TOOL_CALL_COUNT = 1;
const DOCKER_INPUT_TOKENS = 7;
const DOCKER_OUTPUT_TOKENS = 3;
const DOCKER_LATENCY_UPPER_BOUND_MS = 30_000;
const WORKSPACE_MOUNT_PATH = "/workspace";
const SAFE_IMAGE_NAME = "alpine:3.19";
const SPECIAL_CHAR_IMAGE = "registry.example.com/my image:latest";

const NONEXISTENT_IMAGE = "nonexistent:latest";
const HAPPY_CONTAINER_ID = "container-abc-123";

function makeScenario() {
  return {
    id: ScenarioId("docker-test"),
    name: "docker-test",
    description: "",
    setupPrompt: "noop",
    expectedBehavior: "",
    validationChecks: [] as string[],
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

// ------------------------------------------------------------------
// DockerRunner.start() — failure paths
// ------------------------------------------------------------------

describe("DockerRunner.start()", () => {
  itEffect("returns AgentStartError{ImageMissing} when docker image inspect fails", function* () {
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: NONEXISTENT_IMAGE });
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentStartError);
      expect(result.left.cause._tag).toBe(AGENT_START_CAUSE.ImageMissing);
      expect(
        (result.left.cause as { _tag: typeof AGENT_START_CAUSE.ImageMissing; image: string }).image,
      ).toBe(NONEXISTENT_IMAGE);
    }
  });

  itEffect("returns AgentStartError{ContainerStartFailed} when docker create fails", function* () {
    execSyncMock
      .mockReturnValueOnce(Buffer.from("")) // docker image inspect → image exists
      .mockImplementation(() => {
        throw new Error("docker create failed");
      }); // docker create → throws
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentStartError);
      expect(result.left.cause._tag).toBe(AGENT_START_CAUSE.ContainerStartFailed);
    }
  });

  itEffect("returns AgentHandle on happy path with correct kind and containerId", function* () {
    execSyncMock
      .mockReturnValueOnce(Buffer.from("")) // docker image inspect
      .mockReturnValueOnce(Buffer.from(`${HAPPY_CONTAINER_ID}\n`)) // docker create
      .mockReturnValueOnce(Buffer.from("")); // docker start
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      expect(result.right.kind).toBe(RUNTIME_KIND.Docker);
      expect(result.right.containerId).toBe(HAPPY_CONTAINER_ID);
      expect(existsSync(result.right.workspaceDir)).toBe(true);
      // Clean up the workspace dir manually (stop() would need real docker)
      rmSync(result.right.workspaceDir, { recursive: true, force: true });
    }
  });

  const CREATE_CALL_INDEX = 1;
  const createOptionCases: ReadonlyArray<
    readonly [string, Partial<ConstructorParameters<typeof DockerRunner>[0]>, string, string]
  > = [
    ["network: bridge", { network: "bridge" as const }, "--network", "bridge"],
    ["memoryMb: 512", { memoryMb: 512 }, "--memory", "512m"],
    ["cpus: 2", { cpus: 2 }, "--cpus", "2"],
  ];
  for (const [label, opts, expectedFlag, expectedValue] of createOptionCases) {
    itEffect(`passes ${label} option in docker create command`, function* () {
      execSyncMock
        .mockReturnValueOnce(Buffer.from(""))
        .mockReturnValueOnce(Buffer.from("cid\n"))
        .mockReturnValueOnce(Buffer.from(""));
      const runner = new DockerRunner({ image: "alpine:3.19", ...opts });
      yield* Effect.either(runner.start(makeScenario()));
      const createCall = execSyncMock.mock.calls[CREATE_CALL_INDEX]?.[0] as string | undefined;
      expect(createCall).toContain(expectedFlag);
      expect(createCall).toContain(expectedValue);
    });
  }
});

// ------------------------------------------------------------------
// DockerRunner.stop()
// ------------------------------------------------------------------

function makeFakeHandle(containerId?: string): Parameters<InstanceType<typeof DockerRunner>["stop"]>[0] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-docker-test-"));
  return {
    __brand: "AgentHandle" as const,
    kind: RUNTIME_KIND.Docker,
    scenarioId: ScenarioId("docker-test"),
    workspaceDir: dir,
    containerId,
    initialFiles: new Map(),
    turnsExecuted: { count: 0 },
  };
}

describe("DockerRunner.stop()", () => {
  itEffect("removes workspace directory", function* () {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("some-container-id");
    const dir = handle.workspaceDir;
    expect(existsSync(dir)).toBe(true);
    yield* runner.stop(handle);
    expect(existsSync(dir)).toBe(false);
  });

  itEffect("calls docker kill and docker rm when containerId is present", function* () {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-xyz");
    yield* runner.stop(handle);
    const calls = execSyncMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("docker kill") && c.includes("cid-xyz"))).toBe(true);
    expect(calls.some((c) => c.includes("docker rm") && c.includes("cid-xyz"))).toBe(true);
  });

  itEffect("skips docker calls when containerId is undefined", function* () {
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle(undefined);
    yield* runner.stop(handle);
    // No docker commands should be called
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  itEffect("is idempotent — second stop() does not fail even when workspace is gone", function* () {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-idem");
    yield* runner.stop(handle);
    // stop() invariant: idempotent — second call must not fail.
    yield* runner.stop(handle);
  });

  itEffect("succeeds even when docker kill throws (container already dead)", function* () {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error("container already stopped");
      }) // docker kill throws
      .mockReturnValueOnce(Buffer.from("")); // docker rm succeeds
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-dead");
    // stop() invariant: never fails, even if docker kill throws.
    yield* runner.stop(handle);
  });

  itEffect("skips docker kill and rm when containerId is an empty string (length guard)", function* () {
    // Line 571: cid.length > 0 — an empty string containerId must skip docker calls.
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle("");
    yield* runner.stop(handle);
    // No docker kill / rm for empty cid string.
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// DockerRunner.start() — docker create command shape (kills line 438)
// ------------------------------------------------------------------

describe("DockerRunner.start() docker create command shape", () => {
  itEffect("mounts workspace at /workspace in the docker create command", function* () {
    // Line 438: "/workspace" string mutant — the volume binding must end at /workspace.
    execSyncMock
      .mockReturnValueOnce(Buffer.from("")) // docker image inspect
      .mockReturnValueOnce(Buffer.from("cid\n")) // docker create
      .mockReturnValueOnce(Buffer.from("")); // docker start
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const result = yield* Effect.either(runner.start(makeScenario()));
    const createCall = execSyncMock.mock.calls[1]?.[0] as string | undefined;
    // Clean up if workspace was created.
    if (result._tag === EITHER_RIGHT) {
      rmSync(result.right.workspaceDir, { recursive: true, force: true });
    }
    expect(createCall).toContain(WORKSPACE_MOUNT_PATH);
  });
});

// ------------------------------------------------------------------
// DockerRunner.start() — shellQuote observable effect (kills line 602 regex mutants)
// ------------------------------------------------------------------

describe("DockerRunner shellQuote (via start() command inspection)", () => {
  itEffect("safe image name is passed unquoted in docker image inspect command", function* () {
    // Line 602: /^[A-Za-z0-9_:@./=-]+$/ — safe chars must pass through unquoted.
    // With `if (true) return s`, all strings pass unquoted; regex change mutants
    // would allow unsafe strings through.
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    yield* Effect.either(runner.start(makeScenario()));
    const inspectCall = execSyncMock.mock.calls[0]?.[0] as string | undefined;
    // Safe image name must appear unquoted (no surrounding single quotes).
    expect(inspectCall).toContain(`docker image inspect ${SAFE_IMAGE_NAME}`);
  });

  itEffect("image name with spaces is shell-quoted in docker commands", function* () {
    // Line 602: regex mutants that drop anchors or quantifiers would let a string
    // containing a space pass through unquoted, breaking the docker command.
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: SPECIAL_CHAR_IMAGE });
    yield* Effect.either(runner.start(makeScenario()));
    const inspectCall = execSyncMock.mock.calls[0]?.[0] as string | undefined;
    // The image name contains a space so it must be single-quoted.
    expect(inspectCall).toContain("'");
    // The raw unquoted space must not appear between "inspect" and the end.
    expect(inspectCall).not.toMatch(/inspect [^ '].*[^ ']$/);
  });

  itEffect("image name with only safe characters is NOT single-quoted", function* () {
    // Negated-class mutant (/^[^A-Za-z0-9_:@./=-]+$/) would quote safe strings too.
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: "alpine:3.19" });
    yield* Effect.either(runner.start(makeScenario()));
    const inspectCall = execSyncMock.mock.calls[0]?.[0] as string | undefined;
    // Safe name must arrive without surrounding quotes.
    expect(inspectCall).not.toContain("'alpine:3.19'");
    expect(inspectCall).toContain("alpine:3.19");
  });

  itEffect("string with a leading special char is quoted (anchored start guard)", function* () {
    // Line 602: dropping the ^ anchor would let " foo" through unquoted since
    // the suffix is safe. Test with a string that has an unsafe leading char.
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: " leading-space" });
    yield* Effect.either(runner.start(makeScenario()));
    const inspectCall = execSyncMock.mock.calls[0]?.[0] as string | undefined;
    // Must be quoted because of the leading space.
    expect(inspectCall).toContain("'");
  });

  itEffect("multi-char safe string is quoted only when it contains unsafe chars (quantifier guard)", function* () {
    // Line 602: dropping the + quantifier (allowing only single safe chars) would
    // incorrectly quote any safe string longer than 1 character.
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: "safe-image" });
    yield* Effect.either(runner.start(makeScenario()));
    const inspectCall = execSyncMock.mock.calls[0]?.[0] as string | undefined;
    // Multi-char safe string must NOT be single-quoted.
    expect(inspectCall).toContain("safe-image");
    expect(inspectCall).not.toContain("'safe-image'");
  });
});

// ------------------------------------------------------------------
// DockerRunner.turn() — via mocked spawn (kills NoCoverage block lines 487–558)
// ------------------------------------------------------------------

describe("DockerRunner.turn()", () => {
  // For turn() tests, execSync is not called; only spawn is wired.

  itEffect("returns a Turn with assistant response from stdout", function* () {
    // Covers the "close" event path: finished=false→true, turnsExecuted++, parseStreamJson.
    const stdout = JSON.stringify({ type: "assistant", content: DOCKER_ASSISTANT_CONTENT }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const turn = yield* runner.turn(handle, "prompt", { timeoutMs: 10_000 });
    expect(turn.response).toBe(DOCKER_ASSISTANT_CONTENT);
    expect(turn.index).toBe(0);
    expect(turn.prompt).toBe("prompt");
  });

  itEffect("increments turnsExecuted.count after a successful close", function* () {
    const stdout = JSON.stringify({ type: "assistant", content: "ok" }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    expect(handle.turnsExecuted.count).toBe(0);
    yield* runner.turn(handle, "p", { timeoutMs: 10_000 });
    expect(handle.turnsExecuted.count).toBe(1);
  });

  itEffect("falls back to stderr when stdout produces no JSON response", function* () {
    // Covers the responseText conditional: parsed.response.length > 0 ? ... : stderr.
    spawnMock.mockReturnValueOnce(
      fakeChild([], [DOCKER_STDERR_CONTENT]) as ReturnType<typeof childProcess.spawn>,
    );
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const turn = yield* runner.turn(handle, "p", { timeoutMs: 10_000 });
    expect(turn.response).toContain(DOCKER_STDERR_CONTENT);
  });

  itEffect("latencyMs is non-negative and below upper bound", function* () {
    // Line 528: latencyMs = Date.now() - startMs; the + mutant produces a huge number.
    const stdout = JSON.stringify({ type: "assistant", content: "x" }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const turn = yield* runner.turn(handle, "p", { timeoutMs: 10_000 });
    expect(turn.latencyMs).toBeGreaterThanOrEqual(0);
    expect(turn.latencyMs).toBeLessThan(DOCKER_LATENCY_UPPER_BOUND_MS);
  });

  itEffect("returns AgentRunTimeoutError when timeout fires before close", function* () {
    // Covers the timer path: timeout fires, child.kill called, resume(fail(...)).
    spawnMock.mockReturnValueOnce(fakeHangingChild() as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const result = yield* Effect.either(
      runner.turn(handle, "p", { timeoutMs: DOCKER_TURN_TIMEOUT_SHORT }),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentRunTimeoutError);
      expect(result.left.timeoutMs).toBe(DOCKER_TURN_TIMEOUT_SHORT);
    }
  });

  itEffect("turnsExecuted.count is NOT incremented after a timeout", function* () {
    // The turnsExecuted.count increment only happens in the close handler; timeout must not increment.
    spawnMock.mockReturnValueOnce(fakeHangingChild() as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    yield* Effect.either(runner.turn(handle, "p", { timeoutMs: DOCKER_TURN_TIMEOUT_SHORT }));
    expect(handle.turnsExecuted.count).toBe(0);
  });

  itEffect("returns AgentRunTimeoutError when spawn emits an error event", function* () {
    // Covers the "error" event handler in DockerRunner.turn().
    spawnMock.mockReturnValueOnce(fakeErrorChild() as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const result = yield* Effect.either(runner.turn(handle, "p", { timeoutMs: 10_000 }));
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left._tag).toBe(ERROR_TAG.AgentRunTimeoutError);
    }
  });

  itEffect("second turn uses index 1 (turn index tracks correctly)", function* () {
    // Covers the turnIndex = handle.turnsExecuted.count path at turn() start.
    const makeStdout = (c: string): string => JSON.stringify({ type: "assistant", content: c }) + "\n";
    spawnMock
      .mockReturnValueOnce(fakeChild([makeStdout("t1")]) as ReturnType<typeof childProcess.spawn>)
      .mockReturnValueOnce(fakeChild([makeStdout("t2")]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const t1 = yield* runner.turn(handle, "p1", { timeoutMs: 10_000 });
    const t2 = yield* runner.turn(handle, "p2", { timeoutMs: 10_000 });
    expect(t1.index).toBe(0);
    expect(t2.index).toBe(1);
  });

  itEffect("extracts token counts from usage in stdout (DockerRunner path)", function* () {
    // Covers parseStreamJson token extraction inside DockerRunner.turn() close handler.
    const usage = { input_tokens: DOCKER_INPUT_TOKENS, output_tokens: DOCKER_OUTPUT_TOKENS };
    const stdout = JSON.stringify({ type: "system", usage }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    const turn = yield* runner.turn(handle, "p", { timeoutMs: 10_000 });
    expect(turn.inputTokens).toBe(DOCKER_INPUT_TOKENS);
    expect(turn.outputTokens).toBe(DOCKER_OUTPUT_TOKENS);
  });

  itEffect("spawn is called with docker exec <cid> claude and DEFAULT_CLAUDE_ARGS", function* () {
    // Line 485: args = ["exec", cid, "claude", ...DEFAULT_CLAUDE_ARGS, prompt].
    // Verifies the exec sub-command, containerId, and binary name are present.
    const stdout = JSON.stringify({ type: "assistant", content: "ok" }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(DOCKER_CONTAINER_ID);
    yield* runner.turn(handle, "my-prompt", { timeoutMs: 10_000 });
    const spawnArgs = spawnMock.mock.calls[0];
    expect(spawnArgs?.[0]).toBe("docker");
    const args = spawnArgs?.[1] as string[];
    expect(args).toContain("exec");
    expect(args).toContain(DOCKER_CONTAINER_ID);
    expect(args).toContain("claude");
    expect(args).toContain("my-prompt");
  });

  itEffect("uses empty string for cid when containerId is undefined (line 484)", function* () {
    // Line 484: cid = handle.containerId ?? "".
    // containerId=undefined → cid="" → args contains "exec" then "".
    const stdout = JSON.stringify({ type: "assistant", content: "ok" }) + "\n";
    spawnMock.mockReturnValueOnce(fakeChild([stdout]) as ReturnType<typeof childProcess.spawn>);
    const runner = new DockerRunner({ image: SAFE_IMAGE_NAME });
    const handle = makeFakeHandle(undefined);
    yield* runner.turn(handle, "p", { timeoutMs: 10_000 });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    // args[0]="exec", args[1]="" (empty cid), args[2]="claude"
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("");
    expect(args[2]).toBe("claude");
  });
});
