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
import { AGENT_START_CAUSE } from "../src/core/errors.js";
import {
  AgentId,
  type ExecutionArtifact,
  ProjectId,
  RUNTIME_KIND,
  ScenarioId,
} from "../src/core/types.js";
import { itEffect, expectLeft, expectCauseTag } from "./support/effect.js";

const STUB_DOCKER_ARTIFACT = { _tag: "DockerImageArtifact", image: "n/a" } as const;
const SUBPROCESS_ARTIFACT = { _tag: "SubprocessArtifact", label: "local-claude" } as const;

function makePlan(scenarioId: string, artifact: ExecutionArtifact) {
  const agent = {
    id: AgentId(scenarioId),
    name: scenarioId,
    artifact,
    promptInputs: {},
  };
  const plan = {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId(scenarioId),
    name: scenarioId,
    description: scenarioId,
    agents: [agent] as const,
    requirements: {
      expectedBehavior: scenarioId,
      validationChecks: [scenarioId],
    },
  };
  return { agent, plan };
}

describe("SubprocessRuntime", () => {
  itEffect(
    "rejects with BinaryNotFound when bin path does not exist",
    function* () {
      const runtime = new SubprocessRuntime({ bin: "/path/that/definitely/does/not/exist/cc-judge-test" });
      const { agent, plan } = makePlan("subproc-missing-bin", STUB_DOCKER_ARTIFACT);

      const result = yield* Effect.either(runtime.prepare(agent, plan));
      const error = expectLeft(result);
      expectCauseTag(error.cause, AGENT_START_CAUSE.BinaryNotFound);
    },
  );

  // Lifecycle parity: SubprocessRuntime.prepare/stop is identical for the
  // legacy stub DockerImageArtifact (Invariant I1, compat) and the new
  // SubprocessArtifact (spec §5 PR 1, §8.1 (B)). One body, two artifacts.
  describe.each<{ readonly label: string; readonly artifact: ExecutionArtifact }>([
    { label: "DockerImageArtifact stub", artifact: STUB_DOCKER_ARTIFACT },
    { label: "SubprocessArtifact", artifact: SUBPROCESS_ARTIFACT },
  ])("prepare/stop with $label", ({ artifact }) => {
    itEffect(
      "creates and reaps the workspace tmpdir on a successful cycle",
      function* () {
        // /bin/echo is guaranteed to exist on POSIX CI.
        const runtime = new SubprocessRuntime({ bin: "/bin/echo" });
        const scenarioId = `subproc-${artifact._tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { agent, plan } = makePlan(scenarioId, artifact);

        const handle = yield* runtime.prepare(agent, plan);
        expect(existsSync(handle.workspaceDir)).toBe(true);
        expect(handle.kind).toBe(RUNTIME_KIND.Subprocess);
        yield* runtime.stop(handle);
        expect(existsSync(handle.workspaceDir)).toBe(false);
      },
    );
  });
});
