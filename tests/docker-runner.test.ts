// DockerRunner unit tests with mocked execSync.
// Real Docker integration lives in tests/integration/docker-runner.integration.test.ts.

import { vi, describe, expect, afterEach } from "vitest";
import { Effect } from "effect";
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
vi.mock("node:child_process", () => ({ ...childProcessActual, execSync: vi.fn() }));

// Import after vi.mock so the module sees the mock.
const { DockerRunner } = await import("../src/runner/index.js");
const { ScenarioId, RUNTIME_KIND } = await import("../src/core/types.js");
const { ERROR_TAG, AGENT_START_CAUSE } = await import("../src/core/errors.js");
import * as childProcess from "node:child_process";

const execSyncMock = vi.mocked(childProcess.execSync);

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
});
