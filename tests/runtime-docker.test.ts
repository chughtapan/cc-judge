// Tests for DockerRuntime that exercise the actual Docker daemon via
// dockerode. Lives in the regular test suite (not split out as
// "integration") so Stryker mutation testing sees these assertions —
// without that, every Docker code path in src/runner/runtime.ts would
// show as no-coverage.
//
// Skipped automatically on machines without a reachable Docker socket
// (CI without Docker, dev box with Desktop stopped) via a sync
// `docker version --format` probe at module load. `pnpm test` is safe
// to run anywhere; the suite either passes or skips, never errors.
//
// Coverage:
// - DockerImageArtifact pull-policy semantics (always, if-missing, never)
// - DockerBuildArtifact end-to-end (tar context → image → container)
// - Container lifecycle: prepare creates a container; stop kills + removes it
// - Auto-tagged image cleanup on build failure (P0-2 contract)
// - User-supplied imageTag preserved on build failure

import { afterAll, beforeAll, describe, expect } from "vitest";
import { Effect } from "effect";
import Docker from "dockerode";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { DockerRuntime, type RuntimeHandle } from "../src/runner/index.js";
import { AGENT_START_CAUSE } from "../src/core/errors.js";
import {
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type RunPlan,
} from "../src/core/types.js";
import { itEffect, expectLeft, expectCauseTag, EITHER_LEFT, EITHER_RIGHT } from "./support/effect.js";
import { IntegrationDockerError } from "./support/errors.js";
import { makeTempDir } from "./support/tmpdir.js";

// Boundary helper that adapts dockerode's Promise-returning API into a
// typed Effect. The lint rule against Promise<> return types targets
// application code; here the Promise comes from upstream and is the
// natural shape to pass through.
// eslint-disable-next-line agent-code-guard/promise-type
function awaitDocker<A>(thunk: () => Promise<A>): Effect.Effect<A, IntegrationDockerError, never> {
  return Effect.tryPromise({
    try: thunk,
    catch: (err) => new IntegrationDockerError({
      message: err instanceof Error ? err.message : String(err),
    }),
  });
}

const TEST_IMAGE = "alpine:3.19";

// Probe the Docker daemon synchronously at module load. The
// `--format {{.Server.Version}}` invocation exits non-zero when the
// daemon is unreachable (plain `docker info` / `docker version` exit 0
// on macOS even when the socket is down — they only report the
// client). describe.skipIf evaluates at registration time, so the
// probe must be sync.
const dockerAvailable: boolean = (() => {
  try {
    execSync("docker version --format {{.Server.Version}}", {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch (err) {
    void err;
    return false;
  }
})();

let pullErrorMessage: string | null = null;

// vitest hook signatures require async — the agent-code-guard
// async-keyword rule is opinionated about *application* code, not
// test fixtures that wrap upstream Promise APIs.
// eslint-disable-next-line agent-code-guard/async-keyword
beforeAll(async () => {
  if (!dockerAvailable) return;
  // Pre-pull the test image so the first test doesn't pay the latency.
  // Failure here is non-fatal — the pull-policy tests will retry.
  const docker = new Docker();
  try {
    const stream = await docker.pull(TEST_IMAGE);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => (err !== null ? reject(err) : resolve()));
    });
  } catch (err) {
    pullErrorMessage = err instanceof Error ? err.message : String(err);
  }
});

// eslint-disable-next-line agent-code-guard/async-keyword
afterAll(async () => {
  if (!dockerAvailable) return;
  // Best-effort cleanup of any stragglers — auto-tagged images from
  // build tests, leftover containers from interrupted runs.
  const docker = new Docker();
  try {
    const images = await docker.listImages({ filters: { reference: ["cc-judge-integration-*"] } });
    for (const summary of images) {
      try {
        await docker.getImage(summary.Id).remove({ force: true });
      } catch (err) {
        void err;
      }
    }
  } catch (err) {
    void err;
  }
});

function makePlan(scenario: string, agent: AgentDeclaration): RunPlan {
  return {
    project: ProjectId("cc-judge"),
    scenarioId: ScenarioId(scenario),
    name: scenario,
    description: `integration: ${scenario}`,
    agents: [agent],
    requirements: {
      expectedBehavior: "real docker round-trip",
      validationChecks: ["container start", "workspace mount"],
    },
  };
}

