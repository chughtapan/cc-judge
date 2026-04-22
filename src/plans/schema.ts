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
  | { readonly _tag: "TopLevelNotObject"; readonly path: PlanFilePath }
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

export function decodePlannedHarnessDocuments(
  _source: unknown,
  _originPath: PlanFilePath,
): Effect.Effect<
  ReadonlyArray<PlannedHarnessDocument>,
  PlannedHarnessSchemaError,
  never
> {
  throw new Error("not implemented");
}
