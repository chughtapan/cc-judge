// Trace format adapters: convert external trace formats into the canonical cc-judge Trace.
// Spec Q-ONLINE-1 (A): canonical Trace + adapters. OTel adapter shipped in v1.
// Invariant #6: unparseable traces fold into a critical-severity RunRecord upstream;
// at this layer we only fail with TraceDecodeError.

import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import * as YAML from "yaml";
import { TraceDecodeError } from "../core/errors.js";
import { TraceSchema, type Trace } from "../core/schema.js";
import { TraceId, ScenarioId, type Turn } from "../core/types.js";

export type TraceFormat = "canonical" | "otel";

export const TRACE_FORMAT = {
  Canonical: "canonical",
  Otel: "otel",
} as const satisfies Record<string, TraceFormat>;

export interface TraceAdapter {
  readonly format: TraceFormat;
  decode(source: string, originPath: string): Effect.Effect<Trace, TraceDecodeError, never>;
}

// -------------------- canonical --------------------
// Accepts either YAML or JSON matching TraceSchema. The loader picks a format
// by extension; here we try JSON first then YAML.

function parseEither(source: string): unknown {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(source);
  }
  return YAML.parse(source);
}

function decodeCanonical(source: string, originPath: string): Effect.Effect<Trace, TraceDecodeError, never> {
  return Effect.suspend(() => {
    let parsed: unknown;
    try {
      parsed = parseEither(source);
    } catch (err) {
      return Effect.fail(
        new TraceDecodeError({
          cause: {
            _tag: "SchemaInvalid",
            path: originPath,
            errors: [err instanceof Error ? err.message : String(err)],
          },
        }),
      );
    }
    const errs: string[] = [];
    for (const e of Value.Errors(TraceSchema, parsed)) {
      errs.push(`${e.path} ${e.message}`);
    }
    if (errs.length > 0) {
      return Effect.fail(
        new TraceDecodeError({ cause: { _tag: "SchemaInvalid", path: originPath, errors: errs } }),
      );
    }
    const decoded = Value.Decode(TraceSchema, parsed);
    const { scenarioId: rawScenarioId, traceId: rawTraceId, ...rest } = decoded;
    const base: Trace = {
      ...rest,
      traceId: TraceId(rawTraceId),
    };
    const trace: Trace = rawScenarioId !== undefined
      ? { ...base, scenarioId: ScenarioId(rawScenarioId) }
      : base;
    return Effect.succeed(trace);
  });
}

export const canonicalTraceAdapter: TraceAdapter = {
  format: TRACE_FORMAT.Canonical,
  decode: decodeCanonical,
};

// -------------------- otel --------------------
// Minimal OTel → canonical: each LLM span becomes a Turn. We accept the
// "resourceSpans" envelope emitted by the OpenTelemetry JSON exporter and
// look for spans with `gen_ai.system` attributes. Anything unrecognized fails
// SchemaInvalid — upstream folds it into a critical RunRecord.

interface OtelKeyValue {
  readonly key?: unknown;
  readonly value?: unknown;
}

interface OtelSpan {
  readonly name?: unknown;
  readonly startTimeUnixNano?: unknown;
  readonly endTimeUnixNano?: unknown;
  readonly attributes?: unknown;
}

interface OtelEnvelope {
  readonly resourceSpans?: unknown;
}

function attrString(attrs: ReadonlyArray<OtelKeyValue>, key: string): string | undefined {
  for (const kv of attrs) {
    if (kv.key === key) {
      const v = kv.value;
      if (typeof v === "object" && v !== null) {
        const inner: { stringValue?: unknown } = v;
        if (typeof inner.stringValue === "string") return inner.stringValue;
      }
    }
  }
  return undefined;
}

function attrNumber(attrs: ReadonlyArray<OtelKeyValue>, key: string): number | undefined {
  for (const kv of attrs) {
    if (kv.key === key) {
      const v = kv.value;
      if (typeof v === "object" && v !== null) {
        const inner: { intValue?: unknown; doubleValue?: unknown } = v;
        if (typeof inner.intValue === "number") return inner.intValue;
        if (typeof inner.intValue === "string") {
          const n = Number(inner.intValue);
          if (!Number.isNaN(n)) return n;
        }
        if (typeof inner.doubleValue === "number") return inner.doubleValue;
      }
    }
  }
  return undefined;
}

