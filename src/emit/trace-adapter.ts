// Trace format adapters: convert external trace formats into the canonical cc-judge Trace.
// Spec Q-ONLINE-1 (A): canonical Trace + adapters. OTel adapter shipped in v1.
// Invariant #6: unparseable traces fold into a critical-severity RunRecord; never crash the pipeline.

import type { Effect } from "effect";
import type { TraceDecodeError } from "../core/errors.js";
import type { Trace } from "../core/schema.js";

export type TraceFormat = "canonical" | "otel";

export interface TraceAdapter {
  readonly format: TraceFormat;
  decode(source: string, originPath: string): Effect.Effect<Trace, TraceDecodeError, never>;
}

export declare const canonicalTraceAdapter: TraceAdapter;
export declare const otelTraceAdapter: TraceAdapter;

// Dispatch table keyed by --trace-format. Implement-staff wires the concrete adapters.
export declare function getTraceAdapter(format: TraceFormat): TraceAdapter;
