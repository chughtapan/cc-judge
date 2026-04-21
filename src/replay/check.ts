// Shared checker invocation.
//
// Responsibility: compile the consumer's P project, write the generated replay
// testcase from the extracted observation stream, invoke `p check`, parse the
// result, and surface the first violation (or the liveness obligation still
// open at `eTraceEnded`) as a typed verdict.
//
// What does NOT live here: game-specific interpretation of the verdict.
// Consumers take a `CheckerVerdict` and produce their narrative
// (`why did the game not finish?`) in their own post-processing. The substrate
// only knows "monitor X flagged at observation Y with evidence Z."
//
// Principle 3: checker failures are typed, not thrown. Principle 4: the
// verdict union is closed.

import type { Effect, Brand } from "effect";
import type { AtomicObservation, AtomicObservationBase, ObservationProvenance } from "./observation.js";
import type { PModelInput } from "./model.js";
import { notImplemented } from "./_stub.js";

// ---------- Inputs ----------

export interface CheckerInvocation<TEv extends AtomicObservationBase> {
  readonly model: PModelInput<TEv>;
  readonly observations: ReadonlyArray<AtomicObservation<TEv>>;
  /** Absolute path to the P toolchain entrypoint. Consumer-configured so the
   *  substrate never bakes in "/usr/local/bin/p" or similar. */
  readonly pBinary: PBinaryPath;
  readonly timeoutMs: CheckerTimeoutMs;
}

export type PBinaryPath = string & Brand.Brand<"PBinaryPath">;
export type CheckerTimeoutMs = number & Brand.Brand<"CheckerTimeoutMs">;

// ---------- Verdict ----------

/** Closed discriminated union. Every branch names the evidence the caller
 *  needs to render a diagnosis — no free-form strings except inside an
 *  explicitly-named field. */
export type CheckerVerdict =
  | {
      readonly _tag: "NoViolation";
      readonly schedulesExplored: number;
    }
  | {
      readonly _tag: "InvariantViolated";
      readonly monitorName: string;
      readonly firstViolationAt: ObservationProvenance;
      readonly observationOrder: number;
      readonly message: string;
      readonly schedulesExplored: number;
    }
  | {
      readonly _tag: "LivenessObligationOpen";
      readonly monitorName: string;
      readonly terminalObservationAt: ObservationProvenance;
      readonly expected: string;
      readonly message: string;
      readonly schedulesExplored: number;
    }
  | {
      readonly _tag: "PrefixInadmissible";
      readonly firstInadmissibleAt: ObservationProvenance;
      readonly observationOrder: number;
      readonly rejectingMonitor: string;
      readonly message: string;
    };

// ---------- Errors ----------

/** Errors are infra failures that prevent the checker from producing a
 *  verdict at all. A well-formed "the model found a bug" is a `CheckerVerdict`,
 *  not an error (Principle 3 + 4: success and failure carry separate types). */
export type CheckerError =
  | { readonly _tag: "CompileFailed"; readonly stderr: string; readonly exitCode: number }
  | { readonly _tag: "ReplayEmitFailed"; readonly message: string }
  | { readonly _tag: "PBinaryMissing"; readonly path: PBinaryPath }
  | { readonly _tag: "Timeout"; readonly afterMs: CheckerTimeoutMs }
  | { readonly _tag: "UnparsableCheckerOutput"; readonly stdoutExcerpt: string }
  | { readonly _tag: "ToolchainVersionMismatch"; readonly detected: string; readonly required: string };

// ---------- Contract ----------

export interface ConformanceChecker {
  run<TEv extends AtomicObservationBase>(
    invocation: CheckerInvocation<TEv>,
  ): Effect.Effect<CheckerVerdict, CheckerError, never>;
}

// ---------- Stubs ----------

/** Factory. The implementation at cc-judge#99 shells out to `p` in a
 *  deterministic working directory, writes the generated replay file, parses
 *  `p check`'s textual output into a `CheckerVerdict`, and maps any
 *  infrastructure failure to a `CheckerError`. */
export function createConformanceChecker(_opts: ConformanceCheckerOptions): ConformanceChecker {
  return notImplemented("check");
}

export interface ConformanceCheckerOptions {
  /** Working directory for the checker. The substrate MUST NOT write inside
   *  the consumer's run directory (Invariant 1); consumers pass a workdir here. */
  readonly workDir: string;
  readonly keepWorkDirOnFailure: boolean;
}

/** Pure: generate the `.p` replay source text from an observation stream
 *  against the consumer's registry. Exposed so the implement-staff task can
 *  unit-test replay generation without invoking `p`. */
export function renderReplaySource<TEv extends AtomicObservationBase>(
  _observations: ReadonlyArray<AtomicObservation<TEv>>,
  _model: PModelInput<TEv>,
): string {
  return notImplemented("check");
}
