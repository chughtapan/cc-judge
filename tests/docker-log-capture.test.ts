// Tests for DockerRunner permanent log-capture (acceptance #88).
//
// Coverage:
//   (a) start() returns an AgentHandle carrying dockerLogsChild + dockerLogRunId.
//   (b) log-follow child tees to results/inflight/<runId>/docker-<agentId>.log.
//   (c) stop() renames inflight file to results/runs/<runId>/docker-<agentId>.log.
//   (e) stop() kills the docker-logs-follow child (no zombies).
//   (f) Invariant #12: spawn failure → warning emitted + void (no AgentStartError).
//
// Real temp directories are used for the results dir so rename/exist assertions
// work without mocking the fs module.

import { vi, describe, expect, afterEach, beforeEach } from "vitest";
import { Effect } from "effect";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { itEffect, EITHER_RIGHT } from "./support/effect.js";

// ── child_process mock ──────────────────────────────────────────────────────
// Must be hoisted before any dynamic imports of the code under test.
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

// Dynamic imports after vi.mock so the module sees the mocked child_process.
const { DockerRunner, DOCKER_LOG_WARN_SOURCE } = await import("../src/runner/index.js");
const { ScenarioId, RUNTIME_KIND } = await import("../src/core/types.js");
import * as childProcess from "node:child_process";

const execSyncMock = vi.mocked(childProcess.execSync);
const spawnMock = vi.mocked(childProcess.spawn);

// ── FakeChildProcess ────────────────────────────────────────────────────────
// Minimal stand-in for ChildProcess used in docker-logs-follow tests.
class FakeLogsProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private _killCalled = false;
  private _killSignal: string | undefined;

  kill(signal?: string): boolean {
    this._killCalled = true;
    this._killSignal = signal;
    return true;
  }

  get killCalled(): boolean { return this._killCalled; }
  get killSignal(): string | undefined { return this._killSignal; }
}

// ── Test fixtures ───────────────────────────────────────────────────────────
const SAFE_IMAGE = "alpine:3.19";
const CONTAINER_ID = "abc-cid-123";
const SCENARIO_ID = "log-capture-scenario";
const LOG_FILE_NAME = `docker-${SCENARIO_ID}.log`;

function makeScenario() {
  return {
    id: ScenarioId(SCENARIO_ID),
    name: SCENARIO_ID,
    description: "",
    setupPrompt: "noop",
    expectedBehavior: "",
    validationChecks: [] as string[],
  };
}

// Mock execSync for the three docker setup calls: inspect, create, start.
function stubDockerSetup(cid = CONTAINER_ID): void {
  execSyncMock
    .mockReturnValueOnce(Buffer.from(""))         // docker image inspect
    .mockReturnValueOnce(Buffer.from(`${cid}\n`)) // docker create
    .mockReturnValueOnce(Buffer.from(""))          // docker start
    .mockReturnValue(Buffer.from(""));             // stop calls (kill, rm)
}

// Queue a FakeLogsProcess as the next spawn() return. Returns the fake so the
// test can emit data and inspect kill state.
function stubLogsSpawn(): FakeLogsProcess {
  const fake = new FakeLogsProcess();
  spawnMock.mockReturnValueOnce(fake as unknown as ReturnType<typeof childProcess.spawn>);
  return fake;
}

// Path helpers for the log file in a given runId's inflight and runs dirs.
function inflightPathOf(runId: string): string {
  return path.join(tmpResultsDir, "inflight", runId, LOG_FILE_NAME);
}
function runsPathOf(runId: string): string {
  return path.join(tmpResultsDir, "runs", runId, LOG_FILE_NAME);
}

// Spy on process.stderr.write and collect emitted lines. Returns a getter +
// restore so tests can inspect and clean up deterministically.
function captureStderr(): { getLines: () => ReadonlyArray<string>; restore: () => void } {
  const lines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((msg: unknown) => {
    lines.push(String(msg));
    return origWrite(msg as string);
  });
  return {
    getLines: () => lines,
    restore: () => { spy.mockRestore(); },
  };
}

// Find a structured-warning line matching the given event. The emitter uses a
// fixed DOCKER_LOG_WARN_SOURCE and one-line JSON per write (see dockerLogWarn).
function findWarning(lines: ReadonlyArray<string>, event: string): string | undefined {
  return lines.find((l) => {
    try {
      const obj = JSON.parse(l) as { source?: unknown; event?: unknown };
      return obj.source === DOCKER_LOG_WARN_SOURCE && obj.event === event;
    } catch (err) { void err; return false; }
  });
}

// Build a DockerRunner configured (optionally) with logCapture pointed at the
// per-test tmp results dir.
function buildRunner(withLogCapture: boolean): InstanceType<typeof DockerRunner> {
  return new DockerRunner({
    image: SAFE_IMAGE,
    ...(withLogCapture ? { logCapture: { resultsDir: tmpResultsDir } } : {}),
  });
}

