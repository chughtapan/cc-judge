import { Data, Effect } from "effect";
import type { ScenarioId } from "../core/types.js";
import type {
  LoadedPlannedHarnessDocument,
  PlanFilePath,
} from "./types.js";

export class PlannedHarnessLoadError extends Data.TaggedError(
  "PlannedHarnessLoadError",
)<{
  readonly cause: PlannedHarnessLoadErrorCause;
}> {}

export type PlannedHarnessLoadErrorCause =
  | { readonly _tag: "FileNotFound"; readonly path: string }
  | { readonly _tag: "GlobNoMatches"; readonly pattern: string }
  | {
      readonly _tag: "ParseFailure";
      readonly path: PlanFilePath;
      readonly message: string;
    }
  | {
      readonly _tag: "TopLevelNotObject";
      readonly path: PlanFilePath;
    }
  | {
      readonly _tag: "UnsupportedHarnessKind";
      readonly path: PlanFilePath;
      readonly kind: string;
    }
  | {
      readonly _tag: "SchemaInvalid";
      readonly path: PlanFilePath;
      readonly errors: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "DuplicateScenarioId";
      readonly scenarioId: ScenarioId;
      readonly paths: readonly [PlanFilePath, PlanFilePath];
    };

export function loadPlannedHarnessPath(
  _pathOrGlob: string,
): Effect.Effect<
  ReadonlyArray<LoadedPlannedHarnessDocument>,
  PlannedHarnessLoadError,
  never
> {
  throw new Error("not implemented");
}
