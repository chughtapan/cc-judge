import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { parseRunArgs } from "../src/app/cli.js";
import { makeNormalizedBundleSink } from "../src/runner/coordinator.js";
import type { RunPlan, AgentTurn } from "../src/core/types.js";

describe("stream-events flag", () => {
  describe("CLI argument parsing", () => {
    it("should parse --stream-events flag as true", () => {
      const args = parseRunArgs({
        scenario: "test.yaml",
        runtime: "docker",
        image: "test-image",
        streamEvents: true,
      });
      expect(args.streamEvents).toBe(true);
    });

    it("should parse --stream-events flag as false when not provided", () => {
      const args = parseRunArgs({
        scenario: "test.yaml",
        runtime: "docker",
        image: "test-image",
      });
      expect(args.streamEvents).toBe(false);
    });

    it("should parse --stream-events flag as false when explicitly false", () => {
      const args = parseRunArgs({
        scenario: "test.yaml",
        runtime: "docker",
        image: "test-image",
        streamEvents: false,
      });
      expect(args.streamEvents).toBe(false);
    });
  });

  describe("sink-level event streaming", () => {
    it("recordTurn emits [turn] prefix to stderr when streamEvents=true", () => {
      const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const plan: RunPlan = {
        agents: [],
        project: "test",
        scenarioId: "test-scenario",
        name: "Test",
        description: "",
        requirements: [],
      };

      const sink = makeNormalizedBundleSink(plan, "test-run-id", true);

      const turn: AgentTurn = {
        agentId: undefined,
        index: 0,
        prompt: "test prompt",
        response: "test response",
        startedAt: "2024-01-01T00:00:00Z",
        latencyMs: 100,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

      // Execute the Effect
      const result = Effect.runSync(sink.recordTurn(turn));

      expect(writeSpy).toHaveBeenCalled();
      const callArgs = writeSpy.mock.calls[0][0] as string;
      expect(callArgs).toMatch(/^\[turn\] /);
      expect(callArgs).toContain("test prompt");

      writeSpy.mockRestore();
    });

    it("recordEvent emits [event] prefix to stderr when streamEvents=true", () => {
      const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const plan: RunPlan = {
        agents: [],
        project: "test",
        scenarioId: "test-scenario",
        name: "Test",
        description: "",
        requirements: [],
      };

      const sink = makeNormalizedBundleSink(plan, "test-run-id", true);

      const event = {
        type: "message" as const,
        agentId: undefined,
        content: "test event",
        sentAt: "2024-01-01T00:00:00Z",
      };

      Effect.runSync(sink.recordEvent(event));

      expect(writeSpy).toHaveBeenCalled();
      const callArgs = writeSpy.mock.calls[0][0] as string;
      expect(callArgs).toMatch(/^\[event\] /);
      expect(callArgs).toContain("test event");

      writeSpy.mockRestore();
    });

    it("no stderr output when streamEvents=false", () => {
      const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const plan: RunPlan = {
        agents: [],
        project: "test",
        scenarioId: "test-scenario",
        name: "Test",
        description: "",
        requirements: [],
      };

      const sink = makeNormalizedBundleSink(plan, "test-run-id", false);

      const turn: AgentTurn = {
        agentId: undefined,
        index: 0,
        prompt: "test",
        response: "test",
        startedAt: "2024-01-01T00:00:00Z",
        latencyMs: 100,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

      Effect.runSync(sink.recordTurn(turn));

      // Filter to only [turn] writes (not other stderr noise)
      const turnWrites = writeSpy.mock.calls.filter(
        call => typeof call[0] === "string" && (call[0] as string).includes("[turn]"),
      );
      expect(turnWrites).toHaveLength(0);

      writeSpy.mockRestore();
    });
  });
});