function spansFromEnvelope(env: OtelEnvelope): ReadonlyArray<OtelSpan> {
  const out: OtelSpan[] = [];
  const resourceSpans = env.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    if (typeof rs !== "object" || rs === null) continue;
    const scopeSpans = (rs as { scopeSpans?: unknown }).scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      if (typeof ss !== "object" || ss === null) continue;
      const spans = (ss as { spans?: unknown }).spans;
      if (!Array.isArray(spans)) continue;
      for (const s of spans) {
        if (typeof s === "object" && s !== null) out.push(s);
      }
    }
  }
  return out;
}

function toTurn(span: OtelSpan, index: number): Turn | null {
  const attrs: ReadonlyArray<OtelKeyValue> = Array.isArray(span.attributes) ? span.attributes : [];
  const prompt = attrString(attrs, "gen_ai.prompt") ?? attrString(attrs, "input") ?? "";
  const response = attrString(attrs, "gen_ai.completion") ?? attrString(attrs, "output") ?? "";
  if (prompt === "" && response === "") return null;
  const startNs = typeof span.startTimeUnixNano === "string" ? Number(span.startTimeUnixNano) : 0;
  const endNs = typeof span.endTimeUnixNano === "string" ? Number(span.endTimeUnixNano) : startNs;
  const latencyMs = Math.max(0, Math.round((endNs - startNs) / 1_000_000));
  return {
    index,
    prompt,
    response,
    startedAt: startNs > 0 ? new Date(startNs / 1_000_000).toISOString() : new Date().toISOString(),
    latencyMs,
    toolCallCount: attrNumber(attrs, "gen_ai.tool_call_count") ?? 0,
    inputTokens: attrNumber(attrs, "gen_ai.usage.input_tokens") ?? 0,
    outputTokens: attrNumber(attrs, "gen_ai.usage.output_tokens") ?? 0,
    cacheReadTokens: attrNumber(attrs, "gen_ai.usage.cache_read_input_tokens") ?? 0,
    cacheWriteTokens: attrNumber(attrs, "gen_ai.usage.cache_creation_input_tokens") ?? 0,
  };
}

function decodeOtel(source: string, originPath: string): Effect.Effect<Trace, TraceDecodeError, never> {
  return Effect.suspend(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (err) {
      return Effect.fail(
        new TraceDecodeError({
          cause: {
            _tag: "SchemaInvalid",
            path: originPath,
            errors: [err instanceof Error ? err.message : String(err)],
          },
        }),
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      return Effect.fail(
        new TraceDecodeError({
          cause: { _tag: "SchemaInvalid", path: originPath, errors: ["root is not an object"] },
        }),
      );
    }
    const envelope: OtelEnvelope = parsed;
    const spans = spansFromEnvelope(envelope);
    const turns: Turn[] = [];
    for (const s of spans) {
      const t = toTurn(s, turns.length);
      if (t !== null) turns.push(t);
    }
    if (turns.length === 0) {
      return Effect.fail(
        new TraceDecodeError({
          cause: { _tag: "SchemaInvalid", path: originPath, errors: ["no LLM spans found"] },
        }),
      );
    }
    const trace: Trace = {
      traceId: TraceId(originPath),
      name: originPath,
      turns,
      expectedBehavior: "",
      validationChecks: [],
    };
    return Effect.succeed(trace);
  });
}

export const otelTraceAdapter: TraceAdapter = {
  format: TRACE_FORMAT.Otel,
  decode: decodeOtel,
};

export function getTraceAdapter(format: TraceFormat): TraceAdapter {
  switch (format) {
    case TRACE_FORMAT.Canonical:
      return canonicalTraceAdapter;
    case TRACE_FORMAT.Otel:
      return otelTraceAdapter;
  }
}
