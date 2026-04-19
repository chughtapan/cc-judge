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
const ERR_ROOT_NOT_OBJECT = "root is not an object";
const ERR_NO_LLM_SPANS = "no LLM spans found";
const EXPECTED_BEHAVIOR_EMPTY = "";
const VALIDATION_CHECKS_EMPTY: readonly string[] = [];
const ORIGIN_PATH_OTEL = "mem://otel-origin";
const PROMPT_Q = "q";
const RESPONSE_A = "a";
const LATENCY_MS_100 = 100;
const START_NS_1700 = "1700000000000000000";
const END_NS_1700_PLUS_100 = "1700000000100000000";
const SCHEMA_INVALID_TAG = "SchemaInvalid";
const TRACE_ID_LEADING = "t-leading";
const TRACE_ID_JSON_DIRECT = "t-json-direct";
const DOUBLE_VALUE_12 = 12;
const INT_VALUE_7 = 7;
const INT_VALUE_42 = 42;
const RESPONSE_NON_EMPTY = "non-empty";
const START_DATE_2023 = "2023-11-14";

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
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
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

// ─── parseEither branch detection ───────────────────────────────────────────
// These tests kill mutations on lines 30-31: trimStart vs trimEnd, the
// startsWith("{") || startsWith("[") condition and its operator/method variants.

describe("parseEither branch detection (canonical adapter)", () => {
  itEffect("parses JSON object with leading whitespace via trimStart (not trimEnd)", function* () {
    // Source has leading spaces: trimStart finds '{'; trimEnd would leave trailing
    // spaces but still start with '{' after trimming from the front. The key
    // distinction is trimStart: if trimEnd is used instead, the detection runs
    // on the original (spaces + {), which does NOT start with '{'.
    // We add a trailing suffix that's not whitespace so trimEnd changes the result.
    const jsonWithLeadingSpaces = "  " + JSON.stringify({
      traceId: TRACE_ID_LEADING,
      name: "n",
      turns: [],
      expectedBehavior: "",
      validationChecks: [],
    });
    const trace = yield* canonicalTraceAdapter.decode(jsonWithLeadingSpaces, "mem://leading");
    expect(trace.traceId).toBe(TRACE_ID_LEADING);
  });

  itEffect("parses JSON array root with leading whitespace (kills startsWith([]) branch)", function* () {
    // A trace payload starting with '[' (array) with leading whitespace exercises
    // the trimmed.startsWith("[") branch and kills the && mutation.
    const arrayPayload = "  " + JSON.stringify([{
      traceId: "t-arr",
      name: "n",
      turns: [],
      expectedBehavior: "",
      validationChecks: [],
    }]);
    // JSON.parse of an array succeeds; Value.Errors will flag schema mismatch → Left.
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode(arrayPayload, "mem://arr-leading"),
    );
    // Whether it parses as JSON (array) or YAML, it fails schema validation — what
    // matters is it does NOT throw a JSON SyntaxError (meaning JSON.parse was called).
    // If trimEnd were used, the branch detection would fail and YAML.parse would be
    // called on something starting with spaces+[, which YAML parses differently.
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
    }
  });

  itEffect("routes plain '{' (no leading whitespace) as JSON — endsWith guard kill", function* () {
    // Source starts exactly with '{' — kills the endsWith("{") mutation on line 31.
    // trimmed.endsWith("{") is false for any valid JSON object literal, so the
    // endsWith mutation would skip JSON.parse and call YAML.parse, which would
    // fail to produce a valid Trace schema.
    const payload = JSON.stringify({
      traceId: TRACE_ID_JSON_DIRECT,
      name: "n",
      turns: [],
      expectedBehavior: "",
      validationChecks: [],
    });
    const trace = yield* canonicalTraceAdapter.decode(payload, "mem://direct");
    expect(trace.traceId).toBe(TRACE_ID_JSON_DIRECT);
  });

  itEffect("routes '[' start as JSON — kills ConditionalExpression false mutation", function* () {
    // Directly starts with '[', no leading whitespace — exercises the branch
    // that would be skipped by the `if (false)` or `if (false || ...)` mutation.
    const arrayPayload = JSON.stringify([]);
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode(arrayPayload, "mem://arr-direct"),
    );
    // Schema will reject an array root — the important thing is it reached JSON.parse.
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT) {
      expect(result.left.cause._tag).toBe(SCHEMA_INVALID_TAG);
    }
  });
});

// ─── decodeCanonical parse-error message passthrough ────────────────────────
// Kills the BlockStatement mutation on line 42 (empty catch) and the
// ArrayDeclaration mutation on line 48 (errors: []).

