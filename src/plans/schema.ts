import { Data, Effect } from "effect";
import type {
  PlanFilePath,
  PlannedHarnessDocument,
  PromptWorkspacePlanSpec,
} from "./types.js";

export class PlannedHarnessSchemaError extends Data.TaggedError(
  "PlannedHarnessSchemaError",
)<{
  readonly cause: PlannedHarnessSchemaErrorCause;
}> {}

export type PlannedHarnessSchemaErrorCause =
  | { readonly _tag: "TopLevelNotDocument"; readonly path: PlanFilePath }
  | {
      readonly _tag: "UnsupportedHarnessKind";
      readonly path: PlanFilePath;
      readonly kind: string;
    }
  | {
      readonly _tag: "SchemaInvalid";
      readonly path: PlanFilePath;
      readonly errors: ReadonlyArray<string>;
    };

export function decodePromptWorkspacePlanSpec(
  _source: unknown,
  _originPath: PlanFilePath,
): Effect.Effect<PromptWorkspacePlanSpec, PlannedHarnessSchemaError, never> {
  throw new Error("not implemented");
}

export function decodePlannedHarnessDocument(
  _source: unknown,
  _originPath: PlanFilePath,
): Effect.Effect<PlannedHarnessDocument, PlannedHarnessSchemaError, never> {
  throw new Error("not implemented");
}
