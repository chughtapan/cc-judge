// Shared atomic observation substrate.
//
// Responsibility: define the typed container every consumer's P event flows through,
// the ingestion adapter a consumer supplies to mount its run-directory layout,
// the LLM-backed extractor scaffold that turns raw chunks into typed observations,
// and the extraction-gap surface (typed `EtUnknown` + run-level artifact).
//
// What lives here is universal to P-replay: provenance, ordering, gap handling,
// and the structural terminal event (`eTraceEnded`). What does NOT live here is
// any game-specific event tag, schema, or interpretation — those are supplied
// by the consumer via `./model.ts` event registration.
//
// Principle 1: branded ids prevent cross-confusion.
// Principle 3: every public function returns `Effect<_, TaggedError, _>`.
// Principle 4: every discriminated union is closed; the consumer extends via
// the `TEv` type parameter, not by widening our tags.

import type { Effect, Brand } from "effect";
import { notImplemented } from "./_stub.js";

// ---------- Branded identifiers ----------

/** Unique id assigned to one run/bundle under analysis. */
export type RunDirPath = string & Brand.Brand<"RunDirPath">;

/** Monotone ordering key within a single run. Typed so consumers cannot
 *  accidentally compare orderings across runs. */
export type ObservationOrder = number & Brand.Brand<"ObservationOrder">;

/** Version hash of the extractor + event registry used to produce a
 *  particular observation set. Stamped on artifacts so re-analysis is
 *  auditable (Invariant 2 + Q3 open). */
export type ExtractionVersion = string & Brand.Brand<"ExtractionVersion">;

// ---------- Provenance ----------

/** Every atomic observation points back to concrete evidence.
 *  `path` is resolved relative to the consumer's run directory root. */
export interface ObservationProvenance {
  readonly path: string;
  readonly line: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

// ---------- Raw ingestion (consumer-supplied adapter) ----------

/** A raw chunk handed to the extractor. Opaque text plus metadata; the shape
 *  of the underlying file is the consumer's business. The extractor never
 *  parses `content` structurally — it hands it to the LLM as input. */
export interface RawObservationChunk {
  readonly provenance: ObservationProvenance;
  readonly content: string;
  readonly contentType: RawChunkContentType;
  readonly hints?: RawChunkHints;
}

/** Closed set of content categories the extractor knows how to prompt for.
 *  Consumers classify their raw chunks into one of these; category-specific
 *  prompting is then handled by the extractor. */
export type RawChunkContentType =
  | "bundle-json"
  | "trace-json"
  | "agent-log-stdout"
  | "agent-log-stderr"
  | "phase-ndjson"
  | "freeform-text";

/** Optional hints a consumer's `BundleIngestor` can pass to bias extraction.
 *  Purely additive; extractor may ignore. Kept narrow on purpose — richer
 *  hints escalate back to the consumer's ingestor, not to a widening here. */
export interface RawChunkHints {
  readonly expectedPhase?: string;
  readonly expectedActors?: ReadonlyArray<string>;
}

/** Consumer-supplied adapter that resolves a run directory into the raw
 *  chunks the extractor will read. cc-judge does NOT hardcode any file layout;
 *  the consumer contributes this implementation.
 *
 *  Principle 2: ingestor is responsible for schema-validating any structured
 *  artifact (e.g., a `bundle.json`) before emitting it as a chunk. */
export interface BundleIngestor {
  readonly name: string;
  ingest(runDir: RunDirPath): Effect.Effect<BundleIngestResult, IngestionError, never>;
}

/** Result of an ingestion pass. `missingOptional` is the first signal feeding
 *  the extraction-gap artifact: files the ingestor expected but could not find. */
export interface BundleIngestResult {
  readonly runDir: RunDirPath;
  readonly chunks: ReadonlyArray<RawObservationChunk>;
  readonly missingOptional: ReadonlyArray<MissingArtifact>;
}

export interface MissingArtifact {
  readonly relPath: string;
  readonly reason: MissingReason;
}

export type MissingReason =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unreadable"; readonly message: string };

// ---------- Atomic observation (typed over consumer event union) ----------

/** Base contract every consumer event must satisfy: a `_tag` discriminant.
 *  Consumers declare their game-specific union of events and pass it as `TEv`. */
export interface AtomicObservationBase {
  readonly _tag: string;
}

/** Carrier type. Generic over `TEv` so cc-judge code remains consumer-agnostic.
 *  `order` is monotone within the run (ties broken by `provenance.byteStart`).
 *  `extractedBy` records the (extractor-version, model) pair that produced it
 *  — required for the re-analysis manifest (Q3 resolution). */
export interface AtomicObservation<TEv extends AtomicObservationBase> {
  readonly order: ObservationOrder;
  readonly event: TEv | EtUnknown | EtTraceEnded;
  readonly provenance: ObservationProvenance;
  readonly extractedBy: ExtractionVersion;
}

// ---------- Shared base events (every consumer gets these) ----------

/** Extraction-gap marker. Emitted in-line wherever the extractor saw a raw
 *  chunk it could not map into any registered consumer event. Carries enough
 *  evidence for the operator to teach the extractor later. Never silently
 *  dropped — v2 spec Q4 resolution makes this plus the run-level artifact
 *  mandatory. */
export interface EtUnknown {
  readonly _tag: "EtUnknown";
  readonly reasonHint: EtUnknownReason;
  readonly rawExcerpt: string;
}

export type EtUnknownReason =
  | { readonly _tag: "NoSchemaMatch" }
  | { readonly _tag: "AmbiguousMultiMatch"; readonly candidateTags: ReadonlyArray<string> }
  | { readonly _tag: "LlmLowConfidence"; readonly confidence: number }
  | { readonly _tag: "ExtractorError"; readonly message: string };

/** Shared terminal observation. EVERY trace ends with exactly one `EtTraceEnded`.
 *  The reason enum is lifecycle-framed (not game-framed) so a future non-Werewolf
 *  consumer can adopt this substrate without game-specific pollution of the base.
 *  Consumer-specific categorization (`no-game-started`, `smoke-only`,
 *  `provider-auth-missing`, etc.) lives in `details`. */
export interface EtTraceEnded {
  readonly _tag: "EtTraceEnded";
  readonly reason: EtTraceEndedReason;
  readonly details: ReadonlyRecord<string, JsonValue>;
}

export type EtTraceEndedReason =
  | "observed-complete"
  | "observation-truncated"
  | "never-started"
  | "extraction-failed"
  | "unknown";

/** Narrow `JsonValue` used in consumer-extensible fields (avoids `any` and
 *  `Record<string, unknown>` on the public surface — Principle 2). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };

/** Read-only map alias kept narrow on purpose. */
export type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };

