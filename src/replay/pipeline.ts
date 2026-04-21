// Top-level orchestration for the shared substrate.
//
// Responsibility: wire `BundleIngestor` → `ObservationExtractor` →
// `ConformanceChecker` → `DiagnosisArtifact` → `ArtifactSink` into a single
// `analyzeRun()` entrypoint a consumer calls once per run directory. This is
// the ONLY module with visibility over the full pipeline; the other four
// modules remain independently testable.
//
// What does NOT live here: any game-specific logic, any file-layout
// assumption, any choice of event tag. All of those arrive through the
// typed `AnalyzeRunRequest` parameter.
//
// Principle 5/6: this is the single orchestration seam. It does not reach
// into the individual modules; it composes them.

import type { Effect } from "effect";
import type {
  AtomicObservation,
  AtomicObservationBase,
  BundleIngestor,
  ExtractionError,
  ExtractionGapArtifact,
  IngestionError,
  LlmJudge,
  ObservationExtractor,
  RunDirPath,
} from "./observation.js";
import type { ConformanceChecker, CheckerError, CheckerVerdict } from "./check.js";
import { notImplemented } from "./_stub.js";
import type { PModelInput } from "./model.js";
import type {
  AnalysisManifest,
  ArtifactSink,
  DiagnosisArtifact,
  PublishResult,
  SinkError,
} from "./report.js";

// ---------- Request ----------

/** Full parameter bundle for one analysis pass. Every field is required or
 *  explicitly optional — no defaults buried inside the pipeline. */
export interface AnalyzeRunRequest<TEv extends AtomicObservationBase> {
  readonly runDir: RunDirPath;
  readonly ingestor: BundleIngestor;
  readonly extractor: ObservationExtractor<TEv>;
  readonly checker: ConformanceChecker;
  readonly model: PModelInput<TEv>;
  readonly sink: ArtifactSink;
  /** If the caller has a prior manifest for this run (e.g., corpus re-analysis
   *  after a model upgrade), pass it; `publishDiagnosis` will record the
   *  overwritten descriptor in the new manifest (Q3 resolution). */
  readonly priorManifest?: AnalysisManifest;
}

// ---------- Result ----------

/** Success shape. Caller inspects `verdict` for the ship/hold decision at
 *  arena#144, or persists `published` for archival. */
export interface AnalyzeRunResult<TEv extends AtomicObservationBase> {
  readonly diagnosis: DiagnosisArtifact<TEv>;
  readonly published: PublishResult;
  readonly verdict: CheckerVerdict;
  readonly observations: ReadonlyArray<AtomicObservation<TEv>>;
  readonly gaps: ExtractionGapArtifact;
}

// ---------- Unified error channel ----------

/** Any failure mode that prevents the pipeline from producing a
 *  `CheckerVerdict`. A checker run that *finds* a bug is not an error
 *  (Principle 3 + 4 separation of success-shaped bugs from infra failures). */
export type AnalyzeRunError =
  | { readonly _tag: "Ingestion"; readonly cause: IngestionError }
  | { readonly _tag: "Extraction"; readonly cause: ExtractionError }
  | { readonly _tag: "Checker"; readonly cause: CheckerError }
  | { readonly _tag: "Sink"; readonly cause: SinkError };

// ---------- Entrypoint ----------

/** Orchestrate one run through the shared substrate.
 *  `R` is `LlmJudge` because the extractor depends on a consumer-supplied
 *  judge backend; callers provide the Layer at invocation time. */
export function analyzeRun<TEv extends AtomicObservationBase>(
  _request: AnalyzeRunRequest<TEv>,
): Effect.Effect<AnalyzeRunResult<TEv>, AnalyzeRunError, LlmJudge> {
  return notImplemented("pipeline");
}

// ---------- Barrel re-exports ----------
// Intentionally not re-exporting here. `src/index.ts` is the public barrel;
// the architect task adds a single `export * from "./replay/index.js"` to the
// root barrel in the implement-staff PR.