// ── Test state ──────────────────────────────────────────────────────────────
let tmpResultsDir: string;

beforeEach(() => {
  tmpResultsDir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-logcap-test-"));
});

afterEach(() => {
  vi.resetAllMocks();
  try {
    rmSync(tmpResultsDir, { recursive: true, force: true });
  } catch (err) { void err; }
});

// ── DockerRunner.start() with logCapture ────────────────────────────────────

describe("DockerRunner.start() log capture", () => {
  itEffect("attaches dockerLogsChild and dockerLogRunId to the returned handle", function* () {
    // Acceptance #88a: start() returns AgentHandle carrying docker-logs-follow child.
    stubDockerSetup();
    const fakeLogsProc = stubLogsSpawn();

    const runner = buildRunner(true);
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      const handle = result.right;
      expect(handle.dockerLogRunId).toBeDefined();
      expect(typeof handle.dockerLogRunId).toBe("string");
      expect(handle.dockerLogsChild).toBe(fakeLogsProc);
      rmSync(handle.workspaceDir, { recursive: true, force: true });
    }
  });

  itEffect("spawns docker logs --follow <cid> when logCapture is configured", function* () {
    // Acceptance #88b: log-follow child is spawned with the right args.
    stubDockerSetup(CONTAINER_ID);
    stubLogsSpawn();

    const runner = buildRunner(true);
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      rmSync(result.right.workspaceDir, { recursive: true, force: true });
    }

    const logSpawnCall = spawnMock.mock.calls.find(([cmd, args]) =>
      cmd === "docker" && Array.isArray(args) && args[0] === "logs"
    );
    expect(logSpawnCall).toBeDefined();
    const [, logArgs] = logSpawnCall!;
    expect(logArgs).toContain("logs");
    expect(logArgs).toContain("--follow");
    expect(logArgs).toContain(CONTAINER_ID);
  });

  itEffect("creates inflight log file at predictable path (acceptance #88b, #88d)", function* () {
    // Acceptance #88b + #88d: file at results/inflight/<runId>/docker-<agentId>.log.
    stubDockerSetup();
    stubLogsSpawn();

    const runner = buildRunner(true);
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      const handle = result.right;
      expect(existsSync(inflightPathOf(handle.dockerLogRunId!))).toBe(true);
      rmSync(handle.workspaceDir, { recursive: true, force: true });
    }
  });

  itEffect("does not spawn docker logs when logCapture is not configured", function* () {
    // Without logCapture, handle has no dockerLogsChild or dockerLogRunId.
    stubDockerSetup();

    const runner = buildRunner(false);
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      const handle = result.right;
      expect(handle.dockerLogRunId).toBeUndefined();
      expect(handle.dockerLogsChild).toBeUndefined();
      rmSync(handle.workspaceDir, { recursive: true, force: true });
    }
    const logSpawnCall = spawnMock.mock.calls.find(([cmd, args]) =>
      cmd === "docker" && Array.isArray(args) && args[0] === "logs"
    );
    expect(logSpawnCall).toBeUndefined();
  });
});

// ── DockerRunner.stop() log rename ──────────────────────────────────────────

describe("DockerRunner.stop() log rename", () => {
  itEffect("renames docker log from inflight to runs on clean stop (acceptance #88c)", function* () {
    stubDockerSetup();
    stubLogsSpawn();

    const runner = buildRunner(true);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;

    const handle = startResult.right;
    const runId = handle.dockerLogRunId!;

    expect(existsSync(inflightPathOf(runId))).toBe(true);
    expect(existsSync(runsPathOf(runId))).toBe(false);

    yield* runner.stop(handle);

    expect(existsSync(inflightPathOf(runId))).toBe(false);
    expect(existsSync(runsPathOf(runId))).toBe(true);
  });

  itEffect("stop() succeeds without log fields (backward-compat handle)", function* () {
    // Handles created without logCapture should still stop() without error.
    stubDockerSetup();
    const runner = buildRunner(false);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;
    // stop() must not throw.
    yield* runner.stop(startResult.right);
    expect(existsSync(startResult.right.workspaceDir)).toBe(false);
  });

  itEffect("emits structured warning when rename fails (invariant #12)", function* () {
    // If the inflight file doesn't exist (simulated by deleting it), stop()
    // must emit a warning and return void — not throw.
    stubDockerSetup();
    stubLogsSpawn();

    const runner = buildRunner(true);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;

    const handle = startResult.right;
    const runId = handle.dockerLogRunId!;
    // Delete the inflight file to force rename to fail.
    rmSync(inflightPathOf(runId));

    const stderr = captureStderr();
    // stop() must not throw even when rename fails.
    yield* runner.stop(handle);
    stderr.restore();

    expect(findWarning(stderr.getLines(), "log.rename.failed")).toBeDefined();
  });
});

