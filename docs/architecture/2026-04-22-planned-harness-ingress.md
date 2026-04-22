# Planned-Harness Ingress Architecture

## Summary

This slice adds one new `cc-judge` public ingress for file-backed planned-harness execution without changing the existing prompt/workspace scenario path: a distinct `cc-judge run-plans <plan-path-or-glob>` command plus the matching SDK helper `runPlannedHarnessPath(...)`. The top-level contract is one `PlannedHarnessDocument` object per YAML file. Multi-plan suites are expressed by loading multiple files through the existing path-or-glob fan-in, not by accepting arrays at the top level of one file. Each matched file decodes into exactly one typed planned-harness document, compiles into the already-existing `PlannedRunInput` substrate, and runs through the existing `runPlans(...)` pipeline for execution, judging, and reporting. This is the first architected slice because it unblocks DRY eval migration in MoltZap and arena while keeping generic ownership in `cc-judge`.

## Modules

1. `src/plans/types.ts`
Purpose: own the typed document model for file-backed planned-harness ingress.
Public surface: `PlanFilePath`, `PromptWorkspacePlanSpec`, `PlannedHarnessSpec`, `PlannedHarnessDocument`, `LoadedPlannedHarnessDocument`, `CompiledPlannedRun`.
Dependencies: `../core/types.js`, `../runner/coordinator.js`, `../app/opts.js`, `effect/Brand`.

2. `src/plans/schema.ts`
Purpose: define the decode boundary for one planned-harness document per file and surface typed schema failures.
Public surface: `PlannedHarnessSchemaError`, `PlannedHarnessSchemaErrorCause`, `decodePromptWorkspacePlanSpec(...)`, `decodePlannedHarnessDocument(...)`.
Dependencies: `./types.js`, `effect`.

3. `src/plans/loader.ts`
Purpose: load YAML from files/globs, require exactly one planned-harness document per matched file, map parse failures into typed load errors, and enforce duplicate-scenario constraints across loaded plan documents.
Public surface: `PlannedHarnessLoadError`, `PlannedHarnessLoadErrorCause`, `loadPlannedHarnessPath(...)`.
Dependencies: `./types.js`, `./schema.js`, `../core/types.js`, `effect`.

4. `src/plans/compiler.ts`
Purpose: compile loaded planned-harness documents into the existing `PlannedRunInput` execution substrate and provide one public helper that runs a path through the current `runPlans(...)` pipeline.
Public surface: `compilePlannedHarnessDocuments(...)`, `runPlannedHarnessPath(...)`.
Dependencies: `./types.js`, `./loader.js`, `../runner/coordinator.js`, `../app/opts.js`, `../app/pipeline.js`, `../core/schema.js`, `effect`.

5. `src/plans/index.ts`
Purpose: barrel the new planned-harness surface so external consumers use one supported import root instead of deep paths.
Public surface: re-exports from `types`, `schema`, `loader`, and `compiler`.
Dependencies: `./types.js`, `./schema.js`, `./loader.js`, `./compiler.js`.

## Interfaces

```ts
// src/plans/types.ts
export type PlanFilePath = string & Brand.Brand<"PlanFilePath">;
export const PlanFilePath: Brand.Brand.Constructor<PlanFilePath>;

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
```

Intent: `types.ts` is the single typed contract between YAML ingress and the pre-existing `runPlans(...)` substrate.

```ts
// src/plans/schema.ts
export class PlannedHarnessSchemaError extends Data.TaggedError(
  "PlannedHarnessSchemaError",
)<{ readonly cause: PlannedHarnessSchemaErrorCause }> {}

export type PlannedHarnessSchemaErrorCause =
  | { readonly _tag: "TopLevelNotDocument"; readonly path: PlanFilePath }
  | { readonly _tag: "UnsupportedHarnessKind"; readonly path: PlanFilePath; readonly kind: string }
  | { readonly _tag: "SchemaInvalid"; readonly path: PlanFilePath; readonly errors: ReadonlyArray<string> };

export function decodePromptWorkspacePlanSpec(
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<PromptWorkspacePlanSpec, PlannedHarnessSchemaError, never>;

export function decodePlannedHarnessDocument(
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<PlannedHarnessDocument, PlannedHarnessSchemaError, never>;
```

Intent: `schema.ts` owns the bytes-to-types boundary and keeps schema concerns out of file IO and execution code. One file decodes to one `PlannedHarnessDocument`.

```ts
// src/plans/loader.ts
export class PlannedHarnessLoadError extends Data.TaggedError(
  "PlannedHarnessLoadError",
)<{ readonly cause: PlannedHarnessLoadErrorCause }> {}

export type PlannedHarnessLoadErrorCause =
  | { readonly _tag: "FileNotFound"; readonly path: string }
  | { readonly _tag: "GlobNoMatches"; readonly pattern: string }
  | { readonly _tag: "ParseFailure"; readonly path: PlanFilePath; readonly message: string }
  | { readonly _tag: "TopLevelNotDocument"; readonly path: PlanFilePath }
  | { readonly _tag: "UnsupportedHarnessKind"; readonly path: PlanFilePath; readonly kind: string }
  | { readonly _tag: "SchemaInvalid"; readonly path: PlanFilePath; readonly errors: ReadonlyArray<string> }
  | { readonly _tag: "DuplicateScenarioId"; readonly scenarioId: ScenarioId; readonly paths: readonly [PlanFilePath, PlanFilePath] };

export function loadPlannedHarnessPath(
  pathOrGlob: string,
): Effect.Effect<ReadonlyArray<LoadedPlannedHarnessDocument>, PlannedHarnessLoadError, never>;
```

