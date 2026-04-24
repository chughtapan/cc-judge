import { Effect } from "effect";
import { glob as doGlob } from "glob";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  decodePlannedHarnessDocument,
  PlannedHarnessIngressError,
  PlannedHarnessIngressErrorCause,
} from "./schema.js";
import type {
  LoadedHarnessPlanDocument,
  PlanFilePath,
} from "./types.js";
import { PlanFilePath as PlanFilePathBrand } from "./types.js";

const YAML_GLOB = "**/*.{yaml,yml}";

function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function parseFailure(pathValue: PlanFilePath, error: unknown): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: PlannedHarnessIngressErrorCause.ParseFailure({
      path: pathValue,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

const globEff = (
  pattern: string,
  cwd?: string,
): Effect.Effect<ReadonlyArray<string>, PlannedHarnessIngressError, never> =>
  Effect.tryPromise({
    try: () =>
      doGlob(
        pattern,
        cwd !== undefined ? { cwd, absolute: true, nodir: true } : { absolute: true, nodir: true },
      ),
    catch: (error) => {
      const syntheticPath = PlanFilePathBrand(path.resolve(pattern));
      return parseFailure(syntheticPath, error);
    },
  }).pipe(Effect.map((matches) => matches.slice().sort()));

const statEff = (
  abs: string,
): Effect.Effect<{ readonly isDirectory: boolean } | null, never, never> =>
  Effect.tryPromise({
    try: () => stat(abs),
    catch: () => undefined,
  }).pipe(
    Effect.map((entry) => ({ isDirectory: entry.isDirectory() })),
    Effect.catchAll(() => Effect.succeed(null)),
  );

const resolvePaths = (
  pathOrGlob: string,
): Effect.Effect<ReadonlyArray<string>, PlannedHarnessIngressError, never> =>
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

function readFileEff(pathValue: PlanFilePath): Effect.Effect<string, PlannedHarnessIngressError, never> {
  return Effect.tryPromise({
    try: () => readFile(pathValue, "utf8"),
    catch: (error) =>
      new PlannedHarnessIngressError({
        cause:
          error instanceof Error &&
          "code" in error &&
          (error as { readonly code?: string }).code === "ENOENT"
            ? PlannedHarnessIngressErrorCause.FileNotFound({ path: pathValue })
            : PlannedHarnessIngressErrorCause.ParseFailure({
                path: pathValue,
                message: error instanceof Error ? error.message : String(error),
              }),
      }),
  });
}

function parseYaml(
  source: string,
  originPath: PlanFilePath,
): Effect.Effect<unknown, PlannedHarnessIngressError, never> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(YAML.parse(source));
    } catch (error) {
      return Effect.fail(parseFailure(originPath, error));
    }
  });
}

function loadOne(absPath: string): Effect.Effect<LoadedHarnessPlanDocument, PlannedHarnessIngressError, never> {
  const sourcePath = PlanFilePathBrand(absPath);
  return readFileEff(sourcePath).pipe(
    Effect.flatMap((source) => parseYaml(source, sourcePath)),
    Effect.flatMap((parsed) => decodePlannedHarnessDocument(parsed, sourcePath)),
    Effect.map((document) => ({
      sourcePath,
      document,
    })),
  );
}

function enforceUniqueScenarioIds(
  documents: ReadonlyArray<LoadedHarnessPlanDocument>,
): Effect.Effect<ReadonlyArray<LoadedHarnessPlanDocument>, PlannedHarnessIngressError, never> {
  const seen = new Map<string, PlanFilePath>();
  for (const document of documents) {
    const scenarioId = document.document.scenarioId;
    const previousPath = seen.get(scenarioId);
    if (previousPath !== undefined) {
      return Effect.fail(
        new PlannedHarnessIngressError({
          cause: PlannedHarnessIngressErrorCause.DuplicateScenarioId({
            scenarioId,
            paths: [previousPath, document.sourcePath],
          }),
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
  ReadonlyArray<LoadedHarnessPlanDocument>,
  PlannedHarnessIngressError,
  never
> {
  return resolvePaths(pathOrGlob).pipe(
    Effect.flatMap((paths) => {
      if (paths.length === 0) {
        return isGlobPattern(pathOrGlob)
          ? Effect.fail(
              new PlannedHarnessIngressError({
                cause: PlannedHarnessIngressErrorCause.GlobNoMatches({ pattern: pathOrGlob }),
              }),
            )
          : Effect.fail(
              new PlannedHarnessIngressError({
                cause: PlannedHarnessIngressErrorCause.FileNotFound({ path: pathOrGlob }),
              }),
            );
      }
      return Effect.forEach(paths, (resolvedPath) => loadOne(resolvedPath)).pipe(
        Effect.flatMap((loaded) => enforceUniqueScenarioIds(loaded)),
      );
    }),
  );
}
