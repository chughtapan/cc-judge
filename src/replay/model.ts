// Shared P-model input contract and event registry.
//
// Responsibility: define the single interface a consumer passes in to (a) point
// the shared substrate at a P project, (b) declare the consumer's
// game-specific event vocabulary (schema + tag + P-renderer) without modifying
// any cc-judge code, and (c) identify the entry test-case the checker runs.
//
// Extension mechanism is a *registry* object — not dynamic imports, not
// plugins-as-filesystem. Consumers construct an `EventRegistry<TEv>` at build
// time and hand it to `analyzeRun()` (see `./pipeline.ts`). This keeps the
// substrate free of any hardcoded list of event tags while remaining typed
// end-to-end over `TEv`.
//
// Principle 2: every event declares a TypeBox schema; the ingestor / extractor
// validate at the boundary. Inside the substrate, `event: TEv` is a truth.

import type { Brand } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type { AtomicObservationBase, JsonValue } from "./observation.js";
import { notImplemented } from "./_stub.js";

// ---------- Branded paths ----------

/** Absolute path to a P project root (the directory containing `.pproj`). */
export type PProjectDir = string & Brand.Brand<"PProjectDir">;

/** Name of the test-case to run (e.g. `tcWerewolfParam`). */
export type PTestCaseName = string & Brand.Brand<"PTestCaseName">;

/** Name of the generated `.p` testcase file the extractor writes events into
 *  (e.g. `ReplayFromNdjson.generated.p`). Kept branded so consumers can't
 *  confuse this with a human-authored source file. */
export type PGeneratedReplayFile = string & Brand.Brand<"PGeneratedReplayFile">;

// ---------- Event registry (consumer extension point) ----------

/** One entry per consumer event tag. Provides:
 *  - `schema`: TypeBox schema for runtime validation (Principle 2).
 *  - `description`: human-readable prompt hint for the LLM extractor.
 *  - `renderPEvent`: pure projection from a validated event value to the P
 *    call-site syntax emitted into the generated replay file. The function's
 *    body is a pure string-formatter; it is declared here but implemented
 *    per-tag by the consumer. cc-judge never parses P syntax. */
export interface EventDescriptor<T extends AtomicObservationBase> {
  readonly tag: T["_tag"];
  readonly schema: TSchema;
  readonly description: string;
  renderPEvent(value: T): PEventCallSite;
}

/** The string the substrate writes into the generated `.p` file when it
 *  encounters an observation of the corresponding tag. Kept branded so
 *  callers cannot pass a free-form string here (Principle 1). */
export type PEventCallSite = string & Brand.Brand<"PEventCallSite">;

/** Closed registry over the consumer's event union. Exhaustiveness over `TEv`
 *  is enforced by `mapped` being keyed by `TEv["_tag"]`, not `string`. */
export interface EventRegistry<TEv extends AtomicObservationBase> {
  readonly mapped: { readonly [K in TEv["_tag"]]: EventDescriptor<Extract<TEv, { readonly _tag: K }>> };
  /** How this consumer maps the shared `EtTraceEnded` reason enum onto its own
   *  P-side terminal event signature. Required; the substrate does not guess. */
  readonly renderTraceEnded: (reason: string, details: ReadonlyRecord<string, JsonValue>) => PEventCallSite;
}

type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };

// ---------- P project input ----------

/** The full bundle a consumer hands to `analyzeRun()`. Everything the checker
 *  invocation needs to compile, instantiate, and run the model against an
 *  observation stream is named here. No other input is read from disk by
 *  cc-judge (Invariant 1: raw bundles are immutable). */
export interface PModelInput<TEv extends AtomicObservationBase> {
  readonly project: PProjectDir;
  readonly testcase: PTestCaseName;
  /** Relative path within `project` where the substrate will write the
   *  generated replay testcase. Typically `PTst/ReplayFromNdjson.generated.p`. */
  readonly generatedReplayPath: PGeneratedReplayFile;
  readonly registry: EventRegistry<TEv>;
  /** Extra P-compiler flags, pinned per-consumer. No global state inside the
   *  substrate — all invocation parameters come through here. */
  readonly compileFlags?: ReadonlyArray<string>;
  /** Extra `p check` flags (e.g. `-s 200`). Same rationale. */
  readonly checkFlags?: ReadonlyArray<string>;
}

/** Descriptor uniquely identifying a model+registry combination. Used as part
 *  of the analysis manifest (Q3 open question resolution): re-analysis of a
 *  bundle after a model upgrade stamps both old and new descriptor hashes. */
export interface ModelDescriptor {
  readonly projectDigest: ModelDigest;
  readonly registryDigest: ModelDigest;
}

export type ModelDigest = string & Brand.Brand<"ModelDigest">;

// ---------- Stubs ----------

/** Build an `EventRegistry` from a flat array of descriptors. Fails at
 *  construction time if tag collision is detected — Principle 4: the
 *  registry is a closed, exhaustive map. */
export function buildEventRegistry<TEv extends AtomicObservationBase>(
  _descriptors: ReadonlyArray<EventDescriptor<TEv>>,
  _renderTraceEnded: EventRegistry<TEv>["renderTraceEnded"],
): EventRegistry<TEv> {
  return notImplemented("model");
}

/** Compute the stable digest pair that identifies this `PModelInput`.
 *  Deterministic across machines; used to populate the re-analysis manifest. */
export function computeModelDescriptor<TEv extends AtomicObservationBase>(
  _input: PModelInput<TEv>,
): ModelDescriptor {
  return notImplemented("model");
}

/** Validate that a `PModelInput` is well-formed on the filesystem. Does NOT
 *  compile the project — that is the checker's job. Returns an exhaustive
 *  discriminated result rather than throwing (Principle 3). */
export function validatePModelInput<TEv extends AtomicObservationBase>(
  _input: PModelInput<TEv>,
): ModelValidationResult {
  return notImplemented("model");
}

/** Discriminated result for `validatePModelInput`. Closed union — every
 *  branch names the evidence a caller needs. */
export type ModelValidationResult =
  | { readonly _tag: "Valid" }
  | { readonly _tag: "ProjectMissing"; readonly path: PProjectDir }
  | { readonly _tag: "PProjFileMissing"; readonly path: PProjectDir }
  | { readonly _tag: "GeneratedReplayPathOutsideProject"; readonly relPath: PGeneratedReplayFile }
  | { readonly _tag: "RegistryEmpty" }
  | { readonly _tag: "RegistryTagCollision"; readonly tag: string };
