import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { canonicalTraceAdapter, otelTraceAdapter, getTraceAdapter } from "../src/emit/trace-adapter.js";

describe("canonicalTraceAdapter", () => {
  it("decodes a valid canonical JSON trace", async () => {
    const payload = JSON.stringify({
      traceId: "trace-1",
      name: "sample",
      turns: [
        {
          index: 0,
          prompt: "hi",
          response: "hello",
          startedAt: "2026-04-18T00:00:00.000Z",
          latencyMs: 100,
          toolCallCount: 0,
          inputTokens: 5,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      expectedBehavior: "greets",
      validationChecks: ["says hello"],
    });
    const trace = await Effect.runPromise(canonicalTraceAdapter.decode(payload, "mem://trace"));
    expect(trace.traceId).toBe("trace-1");
    expect(trace.turns.length).toBe(1);
  });

  it("rejects invalid canonical payload", async () => {
    const result = await Effect.runPromise(
      Effect.either(canonicalTraceAdapter.decode("not json", "mem://bad")),
    );
    expect(result._tag).toBe("Left");
  });
});

describe("otelTraceAdapter", () => {
  it("extracts turns from gen_ai.* attributes", async () => {
    const payload = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "llm-call",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000250000000",
                  attributes: [
                    { key: "gen_ai.prompt", value: { stringValue: "hi" } },
                    { key: "gen_ai.completion", value: { stringValue: "hello" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: "5" } },
                    { key: "gen_ai.usage.output_tokens", value: { intValue: "7" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const trace = await Effect.runPromise(otelTraceAdapter.decode(payload, "mem://otel"));
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0]?.prompt).toBe("hi");
    expect(trace.turns[0]?.response).toBe("hello");
    expect(trace.turns[0]?.inputTokens).toBe(5);
    expect(trace.turns[0]?.latencyMs).toBe(250);
  });

  it("rejects otel envelope with no LLM spans", async () => {
    const payload = JSON.stringify({ resourceSpans: [] });
    const result = await Effect.runPromise(
      Effect.either(otelTraceAdapter.decode(payload, "mem://empty")),
    );
    expect(result._tag).toBe("Left");
  });
});

describe("getTraceAdapter", () => {
  it("dispatches by format", () => {
    expect(getTraceAdapter("canonical").format).toBe("canonical");
    expect(getTraceAdapter("otel").format).toBe("otel");
  });
});
