import { Data, Effect } from "effect";
import { glob as doGlob } from "glob";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import type { ScenarioId } from "../core/types.js";
import { decodePlannedHarnessDocument, type PlannedHarnessSchemaError } from "./schema.js";
import type {
  LoadedPlannedHarnessDocument,
  PlanFilePath,
} from "./types.js";
import { PlanFilePath as PlanFilePathBrand } from "./types.js";

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
      readonly _tag: "TopLevelNotDocument";
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

const YAML_GLOB = "**/*.{yaml,yml}";

function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function parseFailure(path: PlanFilePath, error: unknown): PlannedHarnessLoadError {
  return new PlannedHarnessLoadError({
    cause: {
      _tag: "ParseFailure",
      path,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

const globEff = (pattern: string, cwd?: string): Effect.Effect<ReadonlyArray<string>, PlannedHarnessLoadError, never> =>
  Effect.tryPromise({
    try: () => doGlob(pattern, cwd !== undefined ? { cwd, absolute: true, nodir: true } : { absolute: true, nodir: true }),
    catch: (error) => {
      const syntheticPath = PlanFilePathBrand(path.resolve(pattern));
      return parseFailure(syntheticPath, error);
    },
  }).pipe(Effect.map((matches) => matches.slice().sort()));

const statEff = (abs: string): Effect.Effect<{ readonly isDirectory: boolean } | null, never, never> =>
  Effect.tryPromise({
    try: () => stat(abs),
    catch: () => undefined,
  }).pipe(
    Effect.map((entry) => ({ isDirectory: entry.isDirectory() })),
    Effect.catchAll(() => Effect.succeed(null)),
  );

const resolvePaths = (pathOrGlob: string): Effect.Effect<ReadonlyArray<string>, PlannedHarnessLoadError, never> =>
  Effect.gen(function* () {
    if (isGlobPattern(pathOrGlob)) {
      return yield* globEff(pathOrGlob);
    }
    const abs = path.resolve(pathOrGlob);
    const entry = yield* statEff(abs);
    if (entry === null) {
      return [];
    }
    if (entry.isDirectory) {
      return yield* globEff(YAML_GLOB, abs);
    }
    return [abs];
  });

function readFileEff(pathValue: PlanFilePath): Effect.Effect<string, PlannedHarnessLoadError, never> {
  return Effect.tryPromise({
    try: () => readFile(pathValue, "utf8"),
    catch: (error) =>
      new PlannedHarnessLoadError({
        cause: error instanceof Error && "code" in error && (error as { readonly code?: string }).code === "ENOENT"
          ? { _tag: "FileNotFound", path: pathValue }
          : {
              _tag: "ParseFailure",
              path: pathValue,
              message: error instanceof Error ? error.message : String(error),
            },
      }),
  });
}

function parseYaml(source: string, originPath: PlanFilePath): Effect.Effect<unknown, PlannedHarnessLoadError, never> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(YAML.parse(source));
    } catch (error) {
      return Effect.fail(parseFailure(originPath, error));
    }
  });
}

function mapSchemaError(error: PlannedHarnessSchemaError): PlannedHarnessLoadError {
  return new PlannedHarnessLoadError({ cause: error.cause });
}

function loadOne(absPath: string): Effect.Effect<LoadedPlannedHarnessDocument, PlannedHarnessLoadError, never> {
  const sourcePath = PlanFilePathBrand(absPath);
  return readFileEff(sourcePath).pipe(
    Effect.flatMap((source) => parseYaml(source, sourcePath)),
    Effect.flatMap((parsed) =>
      decodePlannedHarnessDocument(parsed, sourcePath).pipe(
        Effect.mapError((error) => mapSchemaError(error)),
      ),
    ),
    Effect.map((document) => ({
      sourcePath,
      document,
    })),
  );
}

function enforceUniqueScenarioIds(
  documents: ReadonlyArray<LoadedPlannedHarnessDocument>,
): Effect.Effect<ReadonlyArray<LoadedPlannedHarnessDocument>, PlannedHarnessLoadError, never> {
  const seen = new Map<string, PlanFilePath>();
  for (const document of documents) {
    const scenarioId = document.document.plan.scenarioId;
    const previousPath = seen.get(scenarioId);
    if (previousPath !== undefined) {
      return Effect.fail(
        new PlannedHarnessLoadError({
          cause: {
            _tag: "DuplicateScenarioId",
            scenarioId,
            paths: [previousPath, document.sourcePath],
          },
        }),
      );
    }
    seen.set(scenarioId, document.sourcePath);
  }
  return Effect.succeed(documents);
}

export function loadPlannedHarnessPath(
  pathOrGlob: string,
): Effect.Effect<
  ReadonlyArray<LoadedPlannedHarnessDocument>,
  PlannedHarnessLoadError,
  never
> {
  return resolvePaths(pathOrGlob).pipe(
    Effect.flatMap((paths) => {
      if (paths.length === 0) {
        return isGlobPattern(pathOrGlob)
          ? Effect.fail(new PlannedHarnessLoadError({ cause: { _tag: "GlobNoMatches", pattern: pathOrGlob } }))
          : Effect.fail(new PlannedHarnessLoadError({ cause: { _tag: "FileNotFound", path: pathOrGlob } }));
      }
      return Effect.forEach(paths, (resolvedPath) => loadOne(resolvedPath)).pipe(
        Effect.flatMap((loaded) => enforceUniqueScenarioIds(loaded)),
      );
    }),
  );
}
