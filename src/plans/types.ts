import { Brand } from "effect";
import type { PlannedRunInput } from "../app/opts.js";
import type { RunPlan } from "../core/types.js";
import type { PromptWorkspaceHarnessConfig } from "../runner/coordinator.js";

export type PlanFilePath = string & Brand.Brand<"PlanFilePath">;
export const PlanFilePath = Brand.nominal<PlanFilePath>();

export interface PromptWorkspacePlanSpec {
  readonly kind: "prompt-workspace";
  readonly config: PromptWorkspaceHarnessConfig;
}

export type PlannedHarnessSpec = PromptWorkspacePlanSpec;

export interface PlannedHarnessDocument {
  readonly plan: RunPlan;
  readonly harness: PlannedHarnessSpec;
}

export interface LoadedPlannedHarnessDocument {
  readonly sourcePath: PlanFilePath;
  readonly document: PlannedHarnessDocument;
}

export interface CompiledPlannedRun {
  readonly sourcePath: PlanFilePath;
  readonly input: PlannedRunInput;
}