// ── DockerRunner.stop() kills docker-logs child (acceptance #88e) ───────────

describe("DockerRunner.stop() kills docker-logs-follow child", () => {
  itEffect("calls kill(SIGTERM) on dockerLogsChild during stop()", function* () {
    // Acceptance #88e: stop() must terminate the child to prevent zombies.
    stubDockerSetup();
    const fakeLogsProc = stubLogsSpawn();

    const runner = buildRunner(true);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;

    expect(fakeLogsProc.killCalled).toBe(false);
    yield* runner.stop(startResult.right);
    expect(fakeLogsProc.killCalled).toBe(true);
    expect(fakeLogsProc.killSignal).toBe("SIGTERM");
  });

  itEffect("stop() is safe when dockerLogsChild is undefined", function* () {
    // No logCapture configured → no child → stop() must not throw.
    stubDockerSetup();
    const runner = buildRunner(false);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;
    // Must not throw.
    yield* runner.stop(startResult.right);
  });

  itEffect("stop() swallows kill() errors (invariant #7 and #12)", function* () {
    // If kill() throws, stop() must still complete.
    stubDockerSetup();
    const fakeLogsProc = stubLogsSpawn();
    vi.spyOn(fakeLogsProc, "kill").mockImplementation(() => {
      throw new Error("kill ESRCH");
    });

    const runner = buildRunner(true);
    const startResult = yield* Effect.either(runner.start(makeScenario()));
    expect(startResult._tag).toBe(EITHER_RIGHT);
    if (startResult._tag !== EITHER_RIGHT) return;
    // Must not throw.
    yield* runner.stop(startResult.right);
  });
});

// ── Invariant #12: spawn failure → graceful degradation (acceptance #88f) ───

describe("DockerRunner.start() log capture failure handling (invariant #12)", () => {
  itEffect("returns a valid handle without dockerLogsChild when spawn throws", function* () {
    // Acceptance #88f: docker daemon gone → warning + void, no AgentStartError.
    stubDockerSetup();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn ENOENT: docker not found");
    });

    const stderr = captureStderr();
    const runner = buildRunner(true);
    const result = yield* Effect.either(runner.start(makeScenario()));
    stderr.restore();

    // start() must still return Right (handle), not Left (error).
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      const handle = result.right;
      expect(handle.dockerLogsChild).toBeUndefined();
      expect(handle.dockerLogRunId).toBeUndefined();
      expect(handle.kind).toBe(RUNTIME_KIND.Docker);
      rmSync(handle.workspaceDir, { recursive: true, force: true });
    }

    expect(findWarning(stderr.getLines(), "logs.start.failed")).toBeDefined();
  });

  itEffect("start() succeeds (Right) even when mkdirSync for logCapture throws", function* () {
    // Invariant #12: directory creation failure must not affect start().
    // Point logCapture.resultsDir at a regular file so mkdirSync(<file>/inflight/...)
    // fails with ENOTDIR — we only care that start() still returns Right.
    stubDockerSetup();
    const fileAsDir = path.join(tmpResultsDir, "i-am-a-file");
    writeFileSync(fileAsDir, "block");

    const runner = new DockerRunner({
      image: SAFE_IMAGE,
      logCapture: { resultsDir: fileAsDir },
    });
    const result = yield* Effect.either(runner.start(makeScenario()));
    expect(result._tag).toBe(EITHER_RIGHT);
    if (result._tag === EITHER_RIGHT) {
      const handle = result.right;
      expect(handle.dockerLogsChild).toBeUndefined();
      rmSync(handle.workspaceDir, { recursive: true, force: true });
    }
  });
});

// ── Tee behaviour: stdout+stderr from logsChild go to the log file ───────────

describe("DockerRunner log capture tee behaviour", () => {
  // Both stdout and stderr emissions from the docker-logs-follow child should
  // be appended to the same inflight log file (acceptance #88b).
  for (const stream of ["stdout", "stderr"] as const) {
    itEffect(`tees logsChild ${stream} data to the inflight log file`, function* () {
      stubDockerSetup();
      const fakeLogsProc = stubLogsSpawn();

      const runner = buildRunner(true);
      const startResult = yield* Effect.either(runner.start(makeScenario()));
      expect(startResult._tag).toBe(EITHER_RIGHT);
      if (startResult._tag !== EITHER_RIGHT) return;

      const handle = startResult.right;
      const logPath = inflightPathOf(handle.dockerLogRunId!);
      const testData = `data from container ${stream}\n`;

      fakeLogsProc[stream].emit("data", Buffer.from(testData));
      // Allow any pending async writes to flush.
      yield* Effect.promise(() => new Promise<void>((res) => setImmediate(res)));

      expect(readFileSync(logPath, "utf8")).toContain(testData);
      yield* runner.stop(handle);
    });
  }
});