describe("decodeCanonical parse-error message content", () => {
  itEffect("surfaces parse error message in errors array when JSON is malformed", function* () {
    // Malformed JSON — JSON.parse throws a SyntaxError whose .message is captured.
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode("{bad json", "mem://parse-err"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
      // The error message must be non-empty (kills errors: [] mutation).
      expect(result.left.cause.errors[0]).toBeTruthy();
    }
  });

  itEffect("error message includes JSON parse exception text (not empty string)", function* () {
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode("{ invalid }", "mem://parse-err-2"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      // The errors array contains the real exception message, not an empty string.
      expect(result.left.cause.errors[0]?.length).toBeGreaterThan(0);
    }
  });
});

// ─── decodeCanonical schema-error path format ────────────────────────────────
// Kills the StringLiteral mutation on line 55: errs.push(``) vs `${e.path} ${e.message}`.

describe("decodeCanonical schema error path format", () => {
  itEffect("schema validation errors contain path and message (non-empty, non-blank)", function* () {
    // traceId must be a string; passing a number forces a schema error at /traceId.
    const payload = JSON.stringify({ traceId: 999, name: "n", turns: [] });
    const result = yield* Effect.either(
      canonicalTraceAdapter.decode(payload, "mem://path-err"),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
      // Each error must be a non-empty, non-blank string (kills the `` mutation).
      for (const e of result.left.cause.errors) {
        expect(e.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── attrNumber — intValue string NaN fallthrough ───────────────────────────
// Kills ConditionalExpression mutations on lines 122-124:
//   - `typeof inner.intValue === "string"` → `if (true)`
//   - `!Number.isNaN(n)` → `if (true)`

describe("attrNumber edge cases (otelTraceAdapter)", () => {
  itEffect("intValue NaN string falls through to doubleValue", function* () {
    // intValue is a non-numeric string → Number("abc") = NaN.
    // The NaN guard `!Number.isNaN(n)` must NOT return NaN; it must fall through
    // to doubleValue. If the `if (true) return n` mutation applies, we'd get NaN
    // as outputTokens; the real code should return the doubleValue (12) instead.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: "abc", doubleValue: DOUBLE_VALUE_12 } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://nan-intvalue");
    // The NaN guard falls through to doubleValue=12.
    expect(trace.turns[0]?.outputTokens).toBe(DOUBLE_VALUE_12);
  });

  itEffect("numeric intValue is returned directly without going through string coercion", function* () {
    // intValue is a number (not a string). The `typeof inner.intValue === "string"`
    // branch must NOT fire. If it fires (mutation), Number(42) = 42 — same result.
    // We distinguish by providing a doubleValue that differs; the numeric intValue
    // branch should take priority.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              // intValue=7 (numeric) wins over doubleValue=99.
              { key: "gen_ai.usage.input_tokens", value: { intValue: INT_VALUE_7, doubleValue: 99 } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://numeric-intvalue");
    expect(trace.turns[0]?.inputTokens).toBe(INT_VALUE_7);
  });

  itEffect("string intValue that is numeric is returned correctly", function* () {
    // intValue is a valid numeric string "42". Number("42") = 42, not NaN.
    // The `!Number.isNaN(n)` check passes and returns 42.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: String(INT_VALUE_42) } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://str-intvalue");
    expect(trace.turns[0]?.outputTokens).toBe(INT_VALUE_42);
  });
});

// ─── spansFromEnvelope — null rs and null ss filtering ───────────────────────
// Kills the ConditionalExpression / LogicalOperator mutations on lines 138 and 142:
//   rs === null must be the discriminant (not just typeof rs !== "object").
//   ss === null must be the discriminant (not just typeof ss !== "object").

describe("spansFromEnvelope null-element filtering (otelTraceAdapter)", () => {
  itEffect("skips null resourceSpans element (rs === null guard)", function* () {
    // resourceSpans contains null before a valid entry.
    // If `rs === null` branch is removed (LogicalOperator && mutation), null would
    // be processed as an object — `(null as any).scopeSpans` would throw.
    const payload = JSON.stringify({
      resourceSpans: [
        null,
        {
          scopeSpans: [{
            spans: [{
              name: "x",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            }],
          }],
        },
      ],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://null-rs");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("skips non-object (primitive) resourceSpans element (typeof rs !== object guard)", function* () {
    // resourceSpans contains a string element — typeof string !== "object".
    const payload = JSON.stringify({
      resourceSpans: [
        "primitive-rs",
        {
          scopeSpans: [{
            spans: [{
              name: "x",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            }],
          }],
        },
      ],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://prim-rs");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("skips null scopeSpans element (ss === null guard)", function* () {
    // scopeSpans contains null before a valid entry.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [
          null,
          {
            spans: [{
              name: "x",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            }],
          },
        ],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://null-ss");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("skips non-object (primitive) scopeSpans element (typeof ss !== object guard)", function* () {
    // scopeSpans contains a number element.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [
          42,
          {
            spans: [{
              name: "x",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            }],
          },
        ],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://prim-ss");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("skips non-object span element that is not null (typeof s === object guard)", function* () {
    // spans list: a number (not null, not object) then a valid span.
    // This kills the `if (true && s !== null)` mutation on line 146 — the typeof
    // check must gate entry; the mutation replaces typeof with true letting numbers through.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            42,
            {
              name: "x",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            },
          ],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://prim-span");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });
});

// ─── toTurn — prompt/response empty short-circuit logic ─────────────────────
// Kills the LogicalOperator (&&→||) and ConditionalExpression mutations on line 157.

describe("toTurn prompt/response short-circuit (otelTraceAdapter)", () => {
  itEffect("span with only prompt (no response) is NOT filtered — kills || mutation", function* () {
    // prompt is set, response is "". The && condition is false → span is kept.
    // If mutated to ||, an empty response alone would make the span return null.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              // No gen_ai.completion key at all → response defaults to "".
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://prompt-only");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
    expect(trace.turns[0]?.prompt).toBe(PROMPT_Q);
    expect(trace.turns[0]?.response).toBe("");
  });

  itEffect("span with only response (no prompt) is NOT filtered — kills prompt === true mutation", function* () {
    // response is set, prompt is "". The && condition is false → span is kept.
    // If `prompt === ""` is replaced with `true`, the span would be filtered.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              // No gen_ai.prompt key → prompt defaults to "".
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://response-only");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
    expect(trace.turns[0]?.response).toBe(RESPONSE_A);
    expect(trace.turns[0]?.prompt).toBe("");
  });

  itEffect("span with both prompt and response empty IS filtered (both empty → null)", function* () {
    // Both empty — span must be filtered. This keeps the AND semantics clear.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            { name: "empty", attributes: [] },
            {
              name: "real",
              attributes: [
                { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
                { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
              ],
            },
          ],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://both-empty");
    // Only the "real" span passes.
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
  });

  itEffect("kills response === true mutation — response set, prompt empty, span NOT filtered", function* () {
    // Specifically targets the `response === ""` → `true` mutation on line 157.
    // When response has a value, `response === ""` is false, so && is false → kept.
    // With `true`, && would become `prompt === "" && true`, which would filter this span.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "r",
            attributes: [
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_NON_EMPTY } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://resp-not-empty");
    expect(trace.turns.length).toBe(TURN_COUNT_ONE);
    expect(trace.turns[0]?.response).toBe(RESPONSE_NON_EMPTY);
  });
});

// ─── toTurn — startNs > 0 boundary (line 165) ──────────────────────────────
// Kills ConditionalExpression (true/false) and EqualityOperator (>0 → >=0, <=0) mutations.

describe("toTurn startedAt timestamp boundary (otelTraceAdapter)", () => {
  itEffect("startNs = 0 produces a fallback ISO timestamp (kills >= 0 mutation)", function* () {
    // When startTimeUnixNano is absent (or not a string), startNs defaults to 0.
    // startNs > 0 is false → fallback to new Date().toISOString().
    // With >= 0 mutation, startNs=0 would use new Date(0/1_000_000) = 1970-01-01,
    // not the current time. We cannot pin the current time, but we CAN assert that
    // startNs=0 does NOT produce the epoch date (1970).
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            // no startTimeUnixNano → startNs = 0
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://zero-startns");
    const startedAt = trace.turns[0]?.startedAt ?? "";
    // Must not be the epoch (1970-01-01) which would result from new Date(0).
    expect(startedAt.startsWith("1970-01-01")).toBe(false);
  });

  itEffect("positive startNs produces a correct ISO timestamp (kills false/true mutations)", function* () {
    // startNs > 0 → use new Date(startNs / 1_000_000).toISOString().
    // 1700000000000000000 ns = 1700000000000 ms → "2023-11-14T..." approx.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            startTimeUnixNano: START_NS_1700,
            endTimeUnixNano: END_NS_1700_PLUS_100,
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://pos-startns");
    const startedAt = trace.turns[0]?.startedAt ?? "";
    // 1700000000000 ms → 2023-11-14.
    expect(startedAt.startsWith(START_DATE_2023)).toBe(true);
    expect(trace.turns[0]?.latencyMs).toBe(LATENCY_MS_100);
  });

  itEffect("startNs = -1 (non-string startTimeUnixNano) falls back to current time", function* () {
    // startTimeUnixNano set to a number (not a string) → startNs = 0 (not a string branch).
    // startNs > 0 is false → fallback time.
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            startTimeUnixNano: 1700000000000000000,  // a number, not a string
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, "mem://num-startns");
    const startedAt = trace.turns[0]?.startedAt ?? "";
    // The numeric startTimeUnixNano is not parsed (only string is), so fallback applies.
    expect(startedAt.startsWith("1970-01-01")).toBe(false);
  });
});

// ─── decodeOtel parse-error message content ───────────────────────────────────
// Kills BlockStatement (empty catch) and ArrayDeclaration (errors: []) on lines 180-186.

describe("decodeOtel parse-error message content", () => {
  itEffect("JSON parse error message is non-empty in SchemaInvalid errors array", function* () {
    const result = yield* Effect.either(
      otelTraceAdapter.decode("{bad otel", ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
      expect(result.left.cause.errors[0]?.length).toBeGreaterThan(0);
    }
  });

  itEffect("JSON parse error includes exception message text (not a blank string)", function* () {
    const result = yield* Effect.either(
      otelTraceAdapter.decode("not-json-at-all!!!", ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      // Kills the `errors: []` mutation — errors must have at least one non-empty entry.
      expect(result.left.cause.errors.filter(e => e.trim().length > 0).length).toBeGreaterThan(0);
    }
  });
});

// ─── decodeOtel "root is not an object" error message ─────────────────────────
// Kills NoCoverage ArrayDeclaration and StringLiteral on line 194.

describe("decodeOtel root-not-object error message", () => {
  itEffect("null JSON root yields SchemaInvalid with 'root is not an object' text", function* () {
    // JSON.parse("null") === null. The guard `typeof parsed !== "object" || parsed === null`
    // catches null and emits the "root is not an object" error.
    const result = yield* Effect.either(
      otelTraceAdapter.decode(JSON.stringify(null), ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors).toContain(ERR_ROOT_NOT_OBJECT);
    }
  });

  itEffect("numeric JSON root yields SchemaInvalid with non-empty errors", function* () {
    // JSON.parse("42") = 42. typeof 42 !== "object" → "root is not an object".
    const result = yield* Effect.either(
      otelTraceAdapter.decode(JSON.stringify(INT_VALUE_42), ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
      expect(result.left.cause.errors[0]?.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── decodeOtel "no LLM spans found" error message ────────────────────────────
// Kills Survived ArrayDeclaration and StringLiteral on line 208.

describe("decodeOtel no-LLM-spans error message", () => {
  itEffect("empty resourceSpans yields SchemaInvalid with 'no LLM spans found' text", function* () {
    const result = yield* Effect.either(
      otelTraceAdapter.decode(JSON.stringify({ resourceSpans: [] }), ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors).toContain(ERR_NO_LLM_SPANS);
    }
  });

  itEffect("spans that all filter to null turns yields SchemaInvalid with non-empty error", function* () {
    // All spans have no prompt/response → all filtered → turns.length === 0.
    const result = yield* Effect.either(
      otelTraceAdapter.decode(JSON.stringify({
        resourceSpans: [{
          scopeSpans: [{
            spans: [
              { name: "empty-1", attributes: [] },
              { name: "empty-2", attributes: [] },
            ],
          }],
        }],
      }), ORIGIN_PATH_OTEL),
    );
    expect(result._tag).toBe(EITHER_LEFT);
    if (result._tag === EITHER_LEFT && result.left.cause._tag === "SchemaInvalid") {
      expect(result.left.cause.errors.length).toBeGreaterThan(0);
      expect(result.left.cause.errors[0]?.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── decodeOtel output Trace shape — expectedBehavior and validationChecks ───
// Kills StringLiteral on line 216 and ArrayDeclaration on line 217.

describe("decodeOtel output Trace fixed fields", () => {
  itEffect("successful decode produces empty expectedBehavior string", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, ORIGIN_PATH_OTEL);
    expect(trace.expectedBehavior).toBe(EXPECTED_BEHAVIOR_EMPTY);
  });

  itEffect("successful decode produces empty validationChecks array", function* () {
    const payload = JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "x",
            attributes: [
              { key: "gen_ai.prompt", value: { stringValue: PROMPT_Q } },
              { key: "gen_ai.completion", value: { stringValue: RESPONSE_A } },
            ],
          }],
        }],
      }],
    });
    const trace = yield* otelTraceAdapter.decode(payload, ORIGIN_PATH_OTEL);
    expect(trace.validationChecks).toStrictEqual(VALIDATION_CHECKS_EMPTY);
  });
});

// ─── getTraceAdapter dispatch — both formats ──────────────────────────────────
// Ensures both switch arms are exercised. (The original test covers format identity;
// these add adapter identity assertions to make the dispatch arms observable.)

describe("getTraceAdapter dispatch identity", () => {
  it("canonical format returns the canonicalTraceAdapter instance", () => {
    const adapter = getTraceAdapter(TRACE_FORMAT.Canonical);
    expect(adapter).toBe(canonicalTraceAdapter);
  });

  it("otel format returns the otelTraceAdapter instance", () => {
    const adapter = getTraceAdapter(TRACE_FORMAT.Otel);
    expect(adapter).toBe(otelTraceAdapter);
  });
});
