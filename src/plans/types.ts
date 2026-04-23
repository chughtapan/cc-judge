import { Brand, Data, type Effect } from "effect";
import type { PlannedRunInput } from "../app/opts.js";
import type { ProjectId, RunRequirements, ScenarioId } from "../core/types.js";

export type PlanFilePath = string & Brand.Brand<"PlanFilePath">;
export const PlanFilePath = Brand.nominal<PlanFilePath>();

export interface SharedHarnessPlanIdentity {
  readonly project: ProjectId;
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly requirements: RunRequirements;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessModuleSpec {
  readonly module: string;
  readonly export?: string;
  readonly payload?: unknown;
}

export interface SharedHarnessPlanDocument extends SharedHarnessPlanIdentity {
  readonly harness: HarnessModuleSpec;
}

export interface LoadedHarnessPlanDocument {
  readonly sourcePath: PlanFilePath;
  readonly document: SharedHarnessPlanDocument;
}

export interface CompiledPlannedRun {
  readonly sourcePath: PlanFilePath;
  readonly input: PlannedRunInput;
}

export class HarnessPlanError extends Data.TaggedError(
  "HarnessPlanError",
)<{
  readonly cause: HarnessPlanErrorCause;
}> {}

export type HarnessPlanErrorCause =
  | {
      readonly _tag: "InvalidPayload";
      readonly path: PlanFilePath;
      readonly issues: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "InvalidConfiguration";
      readonly path: PlanFilePath;
      readonly message: string;
    }
  | {
      readonly _tag: "ImplementationFailure";
      readonly path: PlanFilePath;
      readonly message: string;
    };

export interface HarnessPlanLoadArgs {
  readonly sourcePath: PlanFilePath;
  readonly plan: SharedHarnessPlanIdentity;
  readonly payload: unknown;
}

export interface ExternalHarnessModule {
  readonly load: (
    args: HarnessPlanLoadArgs,
  ) => Effect.Effect<PlannedRunInput, HarnessPlanError, never>;
}