// ---------- Extractor (LLM-backed, consumer-registry driven) ----------

/** Contract the shared substrate provides. The implementation in cc-judge#99
 *  is LLM-backed: it reads each `RawObservationChunk`, prompts a model against
 *  the consumer's event registry, and produces candidate atomic observations.
 *  Deterministic post-processing (ordering, dedup, provenance stamping, gap
 *  insertion) is part of the implementation contract named here.
 *
 *  `R` is `LlmJudge` — supplied via Effect Layer by `./pipeline.ts` when the
 *  CLI or SDK caller provides a judge backend. cc-judge does not assume a
 *  specific model vendor on this interface. */
export interface ObservationExtractor<TEv extends AtomicObservationBase> {
  extract(
    input: ExtractorInput<TEv>,
  ): Effect.Effect<ExtractorOutput<TEv>, ExtractionError, LlmJudge>;
}

/** Input bundle: the ingested chunks plus the consumer event registry that
 *  tells the extractor which tags are legal. */
export interface ExtractorInput<TEv extends AtomicObservationBase> {
  readonly runDir: RunDirPath;
  readonly chunks: ReadonlyArray<RawObservationChunk>;
  readonly registry: import("./model.js").EventRegistry<TEv>;
  readonly version: ExtractionVersion;
}

/** Output bundle: the ordered observation stream (with in-line `EtUnknown`
 *  and a terminal `EtTraceEnded`), plus the run-level extraction-gap artifact.
 *  Both artifacts are always emitted (v2 Q4: mandatory both, never either/or). */
export interface ExtractorOutput<TEv extends AtomicObservationBase> {
  readonly observations: ReadonlyArray<AtomicObservation<TEv>>;
  readonly gaps: ExtractionGapArtifact;
}

/** Run-level summary. One row per unmapped raw chunk. The operator uses this
 *  to prioritize which schemas to add to the registry next. */
export interface ExtractionGapArtifact {
  readonly runDir: RunDirPath;
  readonly version: ExtractionVersion;
  readonly entries: ReadonlyArray<ExtractionGapEntry>;
}

export interface ExtractionGapEntry {
  readonly provenance: ObservationProvenance;
  readonly reasonHint: EtUnknownReason;
  readonly rawExcerpt: string;
  readonly suggestedTag?: string;
}

/** Marker for the LLM-judge dependency on the Effect context. Concrete
 *  implementation is supplied by the consumer via cc-judge's existing
 *  `JudgeBackend` Layer (see `src/judge/index.ts`). Kept as a phantom tag here
 *  to avoid a circular import into the replay substrate. */
export interface LlmJudge {
  readonly _tag: "LlmJudge";
}

// ---------- Errors (Principle 3: typed, exhaustive) ----------

export type IngestionError =
  | {
      readonly _tag: "IngestionFailure";
      readonly runDir: RunDirPath;
      readonly cause: IngestionFailureCause;
    };

export type IngestionFailureCause =
  | { readonly _tag: "RunDirMissing" }
  | { readonly _tag: "RequiredArtifactMissing"; readonly relPath: string }
  | { readonly _tag: "ArtifactSchemaInvalid"; readonly relPath: string; readonly errors: ReadonlyArray<string> }
  | { readonly _tag: "AdapterError"; readonly message: string };

export type ExtractionError =
  | { readonly _tag: "EmptyCorpus"; readonly runDir: RunDirPath }
  | { readonly _tag: "LlmUnavailable"; readonly message: string }
  | { readonly _tag: "TerminalEventSynthesisFailed"; readonly message: string };

// ---------- Stubs ----------

/** Factory for the shared LLM-backed extractor. The implementation at cc-judge#99
 *  will construct a deterministic post-processor around the LLM call. */
export function createObservationExtractor<TEv extends AtomicObservationBase>(
  _opts: ExtractorOptions,
): ObservationExtractor<TEv> {
  return notImplemented("observation");
}

/** Knobs. Kept narrow — expanding this widens the substrate's public surface. */
export interface ExtractorOptions {
  readonly maxChunkBytes: number;
  readonly minAcceptConfidence: number;
  readonly version: ExtractionVersion;
}

/** Synthesizes the terminal `EtTraceEnded` observation from the extractor's
 *  in-line stream. Exported so callers can call it in isolation for testing.
 *  Consumers can override `reason` via custom post-processing before the
 *  observation is handed to the checker. */
export function synthesizeTerminalObservation(
  _stream: ReadonlyArray<AtomicObservation<AtomicObservationBase>>,
  _version: ExtractionVersion,
): AtomicObservation<AtomicObservationBase> {
  return notImplemented("observation");
}
