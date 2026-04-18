// Scenario loader: TS import + YAML decoder + duplicate-id enforcement.
// Data boundary: bytes-on-disk -> validated Scenario[] (schema-decoded).
// Principle 2: schemas decode; nothing else trusts raw input.

import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { glob as doGlob } from "glob";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as YAML from "yaml";
import { LoadError } from "./errors.js";
import { ScenarioYamlSchema, type Scenario } from "./schema.js";
import { ScenarioId } from "./types.js";

export interface ScenarioLoader {
  loadFromPath(pathOrGlob: string): Effect.Effect<ReadonlyArray<Scenario>, LoadError, never>;
  loadFromYaml(source: string, originPath: string): Effect.Effect<Scenario, LoadError, never>;
}

const YAML_EXT = new Set([".yaml", ".yml"]);
const TS_EXT = new Set([".ts", ".mts", ".js", ".mjs"]);

function isGlobPattern(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

function parseFailure(originPath: string, err: unknown): LoadError {
  const message = err instanceof Error ? err.message : String(err);
  return new LoadError({ cause: { _tag: "ParseFailure", path: originPath, message } });
}

const globEff = (pattern: string, cwd?: string): Effect.Effect<ReadonlyArray<string>, LoadError, never> =>
  Effect.tryPromise({
    try: () => doGlob(pattern, cwd !== undefined ? { cwd, absolute: true, nodir: true } : { absolute: true, nodir: true }),
    catch: (err) => parseFailure(pattern, err),
  }).pipe(Effect.map((m) => m.slice().sort()));

const statEff = (abs: string): Effect.Effect<{ readonly isDirectory: boolean } | null, never, never> =>
  Effect.tryPromise({
    try: () => stat(abs),
    catch: () => undefined,
  }).pipe(
    Effect.map((st) => ({ isDirectory: st.isDirectory() })),
    Effect.catchAll(() => Effect.succeed(null)),
  );

const resolvePaths = (pathOrGlob: string): Effect.Effect<ReadonlyArray<string>, LoadError, never> =>
  Effect.gen(function* () {
    if (isGlobPattern(pathOrGlob)) {
      return yield* globEff(pathOrGlob);
    }
    const abs = path.resolve(pathOrGlob);
    const st = yield* statEff(abs);
    if (st === null) return [];
    if (st.isDirectory) {
      return yield* globEff("**/*.{ts,mts,js,mjs,yaml,yml}", abs);
    }
    return [abs];
  });

const readFileEff = (abs: string): Effect.Effect<string, LoadError, never> =>
  Effect.tryPromise({
    try: () => readFile(abs, "utf8"),
    catch: (err) =>
      new LoadError({
        cause: err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT"
          ? { _tag: "FileNotFound", path: abs }
          : { _tag: "ParseFailure", path: abs, message: err instanceof Error ? err.message : String(err) },
      }),
  });

function parseYamlSync(source: string, originPath: string): Effect.Effect<unknown, LoadError, never> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(YAML.parse(source));
    } catch (err: unknown) {
      return Effect.fail(parseFailure(originPath, err));
    }
  });
}

function validateYamlValue(parsed: unknown, originPath: string): Effect.Effect<Scenario, LoadError, never> {
  const errs: string[] = [];
  for (const e of Value.Errors(ScenarioYamlSchema, parsed)) {
    errs.push(`${e.path} ${e.message}`);
  }
  if (errs.length > 0) {
    return Effect.fail(
      new LoadError({ cause: { _tag: "SchemaInvalid", path: originPath, errors: errs } }),
    );
  }
  const decoded = Value.Decode(ScenarioYamlSchema, parsed);
  const scenario: Scenario = {
    ...decoded,
    id: ScenarioId(decoded.id),
  };
  return Effect.succeed(scenario);
}

function decodeYaml(source: string, originPath: string): Effect.Effect<Scenario, LoadError, never> {
  return parseYamlSync(source, originPath).pipe(
    Effect.flatMap((parsed) => validateYamlValue(parsed, originPath)),
  );
}

const importEff = (abs: string): Effect.Effect<unknown, LoadError, never> =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(abs).href),
    catch: (err) => parseFailure(abs, err),
  });

function importTsScenario(abs: string): Effect.Effect<Scenario, LoadError, never> {
  return importEff(abs).pipe(
    Effect.flatMap((mod) => {
      if (typeof mod !== "object" || mod === null) {
        return Effect.fail(
          new LoadError({
            cause: { _tag: "ParseFailure", path: abs, message: "module has no exports" },
          }),
        );
      }
      const modObj = mod as { readonly default?: unknown; readonly scenario?: unknown };
      const candidate = modObj.default ?? modObj.scenario;
      if (candidate === undefined || candidate === null) {
        return Effect.fail(
          new LoadError({
            cause: {
              _tag: "ParseFailure",
              path: abs,
              message: "TS scenario module must export `default` or `scenario`",
            },
          }),
        );
      }
      return normalizeTsScenario(candidate, abs);
    }),
  );
}

