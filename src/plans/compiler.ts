import { Effect } from "effect";
import type { HarnessRunOpts } from "../app/opts.js";
import { runPlans } from "../app/pipeline.js";
import type { Report } from "../core/schema.js";
import { PromptWorkspaceHarness } from "../runner/coordinator.js";
import { loadPlannedHarnessPath } from "./loader.js";
import type { LoadedPlannedHarnessDocument, CompiledPlannedRun } from "./types.js";
import type { PlannedHarnessLoadError } from "./loader.js";

export function compilePlannedHarnessDocuments(
  documents: ReadonlyArray<LoadedPlannedHarnessDocument>,
): Effect.Effect<ReadonlyArray<CompiledPlannedRun>, never, never> {
  return Effect.succeed(
    documents.map((document) => ({
      sourcePath: document.sourcePath,
      input: {
        plan: document.document.plan,
        harness: new PromptWorkspaceHarness(document.document.harness.config),
      },
    })),
  );
}

export function runPlannedHarnessPath(
  pathOrGlob: string,
  opts: HarnessRunOpts = {},
): Effect.Effect<Report, PlannedHarnessLoadError, never> {
  return loadPlannedHarnessPath(pathOrGlob).pipe(
    Effect.flatMap((documents) => compilePlannedHarnessDocuments(documents)),
    Effect.map((compiled) => compiled.map((entry) => entry.input)),
    Effect.flatMap((inputs) => runPlans(inputs, opts)),
  );
}
