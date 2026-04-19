// DockerRunner unit tests with mocked execSync.
// Real Docker integration lives in tests/integration/docker-runner.integration.test.ts.

import { vi, describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { existsSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: vi.fn() };
});

// Import after vi.mock so the module sees the mock.
const { DockerRunner } = await import("../src/runner/index.js");
const { ScenarioId } = await import("../src/core/types.js");
import * as childProcess from "node:child_process";

const execSyncMock = vi.mocked(childProcess.execSync);

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
  it("returns AgentStartError{ImageMissing} when docker image inspect fails", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("image not found");
    });
    const runner = new DockerRunner({ image: "nonexistent:latest" });
    const result = await Effect.runPromise(Effect.either(runner.start(makeScenario())));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentStartError");
      expect(result.left.cause._tag).toBe("ImageMissing");
      expect((result.left.cause as { _tag: "ImageMissing"; image: string }).image).toBe(
        "nonexistent:latest",
      );
    }
  });

  it("returns AgentStartError{ContainerStartFailed} when docker create fails", async () => {
    execSyncMock
      .mockReturnValueOnce(Buffer.from("")) // docker image inspect → image exists
      .mockImplementation(() => {
        throw new Error("docker create failed");
      }); // docker create → throws
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const result = await Effect.runPromise(Effect.either(runner.start(makeScenario())));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AgentStartError");
      expect(result.left.cause._tag).toBe("ContainerStartFailed");
    }
  });

  it("returns AgentHandle on happy path with correct kind and containerId", async () => {
    execSyncMock
      .mockReturnValueOnce(Buffer.from("")) // docker image inspect
      .mockReturnValueOnce(Buffer.from("container-abc-123\n")) // docker create
      .mockReturnValueOnce(Buffer.from("")); // docker start
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const result = await Effect.runPromise(Effect.either(runner.start(makeScenario())));
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.kind).toBe("docker");
      expect(result.right.containerId).toBe("container-abc-123");
      expect(existsSync(result.right.workspaceDir)).toBe(true);
      // Clean up the workspace dir manually (stop() would need real docker)
      const { rmSync } = await import("node:fs");
      rmSync(result.right.workspaceDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["network: bridge", { network: "bridge" as const }, "--network", "bridge"],
    ["memoryMb: 512", { memoryMb: 512 }, "--memory", "512m"],
    ["cpus: 2", { cpus: 2 }, "--cpus", "2"],
  ])("passes %s option in docker create command", async (_label, opts, expectedFlag, expectedValue) => {
    execSyncMock
      .mockReturnValueOnce(Buffer.from(""))
      .mockReturnValueOnce(Buffer.from("cid\n"))
      .mockReturnValueOnce(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19", ...opts });
    await Effect.runPromise(Effect.either(runner.start(makeScenario())));
    const createCall = execSyncMock.mock.calls[1]?.[0] as string | undefined;
    expect(createCall).toContain(expectedFlag);
    expect(createCall).toContain(expectedValue);
  });
});

// ------------------------------------------------------------------
// DockerRunner.stop()
// ------------------------------------------------------------------

function makeFakeHandle(containerId?: string): Parameters<InstanceType<typeof DockerRunner>["stop"]>[0] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-judge-docker-test-"));
  return {
    __brand: "AgentHandle" as const,
    kind: "docker" as const,
    scenarioId: ScenarioId("docker-test"),
    workspaceDir: dir,
    containerId,
    initialFiles: new Map(),
    turnsExecuted: { count: 0 },
  };
}

describe("DockerRunner.stop()", () => {
  it("removes workspace directory", async () => {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("some-container-id");
    const dir = handle.workspaceDir;
    expect(existsSync(dir)).toBe(true);
    await Effect.runPromise(runner.stop(handle));
    expect(existsSync(dir)).toBe(false);
  });

  it("calls docker kill and docker rm when containerId is present", async () => {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-xyz");
    await Effect.runPromise(runner.stop(handle));
    const calls = execSyncMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("docker kill") && c.includes("cid-xyz"))).toBe(true);
    expect(calls.some((c) => c.includes("docker rm") && c.includes("cid-xyz"))).toBe(true);
  });

  it("skips docker calls when containerId is undefined", async () => {
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle(undefined);
    await Effect.runPromise(runner.stop(handle));
    // No docker commands should be called
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("is idempotent — second stop() does not fail even when workspace is gone", async () => {
    execSyncMock.mockReturnValue(Buffer.from(""));
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-idem");
    await Effect.runPromise(runner.stop(handle));
    await expect(Effect.runPromise(runner.stop(handle))).resolves.toBeUndefined();
  });

  it("succeeds even when docker kill throws (container already dead)", async () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error("container already stopped");
      }) // docker kill throws
      .mockReturnValueOnce(Buffer.from("")); // docker rm succeeds
    const runner = new DockerRunner({ image: "alpine:3.19" });
    const handle = makeFakeHandle("cid-dead");
    // stop() invariant: never fails, even if docker kill throws
    await expect(Effect.runPromise(runner.stop(handle))).resolves.toBeUndefined();
  });
});