function normalizeTsScenario(candidate: unknown, originPath: string): Effect.Effect<Scenario, LoadError, never> {
  if (candidate === null || typeof candidate !== "object") {
    return Effect.fail(
      new LoadError({
        cause: { _tag: "ParseFailure", path: originPath, message: "scenario export is not an object" },
      }),
    );
  }
  const raw = candidate as { readonly deterministicPassCheck?: unknown; readonly deterministicFailCheck?: unknown; readonly [k: string]: unknown };
  const passCheck = raw.deterministicPassCheck;
  const failCheck = raw.deterministicFailCheck;

  const passCheckOk = passCheck === undefined || typeof passCheck === "function";
  const failCheckOk = failCheck === undefined || typeof failCheck === "function";
  if (!passCheckOk || !failCheckOk) {
    return Effect.fail(
      new LoadError({
        cause: {
          _tag: "SchemaInvalid",
          path: originPath,
          errors: ["deterministicPassCheck / deterministicFailCheck must be functions if set"],
        },
      }),
    );
  }

  // Strip function-valued fields before schema validation (TypeBox rejects functions).
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== "deterministicPassCheck" && k !== "deterministicFailCheck") {
      rest[k] = v;
    }
  }

  const errs: string[] = [];
  for (const e of Value.Errors(ScenarioYamlSchema, rest)) {
    errs.push(`${e.path} ${e.message}`);
  }
  if (errs.length > 0) {
    return Effect.fail(new LoadError({ cause: { _tag: "SchemaInvalid", path: originPath, errors: errs } }));
  }
  const decoded = Value.Decode(ScenarioYamlSchema, rest);

  type PassCheck = NonNullable<Scenario["deterministicPassCheck"]>;
  type FailCheck = NonNullable<Scenario["deterministicFailCheck"]>;
  const base: Scenario = { ...decoded, id: ScenarioId(decoded.id) };
  const withPass: Scenario = passCheck !== undefined
    ? { ...base, deterministicPassCheck: passCheck as PassCheck }
    : base;
  const withFail: Scenario = failCheck !== undefined
    ? { ...withPass, deterministicFailCheck: failCheck as FailCheck }
    : withPass;
  return Effect.succeed(withFail);
}

function loadOne(abs: string): Effect.Effect<Scenario, LoadError, never> {
  const ext = path.extname(abs).toLowerCase();
  if (YAML_EXT.has(ext)) {
    return readFileEff(abs).pipe(Effect.flatMap((src) => decodeYaml(src, abs)));
  }
  if (TS_EXT.has(ext)) {
    return importTsScenario(abs);
  }
  return Effect.fail(
    new LoadError({
      cause: {
        _tag: "ParseFailure",
        path: abs,
        message: `unsupported extension ${ext} (expected .ts/.mts/.js/.mjs/.yaml/.yml)`,
      },
    }),
  );
}

function enforceUniqueIds(
  scenarios: ReadonlyArray<readonly [string, Scenario]>,
): Effect.Effect<ReadonlyArray<Scenario>, LoadError, never> {
  const seen = new Map<string, string>();
  for (const [sourcePath, s] of scenarios) {
    const prior = seen.get(s.id);
    if (prior !== undefined) {
      return Effect.fail(
        new LoadError({
          cause: { _tag: "DuplicateId", id: s.id, paths: [prior, sourcePath] as const },
        }),
      );
    }
    seen.set(s.id, sourcePath);
  }
  return Effect.succeed(scenarios.map(([, s]) => s));
}

export const scenarioLoader: ScenarioLoader = {
  loadFromPath(pathOrGlob) {
    return resolvePaths(pathOrGlob).pipe(
      Effect.flatMap((paths) => {
        if (paths.length === 0) {
          return isGlobPattern(pathOrGlob)
            ? Effect.fail(new LoadError({ cause: { _tag: "GlobNoMatches", pattern: pathOrGlob } }))
            : Effect.fail(new LoadError({ cause: { _tag: "FileNotFound", path: pathOrGlob } }));
        }
        return Effect.forEach(paths, (p) =>
          loadOne(p).pipe(Effect.map((s): readonly [string, Scenario] => [p, s] as const)),
        ).pipe(Effect.flatMap((loaded) => enforceUniqueIds(loaded)));
      }),
    );
  },

  loadFromYaml(source, originPath) {
    return decodeYaml(source, originPath);
  },
};