Intent: `loader.ts` is the only module that touches disk/globs for the new path. Path fan-in happens across files; arrays-of-documents within one file are rejected at the schema boundary.

```ts
// src/plans/compiler.ts
export function compilePlannedHarnessDocuments(
  documents: ReadonlyArray<LoadedPlannedHarnessDocument>,
): Effect.Effect<ReadonlyArray<CompiledPlannedRun>, never, never>;

export function runPlannedHarnessPath(
  pathOrGlob: string,
  opts?: HarnessRunOpts,
): Effect.Effect<Report, PlannedHarnessLoadError, never>;
```

Intent: `compiler.ts` is the bridge from typed ingress to the existing `runPlans(...)` path; the distinct CLI `run-plans` command stays a thin wrapper over this SDK helper.

## Data flow

- `app/cli.ts` adds a distinct `run-plans <plan-path-or-glob>` command and forwards the provided file path to `runPlannedHarnessPath(...)`. The existing `run <scenario>` command remains the simple scenario ingress and is not overloaded.
- `plans/loader.ts` resolves the path or glob, reads YAML, parses each matched file, and calls `plans/schema.ts` to decode exactly one planned-harness document from each file.
- If a matched file does not have a single planned-harness document object at the top level, `plans/schema.ts` fails with `TopLevelNotDocument`; arrays-of-documents are rejected in this first slice.
- `plans/loader.ts` enforces duplicate `scenarioId` failures across all loaded documents before anything reaches execution.
- `plans/compiler.ts` maps each decoded `prompt-workspace` document into a `PlannedRunInput` using the existing `PromptWorkspaceHarness` and the existing `RunPlan`.
- `plans/compiler.ts` hands the compiled inputs to the existing `runPlans(...)` pipeline in `app/pipeline.ts`.
- Existing `runPlans(...)` execution, judgment, report emission, and observability emitters remain the single runtime/report path.
- `src/index.ts` re-exports the new `plans` surface so downstream code uses supported package imports rather than deep paths.

```text
cc-judge run-plans <plan-path-or-glob>
    |
    v
loadPlannedHarnessPath(pathOrGlob)
    |-- FileNotFound / GlobNoMatches / ParseFailure
    |-- TopLevelNotDocument / UnsupportedHarnessKind / SchemaInvalid
    |-- DuplicateScenarioId
    v
compilePlannedHarnessDocuments(documents)
    |
    v
runPlans(inputs, opts)
    |-- existing RunCoordinationError folded by current pipeline
    v
Report + existing emitters
```

## Errors

- `decodePromptWorkspacePlanSpec(...)` and `decodePlannedHarnessDocument(...)` expose `PlannedHarnessSchemaError`.
- `TopLevelNotDocument` means the YAML root is not one planned-harness document object with `plan` and `harness`; suites spanning multiple plans must use multiple files matched by the input path or glob.
- `loadPlannedHarnessPath(...)` exposes `PlannedHarnessLoadError`.
- `compilePlannedHarnessDocuments(...)` is total in this slice and returns `Effect<..., never, never>` because the only supported harness kind is the built-in `prompt-workspace` branch whose construction is local and typed.
- `runPlannedHarnessPath(...)` exposes `PlannedHarnessLoadError`; it is the SDK surface behind the distinct CLI `run-plans` ingress. Downstream execution and judgment continue through the existing `runPlans(...)` behavior, which returns a `Report` rather than surfacing execution failures on the outer error channel.

## Dependencies

| library | version | license | why this one |
|---|---:|---|---|
| `effect` | `3.21.0` exact pin | MIT | Required to align `cc-judge` with the exact MoltZap typed runtime surface before cross-repo shared contracts can be consumed without compat glue. |
| `@sinclair/typebox` | `0.33.22` | MIT | Existing schema library already used by `cc-judge`; this slice keeps one schema tool rather than introducing a second decoder stack. |
| `yaml` | `2.6.1` | ISC | Existing YAML parser already used by `cc-judge`; sufficient for file-backed plan ingress. |
| `yargs` | `17.7.2` | MIT | Existing CLI parser; the new `run-plans` command remains a thin extension over the current command surface without overloading `run`. |

## Traceability

| spec item | slice coverage | module / file |
|---|---|---|
| Goal 1 / AC: exact `effect` pin and no compat shim for `cc-judge` skew | direct | existing `package.json`, existing `src/index.ts` export surface |
| Goal 7 / AC: `cc-judge` shared-contract output remains the default eval path | direct | existing `app/pipeline.ts`, new `plans/compiler.ts` |
| Goal 8 / AC: generic eval substrate ownership collapses into `cc-judge` | direct | new `plans/*` surface |
| Goal 13 / AC: distinct planned-harness YAML path instead of stretching simple scenario schema | direct | new `plans/schema.ts`, `plans/loader.ts` |
| Goal 17 / AC: DRY single owner for generic YAML/harness ingress | direct | new `plans/*` surface and existing root export |
| AC: `cc-judge` exposes supported file-backed planned-harness input path | direct | new `plans/index.ts`, `plans/compiler.ts`, existing `app/cli.ts` distinct `run-plans` command |
| AC: existing simple prompt/workspace YAML path remains supported | preserved by design | existing `core/scenario.ts`, existing `app/cli.ts` `run` command remains unchanged |
| AC: no duplicate generic loader ownership across repos | partial, enabling slice | new `plans/*`; MoltZap and arena migration is deferred to later architect / implement slices |

## Open questions

None. This slice explicitly freezes one `PlannedHarnessDocument` object per file and a distinct `cc-judge run-plans` ingress while keeping the existing `run` scenario command unchanged. Additional harness kinds require a later architect slice if the governing spec expands.
