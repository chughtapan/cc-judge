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
const TURN_COUNT_TWO = 2;
const INPUT_TOKENS_FIVE = 5;
const LATENCY_MS_250 = 250;
const LATENCY_MS_ZERO = 0;
const TOOL_CALL_COUNT_THREE = 3;
const OUTPUT_TOKENS_SEVEN = 7;
const CACHE_READ_TOKENS_TWO = 2;
const CACHE_WRITE_TOKENS_NINE = 9;
const SCEN_ID_FROM_TRACE = "scen-from-trace";
const YAML_TRACE_NAME = "yaml-name";

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

describe("canonicalTraceAdapter (additional coverage)", () => {
  itEffect("decodes a valid canonical YAML trace (no {/[ start)", function* () {
    const payload = [
      `traceId: yaml-trace`,
      `name: ${YAML_TRACE_NAME}`,
      `turns:`,
      `  - index: 0`,
      `    prompt: hi`,
      `    response: hello`,
      `    startedAt: "2026-04-18T00:00:00.000Z"`,
      `    latencyMs: 10`,
      `    toolCallCount: 0`,
      `    inputTokens: 1`,
      `    outputTokens: 2`,
      `    cacheReadTokens: 0`,
      `    cacheWriteTokens: 0`,
      `expectedBehavior: greets`,
      `validationChecks: [ok]`,
    ].join("\n");
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://yaml");
    expect(trace.name).toBe(YAML_TRACE_NAME);
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("passes through scenarioId when canonical trace provides one", function* () {
    const payload = JSON.stringify({
      traceId: "t-with-scen",
      scenarioId: SCEN_ID_FROM_TRACE,
      name: "n",
      turns: [],
      expectedBehavior: "e",
      validationChecks: ["c"],
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://scen");
    expect(trace.scenarioId).toBe(SCEN_ID_FROM_TRACE);
  });

  itEffect("rejects canonical payload with schema-invalid shape (surfaces path in errors)", function* () {
    const payload = JSON.stringify({ traceId: 42, name: "n", turns: [] });
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode(payload, "mem://bad-shape"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("otelTraceAdapter (additional coverage)", () => {
  itEffect("rejects non-JSON otel payload with SchemaInvalid", function* () {
    const result = yield* Effect.either(
      otelTraceAdapter.decode("not json either", "mem://badotel"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe("SchemaInvalid");
    }
  });

  itEffect("rejects otel payload whose root is not an object", function* () {
    const result = yield* Effect.either(
      otelTraceAdapter.decode(JSON.stringify(["array-root"]), "mem://arr"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });

  itEffect("accepts `input`/`output` attribute fallback when gen_ai.* missing", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "input", value: { stringValue: "hi" } },
              { key: "output", value: { stringValue: "hello" } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://fallback");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
    expect(trace.turns[0]?.prompt).toBe(PROMPT_HI);
    expect(trace.turns[0]?.response).toBe(RESPONSE_HELLO);
  });

  itEffect("skips spans with neither prompt nor response (null Turn filtered)", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            { name: "empty", attributes: [] },
            {
              name: "llm",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: "q" } },
                { key: "gen_ai.completion", value: { stringValue: "a" } },
              ],
            },
          ],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://mixed");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("latencyMs is 0 when startTimeUnixNano missing or not a string", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: "q" } },
              { key: "gen_ai.completion", value: { stringValue: "a" } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://no-time");
    expect(trace.turns[0]?.latencyMs).toBe(LATENCY_MS_ZERO);
  });

  itEffect("coerces intValue numeric and doubleValue attributes", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000000250000000",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: "q" } },
              { key: "gen_ai.completion", value: { stringValue: "a" } },
              { key: "gen_ai.tool_call_count", value: { intValue: TOOL_CALL_COUNT_THREE } },
              { key: "gen_ai.usage.output_tokens", value: { doubleValue: OUTPUT_TOKENS_SEVEN } },
              { key: "gen_ai.usage.cache_read_input_tokens", value: { intValue: String(CACHE_READ_TOKENS_TWO) } },
              { key: "gen_ai.usage.cache_creation_input_tokens", value: { intValue: CACHE_WRITE_TOKENS_NINE } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://coerce");
    expect(trace.turns[0]?.toolCallCount).toBe(TOOL_CALL_COUNT_THREE);
    expect(trace.turns[0]?.outputTokens).toBe(OUTPUT_TOKENS_SEVEN);
    expect(trace.turns[0]?.cacheReadTokens).toBe(CACHE_READ_TOKENS_TWO);
    expect(trace.turns[0]?.cacheWriteTokens).toBe(CACHE_WRITE_TOKENS_NINE);
  });

  itEffect("ignores malformed resourceSpans (non-array) and fails with no spans", function* () {
    const payload = JSON.stringify({ resourceSpans: "oops" });
    const result = yield* Effect.either(
      otelTraceAdapter.decode(payload, "mem://mal-rs"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
  });

  itEffect("ignores spans that are not objects within a scopeSpans list", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            null,
            "string-span",
            {
              name: "real",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: "q" } },
                { key: "gen_ai.completion", value: { stringValue: "a" } },
              ],
            },
          ],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://filter");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("extracts multiple LLM spans in order, numbered 0..N-1", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              name: "first",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: "q1" } },
                { key: "gen_ai.completion", value: { stringValue: "a1" } },
              ],
            },
            {
              name: "second",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: "q2" } },
                { key: "gen_ai.completion", value: { stringValue: "a2" } },
              ],
            },
          ],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://multi");
    expect(trace.turns.length).toBe(TURN_COUNT_TWO);
    expect(trace.turns[0]?.index).toBe(0);
    expect(trace.turns[1]?.index).toBe(1);
    expect(trace.turns[0]?.prompt).toBe("q1");
    expect(trace.turns[1]?.prompt).toBe("q2");
  });
});
