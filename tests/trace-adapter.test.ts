import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  canonicalTraceAdapter,
  otelTraceAdapter,
  getTraceAdapter,
  TRACE_FORMAT,
} from "../src/emit/trace-adapter.js";
import { itEffect, EITHER_LEFT } from "./support/effect.js";

const TRACE_ID_1 = "trace-1";
const PROMPT_HI = "hi";
const RESPONSE_HELLO = "hello";
const TURN_COUNT_ONE = 1;
const INPUT_TOKENS_FIVE = 5;
const LATENCY_MS_250 = 250;

describe("canonicalTraceAdapter", () => {
  itEffect("decodes a valid canonical JSON trace", function* () {
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
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://trace");
    expect(trace.traceId).toBe(TRACE_ID_1);
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("rejects invalid canonical payload", function* () {
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode("not json", "mem://bad"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });
});

describe("otelTraceAdapter", () => {
  itEffect("extracts turns from gen_ai.* attributes", function* () {
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
    const trace = yield* otelTraceAdapter.decode(payload, "mem://otel");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
    expect(trace.turns[0]?.prompt).toBe(PROMPT_HI);
    expect(trace.turns[0]?.response).toBe(RESPONSE_HELLO);
    expect(trace.turns[0]?.inputTokens).toBe(INPUT_TOKENS_FIVE);
    expect(trace.turns[0]?.latencyMs).toBe(LATENCY_MS_250);
  });

  itEffect("rejects otel envelope with no LLM spans", function* () {
    const payload = JSON.stringify({ resourceSpans: [] });
    const result = yield* Effect.either(
      otelTraceAdapter.decode(payload, "mem://empty"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });
});

describe("getTraceAdapter", () => {
  it("dispatches by format", () => {
    expect(getTraceAdapter(TRACE_FORMAT.Canonical).format).toBe(TRACE_FORMAT.Canonical);
    expect(getTraceAdapter(TRACE_FORMAT.Otel).format).toBe(TRACE_FORMAT.Otel);
  });
});
