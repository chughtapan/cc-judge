// Real-process tests for SubprocessRuntime. The DockerRuntime tests that
// previously lived here were mocked-execSync string-assembly tests — they
// asserted that we passed the right shell text to a fake docker binary,
// which doesn't tell us anything about whether real Docker accepts the
// command. They were deleted alongside a follow-up plan to (1) replace
// runtime.ts's manual `execSync("docker ...")` driving with dockerode and
// (2) cover Docker behavior with a real-Docker integration suite under
// tests/integration/. Until that ships, runtime.ts's Docker paths are
// covered only by the type system.

import { describe, expect } from "vitest";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { SubprocessRuntime } from "../src/runner/index.js";
import { AgentId, ProjectId, ScenarioId } from "../src/core/types.js";
import { itEffect, expectLeft } from "./support/effect.js";

describe("SubprocessRuntime", () => {
  itEffect(
    "rejects with BinaryNotFound when bin path does not exist",
    function* () {
      const runtime = new SubprocessRuntime({ bin: "/path/that/definitely/does/not/exist/cc-judge-test" });
      const agent = {
        id: AgentId("subproc-missing-bin"),
        name: "Subproc Missing Bin",
        artifact: {
          _tag: "DockerImageArtifact" as const,
          image: "n/a",
        },
        promptInputs: {},
      };
      const plan = {
        project: ProjectId("cc-judge"),
        scenarioId: ScenarioId("subproc-missing-bin"),
        name: "subproc-missing-bin",
        description: "verify BinaryNotFound when bin path missing",
        agents: [agent] as const,
        requirements: {
          expectedBehavior: "fails with BinaryNotFound",
          validationChecks: ["BinaryNotFound cause"],
        },
      };

      const result = yield* Effect.either(runtime.prepare(agent, plan));
      const error = expectLeft(result);
      expect(error.cause._tag).toBe("BinaryNotFound");
    },
  );

  itEffect(
    "creates and reaps the workspace tmpdir on a successful prepare/stop cycle",
    function* () {
      // /bin/echo is guaranteed to exist on POSIX CI.
      const runtime = new SubprocessRuntime({ bin: "/bin/echo" });
      const scenarioPrefix = `subproc-success-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const agent = {
        id: AgentId("subproc-success"),
        name: "Subproc Success",
        artifact: {
          _tag: "DockerImageArtifact" as const,
          image: "n/a",
        },
        promptInputs: {},
      };
      const plan = {
        project: ProjectId("cc-judge"),
        scenarioId: ScenarioId(scenarioPrefix),
        name: "subproc-success",
        description: "happy path: workspace created and removed",
        agents: [agent] as const,
        requirements: {
          expectedBehavior: "workspace lifecycle clean",
          validationChecks: ["created then removed"],
        },
      };

      const handle = yield* runtime.prepare(agent, plan);
      expect(existsSync(handle.workspaceDir)).toBe(true);
      yield* runtime.stop(handle);
      expect(existsSync(handle.workspaceDir)).toBe(false);
    },
  );
});
