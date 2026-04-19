import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { Effect } from "effect";
import { GenericContainer } from "testcontainers";
import { DockerRunner } from "../../src/runner/index.js";
import { ScenarioId, RUNTIME_KIND } from "../../src/core/types.js";
import type { Scenario } from "../../src/core/schema.js";
import { itEffect } from "../support/effect.js";

const IMAGE = "alpine:3.19";
const CONTAINER_RUNNING = "true";
const INTEGRATION_TIMEOUT_MS = 60_000;
const WARM_STARTUP_TIMEOUT_MS = 60_000;
const WARM_TOTAL_TIMEOUT_MS = 180_000;

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch (err) {
    void err;
    return false;
  }
}

const scenario: Scenario = {
  id: ScenarioId("it-docker-runner"),
  name: "integration",
  description: "",
  setupPrompt: "noop",
  expectedBehavior: "",
  validationChecks: ["noop"],
  workspace: [{ path: "hello.txt", content: "hi" }],
};

describe.skipIf(!dockerAvailable())("DockerRunner integration (real Docker)", () => {
  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const warm = yield* Effect.promise(() =>
            new GenericContainer(IMAGE)
              .withCommand(["tail", "-f", "/dev/null"])
              .withStartupTimeout(WARM_STARTUP_TIMEOUT_MS)
              .start(),
          );
          yield* Effect.promise(() => warm.stop());
        }),
      ),
    WARM_TOTAL_TIMEOUT_MS,
  );

  itEffect(
    "start() yields a running container; stop() tears it down",
    function* () {
      const runner = new DockerRunner({ image: IMAGE });
      const handle = yield* runner.start(scenario);
      expect(handle.kind).toBe(RUNTIME_KIND.Docker);
      expect(handle.containerId).toBeTruthy();
      const cid = handle.containerId ?? "";
      const running = execSync(`docker inspect -f '{{.State.Running}}' ${cid}`)
        .toString()
        .trim();
      expect(running).toBe(CONTAINER_RUNNING);
      yield* runner.stop(handle);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
