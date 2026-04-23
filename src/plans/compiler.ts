import { Effect } from "effect";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { HarnessRunOpts } from "../app/opts.js";
import { runPlans } from "../app/pipeline.js";
import type { Report } from "../core/schema.js";
import { loadPlannedHarnessPath } from "./loader.js";
import { PlannedHarnessIngressError } from "./schema.js";
import type {
  CompiledPlannedRun,
  ExternalHarnessModule,
  HarnessPlanLoadArgs,
  LoadedHarnessPlanDocument,
} from "./types.js";

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
    cause: {
      _tag: "ModuleResolveFailed",
      path: sourcePath,
      module: moduleName,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function moduleImportFailed(
  sourcePath: LoadedHarnessPlanDocument["sourcePath"],
  moduleName: string,
  error: unknown,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: {
      _tag: "ModuleImportFailed",
      path: sourcePath,
      module: moduleName,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function harnessLoadFailed(
  sourcePath: LoadedHarnessPlanDocument["sourcePath"],
  moduleName: string,
  message: string,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: {
      _tag: "HarnessPlanLoadFailed",
      path: sourcePath,
      module: moduleName,
      message,
    },
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
                cause: {
                  _tag: "ModuleExportMissing",
                  path: document.sourcePath,
                  module: document.document.harness.module,
                  exportName,
                },
              }),
            );
          }
          if (!isExternalHarnessModule(exported)) {
            return Effect.fail(
              new PlannedHarnessIngressError({
                cause: {
                  _tag: "InvalidHarnessModule",
                  path: document.sourcePath,
                  module: document.document.harness.module,
                  exportName,
                },
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
      return imported.module.load(args).pipe(
        Effect.mapError((error) =>
          harnessLoadFailed(
            document.sourcePath,
            document.document.harness.module,
            JSON.stringify(error.cause),
          ),
        ),
        Effect.map((input) => ({
          sourcePath: document.sourcePath,
          input,
        })),
      );
    }),
  );
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
