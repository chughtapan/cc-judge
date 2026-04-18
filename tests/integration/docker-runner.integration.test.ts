import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { Effect } from "effect";
import { GenericContainer } from "testcontainers";
import { DockerRunner } from "../../src/runner/index.js";
import { ScenarioId } from "../../src/core/types.js";
import type { Scenario } from "../../src/core/schema.js";

const IMAGE = "alpine:3.19";

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
  beforeAll(async () => {
    const warm = await new GenericContainer(IMAGE)
      .withCommand(["tail", "-f", "/dev/null"])
      .withStartupTimeout(60_000)
      .start();
    await warm.stop();
  }, 180_000);

  it("start() yields a running container; stop() tears it down", async () => {
    const runner = new DockerRunner({ image: IMAGE });
    const handle = await Effect.runPromise(runner.start(scenario));
    expect(handle.kind).toBe("docker");
    expect(handle.containerId).toBeTruthy();
    const cid = handle.containerId ?? "";
    const running = execSync(`docker inspect -f '{{.State.Running}}' ${cid}`).toString().trim();
    expect(running).toBe("true");
    await Effect.runPromise(runner.stop(handle));
  }, 60_000);
});
