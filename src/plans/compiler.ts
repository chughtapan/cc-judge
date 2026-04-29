import { Effect } from "effect";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { HarnessRunOpts } from "../app/opts.js";
import { runPlans } from "../app/pipeline.js";
import type { Report } from "../core/schema.js";
import { loadPlannedHarnessPath } from "./loader.js";
import { PlannedHarnessIngressError, PlannedHarnessIngressErrorCause } from "./schema.js";
import type {
  CompiledPlannedRun,
  ExternalHarnessModule,
  HarnessPlanError,
  HarnessPlanLoadArgs,
  LoadedHarnessPlanDocument,
} from "./types.js";
import type { PlannedRunInput } from "../app/opts.js";

interface ImportedHarnessModule {
  readonly module: ExternalHarnessModule;
  readonly resolvedPath: string;
  readonly exportName: string;
}

function moduleResolveFailed(
  sourcePath: LoadedHarnessPlanDocument["sourcePath"],
  moduleName: string,
  error: unknown,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: PlannedHarnessIngressErrorCause.ModuleResolveFailed({
      path: sourcePath,
      module: moduleName,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

function moduleImportFailed(
  sourcePath: LoadedHarnessPlanDocument["sourcePath"],
  moduleName: string,
  error: unknown,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: PlannedHarnessIngressErrorCause.ModuleImportFailed({
      path: sourcePath,
      module: moduleName,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

function harnessLoadFailed(
  sourcePath: LoadedHarnessPlanDocument["sourcePath"],
  moduleName: string,
  message: string,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: PlannedHarnessIngressErrorCause.HarnessPlanLoadFailed({
      path: sourcePath,
      module: moduleName,
      message,
    }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExternalHarnessModule(value: unknown): value is ExternalHarnessModule {
  return isRecord(value) && typeof value["load"] === "function";
}

function readNamedExport(
  namespaceObject: unknown,
  exportName: string,
): unknown {
  if (!isRecord(namespaceObject)) {
    return undefined;
  }
  return namespaceObject[exportName];
}

function resolveModulePath(
  document: LoadedHarnessPlanDocument,
): Effect.Effect<string, PlannedHarnessIngressError, never> {
  return Effect.try({
    try: () => {
      const require = createRequire(document.sourcePath);
      return require.resolve(document.document.harness.module);
    },
    catch: (error) => moduleResolveFailed(document.sourcePath, document.document.harness.module, error),
  });
}

function importHarnessModule(
  document: LoadedHarnessPlanDocument,
  cache: Map<string, ImportedHarnessModule>,
): Effect.Effect<ImportedHarnessModule, PlannedHarnessIngressError, never> {
  const exportName = document.document.harness.export ?? "default";
  return resolveModulePath(document).pipe(
    Effect.flatMap((resolvedPath) => {
      const cacheKey = `${resolvedPath}#${exportName}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return Effect.succeed(cached);
      }
      return Effect.tryPromise({
        try: () => import(pathToFileURL(resolvedPath).href),
        catch: (error) =>
          moduleImportFailed(document.sourcePath, document.document.harness.module, error),
      }).pipe(
        Effect.flatMap((namespaceObject) => {
          const exported = readNamedExport(namespaceObject, exportName);
          if (exported === undefined) {
            return Effect.fail(
              new PlannedHarnessIngressError({
                cause: PlannedHarnessIngressErrorCause.ModuleExportMissing({
                  path: document.sourcePath,
                  module: document.document.harness.module,
                  exportName,
                }),
              }),
            );
          }
          if (!isExternalHarnessModule(exported)) {
            return Effect.fail(
              new PlannedHarnessIngressError({
                cause: PlannedHarnessIngressErrorCause.InvalidHarnessModule({
                  path: document.sourcePath,
                  module: document.document.harness.module,
                  exportName,
                }),
              }),
            );
          }
          const imported: ImportedHarnessModule = {
            module: exported,
            resolvedPath,
            exportName,
          };
          cache.set(cacheKey, imported);
          return Effect.succeed(imported);
        }),
      );
    }),
  );
}

// Describe a non-Effect return value from a user's harness load() so the
// error message tells the user what they actually returned.
function describeLoadReturn(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (typeof (value as { then?: unknown }).then === "function") return "Promise";
  return "non-Effect object";
}

function compileOneDocument(
  document: LoadedHarnessPlanDocument,
  cache: Map<string, ImportedHarnessModule>,
): Effect.Effect<CompiledPlannedRun, PlannedHarnessIngressError, never> {
  return importHarnessModule(document, cache).pipe(
    Effect.flatMap((imported) => {
      const args: HarnessPlanLoadArgs = {
        sourcePath: document.sourcePath,
        plan: {
          project: document.document.project,
          scenarioId: document.document.scenarioId,
          name: document.document.name,
          description: document.document.description,
          requirements: document.document.requirements,
          ...(document.document.metadata !== undefined
            ? { metadata: document.document.metadata }
            : {}),
        },
        payload: document.document.harness.payload,
      };
      return invokeHarnessLoad(imported, args, document).pipe(
        Effect.map((input) => ({
          sourcePath: document.sourcePath,
          input,
        })),
      );
    }),
  );
}

// Wraps imported.module.load(args) so a misbehaving user harness cannot
// crash the cc-judge process. Three failure modes are caught and mapped
// to a typed HarnessPlanLoadFailed error:
//   1. load() throws synchronously (caught by try/catch).
//   2. load() returns something other than an Effect (Promise, plain
//      object, undefined) — caught by the .pipe runtime check.
//   3. The returned Effect produces an uncaught defect when run —
//      caught by Effect.catchAllDefect and surfaced as a typed error.
function invokeHarnessLoad(
  imported: ImportedHarnessModule,
  args: HarnessPlanLoadArgs,
  document: LoadedHarnessPlanDocument,
): Effect.Effect<PlannedRunInput, PlannedHarnessIngressError, never> {
  return Effect.suspend(() => {
    let loadResult: unknown;
    try {
      loadResult = imported.module.load(args);
    } catch (error) {
      return Effect.fail(
        harnessLoadFailed(
          document.sourcePath,
          document.document.harness.module,
          `harness load() threw synchronously: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (
      loadResult === null ||
      typeof loadResult !== "object" ||
      typeof (loadResult as { pipe?: unknown }).pipe !== "function"
    ) {
      return Effect.fail(
        harnessLoadFailed(
          document.sourcePath,
          document.document.harness.module,
          `harness load() must return an Effect; got ${describeLoadReturn(loadResult)}`,
        ),
      );
    }
    const loadEff = loadResult as Effect.Effect<PlannedRunInput, HarnessPlanError, never>;
    return loadEff.pipe(
      Effect.mapError((error) =>
        harnessLoadFailed(
          document.sourcePath,
          document.document.harness.module,
          JSON.stringify(error.cause),
        ),
      ),
      Effect.catchAllDefect((defect) =>
        Effect.fail(
          harnessLoadFailed(
            document.sourcePath,
            document.document.harness.module,
            `harness load() effect produced an uncaught defect: ${defect instanceof Error ? defect.message : String(defect)}`,
          ),
        ),
      ),
    );
  });
}

export function compilePlannedHarnessDocuments(
  documents: ReadonlyArray<LoadedHarnessPlanDocument>,
): Effect.Effect<ReadonlyArray<CompiledPlannedRun>, PlannedHarnessIngressError, never> {
  const cache = new Map<string, ImportedHarnessModule>();
  return Effect.forEach(documents, (document) => compileOneDocument(document, cache));
}

export function runPlannedHarnessPath(
  pathOrGlob: string,
  opts: HarnessRunOpts = {},
): Effect.Effect<Report, PlannedHarnessIngressError, never> {
  return loadPlannedHarnessPath(pathOrGlob).pipe(
    Effect.flatMap((documents) => compilePlannedHarnessDocuments(documents)),
    Effect.map((compiled) => compiled.map((entry) => entry.input)),
    Effect.flatMap((inputs) => runPlans(inputs, opts)),
  );
}
