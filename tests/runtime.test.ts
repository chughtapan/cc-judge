import { afterEach, describe, expect, vi } from "vitest";
import { Effect } from "effect";

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

const { DockerRuntime } = await import("../src/runner/index.js");
const { AgentId, ProjectId, ScenarioId } = await import("../src/core/types.js");
import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { itEffect } from "./support/effect.js";

const execSyncMock = vi.mocked(childProcess.execSync);

afterEach(() => {
  vi.resetAllMocks();
});

describe("DockerRuntime", () => {
  itEffect("resolves dockerfilePath relative to contextPath before docker build", function* () {
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("docker create")) {
        return Buffer.from("runtime-cid\n");
      }
      return Buffer.from("");
    });

    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "cc-judge-runtime-"));
    const contextPath = path.join(repoRoot, "agents", "alpha");
    const relativeDockerfilePath = path.join("docker", "Dockerfile");
    const absoluteDockerfilePath = path.resolve(contextPath, relativeDockerfilePath);

    mkdirSync(path.join(contextPath, "docker"), { recursive: true });
    writeFileSync(absoluteDockerfilePath, "FROM alpine:3.19\n", "utf8");

    const runtime = new DockerRuntime();
    const agent = {
      id: AgentId("docker-agent"),
      name: "Docker Agent",
      artifact: {
        _tag: "DockerBuildArtifact" as const,
        contextPath,
        dockerfilePath: relativeDockerfilePath,
      },
      promptInputs: {},
    };
    const plan = {
      project: ProjectId("cc-judge"),
      scenarioId: ScenarioId("dockerfile-relative"),
      name: "dockerfile-relative",
      description: "relative dockerfile path",
      agents: [agent] as const,
      requirements: {
        expectedBehavior: "build from the relative dockerfile",
        validationChecks: ["docker build uses an absolute Dockerfile path"],
      },
    };

    const handle = yield* runtime.prepare(agent, plan);
    yield* runtime.stop(handle);

    const buildCommand = String(execSyncMock.mock.calls[0]?.[0] ?? "");
    expect(buildCommand).toContain(`-f ${absoluteDockerfilePath}`);
    expect(buildCommand).not.toMatch(/(^|\s)-f docker\/Dockerfile(\s|$)/u);
  });
});
