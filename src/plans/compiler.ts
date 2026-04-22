import { Effect } from "effect";
import type { HarnessRunOpts } from "../app/opts.js";
import type { Report } from "../core/schema.js";
import type { LoadedPlannedHarnessDocument, CompiledPlannedRun } from "./types.js";
import type { PlannedHarnessLoadError } from "./loader.js";

export function compilePlannedHarnessDocuments(
  _documents: ReadonlyArray<LoadedPlannedHarnessDocument>,
): Effect.Effect<ReadonlyArray<CompiledPlannedRun>, never, never> {
  throw new Error("not implemented");
}

export function runPlannedHarnessPath(
  _pathOrGlob: string,
  _opts: HarnessRunOpts = {},
): Effect.Effect<Report, PlannedHarnessLoadError, never> {
  throw new Error("not implemented");
}