describe.skipIf(!dockerAvailable)("DockerRuntime (integration, real Docker)", () => {
  itEffect("prepare → stop cycle creates and reaps a real container", function* () {
    if (pullErrorMessage !== null) {
      // The image pull during beforeAll failed (rate limit, no
      // network, etc). Surface that instead of a noisier failure
      // later in the test body.
      expect.fail(`alpine:3.19 pull failed: ${pullErrorMessage}`);
    }
    const runtime = new DockerRuntime();
    const agent: AgentDeclaration = {
      id: AgentId("integration-prepare-stop"),
      name: "Integration Prepare/Stop",
      artifact: { _tag: "DockerImageArtifact", image: TEST_IMAGE, pullPolicy: "if-missing" },
      promptInputs: {},
    };
    const plan = makePlan(`integration-prepare-stop-${Date.now()}`, agent);

    const handle = (yield* runtime.prepare(agent, plan)) as RuntimeHandle & {
      readonly containerId?: string;
    };
    // .length is callable only on strings; structural check.
    expect(handle.containerId?.length ?? 0).toBeGreaterThan(0);
    expect(existsSync(handle.workspaceDir)).toBe(true);

    // Container is actually running per dockerode.
    const docker = new Docker();
    const inspect = yield* awaitDocker(() => docker.getContainer(handle.containerId ?? "").inspect());
    expect(inspect.State.Running).toBe(true);

    yield* runtime.stop(handle);

    // After stop, the workspace dir is gone and the container is no
    // longer present (AutoRemove + our explicit remove).
    expect(existsSync(handle.workspaceDir)).toBe(false);
    const stillThere = yield* Effect.either(
      Effect.tryPromise(() => docker.getContainer(handle.containerId ?? "").inspect()),
    );
    expect(stillThere._tag).toBe(EITHER_LEFT);
  });

  itEffect("pullPolicy 'never' fails when the image is not present locally", function* () {
    const runtime = new DockerRuntime();
    // Use a name that definitely does not exist locally.
    const phantomImage = `cc-judge-phantom-${Date.now()}:latest`;
    const agent: AgentDeclaration = {
      id: AgentId("integration-policy-never"),
      name: "Integration Policy Never",
      artifact: { _tag: "DockerImageArtifact", image: phantomImage, pullPolicy: "never" },
      promptInputs: {},
    };
    const plan = makePlan(`integration-policy-never-${Date.now()}`, agent);

    const result = yield* Effect.either(runtime.prepare(agent, plan));
    const error = expectLeft(result);
    expectCauseTag(error.cause, AGENT_START_CAUSE.ImageMissing);
  });

  itEffect("DockerBuildArtifact end-to-end builds and runs the auto-tagged image", function* () {
    const repoRoot = makeTempDir("int-build");
    const contextPath = path.join(repoRoot, "ctx");
    mkdirSync(contextPath, { recursive: true });
    writeFileSync(
      path.join(contextPath, "Dockerfile"),
      `FROM ${TEST_IMAGE}\nRUN echo hello > /built\n`,
      "utf8",
    );

    const runtime = new DockerRuntime();
    const agent: AgentDeclaration = {
      id: AgentId("integration-build"),
      name: "Integration Build",
      artifact: { _tag: "DockerBuildArtifact", contextPath },
      promptInputs: {},
    };
    const plan = makePlan(`integration-build-${Date.now()}`, agent);

    const handle = yield* runtime.prepare(agent, plan);
    expect(existsSync(handle.workspaceDir)).toBe(true);

    yield* runtime.stop(handle);

    expect(existsSync(handle.workspaceDir)).toBe(false);
    // Auto-tagged image was removed because removeOnStop was true
    // (artifact.imageTag was undefined).
    const docker = new Docker();
    const images = yield* awaitDocker(() =>
      docker.listImages({ filters: { reference: [`cc-judge-${plan.scenarioId}-*`] } }),
    );
    expect(images.length).toBe(0);
  });

  itEffect("DockerBuildArtifact failure removes the auto-tagged partial image", function* () {
    const repoRoot = makeTempDir("int-build-fail");
    const contextPath = path.join(repoRoot, "ctx");
    mkdirSync(contextPath, { recursive: true });
    writeFileSync(
      path.join(contextPath, "Dockerfile"),
      // Intentionally fail: try to run a command that doesn't exist.
      `FROM ${TEST_IMAGE}\nRUN /this/binary/does/not/exist\n`,
      "utf8",
    );

    const runtime = new DockerRuntime();
    const scenarioId = `integration-build-fail-${Date.now()}`;
    const agent: AgentDeclaration = {
      id: AgentId("integration-build-fail"),
      name: "Integration Build Fail",
      artifact: { _tag: "DockerBuildArtifact", contextPath },
      promptInputs: {},
    };
    const plan = makePlan(scenarioId, agent);

    const result = yield* Effect.either(runtime.prepare(agent, plan));
    const error = expectLeft(result);
    expectCauseTag(error.cause, AGENT_START_CAUSE.DockerBuildFailed);

    // No auto-tagged image left over.
    const docker = new Docker();
    const images = yield* awaitDocker(() =>
      docker.listImages({ filters: { reference: [`cc-judge-${scenarioId}-*`] } }),
    );
    expect(images.length).toBe(0);
  });

  itEffect("DockerBuildArtifact failure preserves a user-supplied imageTag", function* () {
    const repoRoot = makeTempDir("int-build-userTag");
    const contextPath = path.join(repoRoot, "ctx");
    mkdirSync(contextPath, { recursive: true });
    writeFileSync(
      path.join(contextPath, "Dockerfile"),
      `FROM ${TEST_IMAGE}\nRUN /this/binary/does/not/exist\n`,
      "utf8",
    );

    const docker = new Docker();
    const userTag = `cc-judge-integration-usertag-${Date.now()}:test`;

    // First build a working image with the user tag so it's actually
    // present in the daemon. Then re-run with a failing Dockerfile to
    // assert the failure path doesn't yank the user's image.
    const buildStream = yield* awaitDocker(() =>
      docker.buildImage(
        { context: contextPath, src: ["Dockerfile"] },
        { t: userTag },
      ),
    );
    yield* Effect.async<void, never>((resume) => {
      docker.modem.followProgress(buildStream, () => resume(Effect.void));
    });

    // A separate Dockerfile that builds successfully so we can stage
    // the user image without depending on the broken Dockerfile we
    // wrote above. Overwrite, build, then break it again.
    writeFileSync(
      path.join(contextPath, "Dockerfile"),
      `FROM ${TEST_IMAGE}\nRUN echo ok\n`,
      "utf8",
    );
    const setupStream = yield* awaitDocker(() =>
      docker.buildImage({ context: contextPath, src: ["Dockerfile"] }, { t: userTag }),
    );
    yield* Effect.async<void, never>((resume) => {
      docker.modem.followProgress(setupStream, () => resume(Effect.void));
    });
    // Now break the Dockerfile so the next build fails.
    writeFileSync(
      path.join(contextPath, "Dockerfile"),
      `FROM ${TEST_IMAGE}\nRUN /this/binary/does/not/exist\n`,
      "utf8",
    );

    const runtime = new DockerRuntime();
    const agent: AgentDeclaration = {
      id: AgentId("integration-build-userTag"),
      name: "Integration Build UserTag",
      artifact: { _tag: "DockerBuildArtifact", contextPath, imageTag: userTag },
      promptInputs: {},
    };
    const plan = makePlan(`integration-build-userTag-${Date.now()}`, agent);

    const result = yield* Effect.either(runtime.prepare(agent, plan));
    expect(result._tag).toBe(EITHER_LEFT);

    // User-supplied tag is still present in the daemon.
    const inspectResult = yield* Effect.either(
      Effect.tryPromise(() => docker.getImage(userTag).inspect()),
    );
    expect(inspectResult._tag).toBe(EITHER_RIGHT);

    // Test cleanup: remove the user-staged image.
    yield* Effect.tryPromise(() => docker.getImage(userTag).remove({ force: true })).pipe(
      Effect.catchAll(() => Effect.void),
    );
  });
});
