// Shared diagnosis outputs: JSON + Markdown + CLI summary line.
//
// Responsibility: bundle `CheckerVerdict` + `ExtractionGapArtifact` +
// observation stream into the three reusable output artifacts the v2 spec
// mandates (Q1 resolution), write them through an `ArtifactSink` that
// supports in-run default and `--debug-dir` (Q5 resolution), and emit a
// deterministic-byte-for-byte Markdown report (Q2 recommended default) so
// downstream corpus regression testing at arena#144 is non-flaky.
//
// What does NOT live here: consumer-specific narrative fragments. The Markdown
// renderer is templated over the checker verdict shape only. If a consumer
// wants a game-flavored story, it post-processes the JSON artifact downstream.
//
// Principle 2: deterministic Markdown is a schema-level property; any
// wall-clock timestamp or random field in the output is a schema violation.

import type { Effect, Brand } from "effect";
import type { TSchema } from "@sinclair/typebox";
import { notImplemented } from "./_stub.js";
import type {
  AtomicObservation,
  AtomicObservationBase,
  ExtractionGapArtifact,
  ExtractionVersion,
  RunDirPath,
} from "./observation.js";
import type { CheckerVerdict } from "./check.js";
import type { ModelDescriptor } from "./model.js";

// ---------- Diagnosis artifact (machine-readable JSON) ----------

/** Exactly one of these is written per analyzed run. Stable schema; future
 *  additions are either optional or bump `schemaVersion`. */
export interface DiagnosisArtifact<TEv extends AtomicObservationBase> {
  readonly schemaVersion: DiagnosisSchemaVersion;
  readonly runDir: RunDirPath;
  readonly analyzedAt: AnalyzedAtIso; // provenance only; not rendered in Markdown
  readonly model: ModelDescriptor;
  readonly extraction: {
    readonly version: ExtractionVersion;
    readonly observationCount: number;
    readonly gapCount: number;
  };
  readonly verdict: CheckerVerdict;
  readonly headline: DiagnosisHeadline;
  readonly firstEvidence: ReadonlyArray<EvidencePointer>;
  readonly observations: ReadonlyArray<AtomicObservation<TEv>>;
  readonly gaps: ExtractionGapArtifact;
}

/** Short closed-enum headline used by both the CLI summary line and the
 *  Markdown title. Keeps corpus-sweep aggregations typed. */
export type DiagnosisHeadline =
  | "conforming"
  | "first-rule-broken"
  | "never-started"
  | "stalled-open-obligation"
  | "prefix-inadmissible"
  | "extraction-dominant-gap";

/** Pointer back to a concrete raw file+line pair. Principle: every nontrivial
 *  diagnosis carries evidence pointers (acceptance criterion in v1 spec). */
export interface EvidencePointer {
  readonly path: string;
  readonly line: number;
  readonly excerpt: string;
}

export type DiagnosisSchemaVersion = string & Brand.Brand<"DiagnosisSchemaVersion">;
export type AnalyzedAtIso = string & Brand.Brand<"AnalyzedAtIso">;

// ---------- Artifact sink ----------

/** Where the three outputs are written. Consumers pass one of these to
 *  `analyzeRun()`. In-run mode is the constructor default; `--debug-dir` is
 *  opt-in via `createDebugDirSink()`. */
export interface ArtifactSink {
  readonly mode: ArtifactSinkMode;
  writeJson(runDir: RunDirPath, json: string): Effect.Effect<WrittenArtifact, SinkError, never>;
  writeMarkdown(runDir: RunDirPath, markdown: string): Effect.Effect<WrittenArtifact, SinkError, never>;
  writeManifest(runDir: RunDirPath, manifest: string): Effect.Effect<WrittenArtifact, SinkError, never>;
}

export type ArtifactSinkMode =
  | { readonly _tag: "InRun" }
  | { readonly _tag: "DebugDir"; readonly debugDir: string };

export interface WrittenArtifact {
  readonly path: string;
  readonly bytes: number;
}

export type SinkError =
  | { readonly _tag: "DestinationNotWritable"; readonly path: string; readonly message: string }
  | { readonly _tag: "RefusedRawMutation"; readonly runDir: RunDirPath; readonly relPath: string };

// ---------- Re-analysis manifest (Q3 resolution) ----------

/** Written alongside the diagnosis artifacts in in-run mode. Records the
 *  `(model, extractor)` descriptor pair used by this pass plus the digest of
 *  any prior pass that this run overwrote. Preserves Invariant 2
 *  (reproducible from stored inputs) without requiring versioned filenames. */
export interface AnalysisManifest {
  readonly schemaVersion: ManifestSchemaVersion;
  readonly runDir: RunDirPath;
  readonly current: ManifestEntry;
  readonly priorOverwritten?: ManifestEntry;
}

export interface ManifestEntry {
  readonly model: ModelDescriptor;
  readonly extraction: ExtractionVersion;
  readonly analyzedAt: AnalyzedAtIso;
  readonly diagnosisDigest: DiagnosisDigest;
}

export type ManifestSchemaVersion = string & Brand.Brand<"ManifestSchemaVersion">;
export type DiagnosisDigest = string & Brand.Brand<"DiagnosisDigest">;

// ---------- Stubs ----------

/** In-run sink: writes under the consumer's run directory. Refuses to touch
 *  any file the ingestor declared as raw input (Invariant 1 enforcement). */
export function createInRunSink(_opts: InRunSinkOptions): ArtifactSink {
  return notImplemented("report");
}

export interface InRunSinkOptions {
  readonly rawInputPaths: ReadonlyArray<string>;
  readonly subdir: string;
}

/** Debug-dir sink: writes to a sibling location; the raw bundle is untouched. */
export function createDebugDirSink(_opts: DebugDirSinkOptions): ArtifactSink {
  return notImplemented("report");
}

export interface DebugDirSinkOptions {
  readonly debugDir: string;
}

/** Serialize a `DiagnosisArtifact` to JSON. Pure; deterministic key ordering. */
export function renderDiagnosisJson<TEv extends AtomicObservationBase>(
  _artifact: DiagnosisArtifact<TEv>,
): string {
  return notImplemented("report");
}

/** Serialize a `DiagnosisArtifact` to byte-deterministic Markdown.
 *  No wall-clock fields, no iteration-order-dependent sections, no locale. */
export function renderDiagnosisMarkdown<TEv extends AtomicObservationBase>(
  _artifact: DiagnosisArtifact<TEv>,
): string {
  return notImplemented("report");
}

/** One-line CLI summary suitable for corpus-sweep aggregation and grep. */
export function renderCliSummary<TEv extends AtomicObservationBase>(
  _artifact: DiagnosisArtifact<TEv>,
): string {
  return notImplemented("report");
}

/** Write all three artifacts plus manifest through an `ArtifactSink`. */
export function publishDiagnosis<TEv extends AtomicObservationBase>(
  _sink: ArtifactSink,
  _artifact: DiagnosisArtifact<TEv>,
  _manifest: AnalysisManifest,
): Effect.Effect<PublishResult, SinkError, never> {
  return notImplemented("report");
}

export interface PublishResult {
  readonly json: WrittenArtifact;
  readonly markdown: WrittenArtifact;
  readonly manifest: WrittenArtifact;
}

/** Factory: return the TypeBox schema used for boundary-validating a
 *  `DiagnosisArtifact` on decode (Principle 2). Stub returns via the standard
 *  implementation marker. Downstream (arena#144 verify) imports this to
 *  decode substrate output without a separate typing contract. */
export function getDiagnosisArtifactSchema(): TSchema {
  return notImplemented("report");
}
