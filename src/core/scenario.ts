// Scenario loader: TS import + YAML decoder + duplicate-id enforcement.
// Data boundary: bytes-on-disk -> validated Scenario[] (schema-decoded).

import type { Effect } from "effect";
import type { LoadError } from "./errors.js";
import type { Scenario } from "./schema.js";

export interface ScenarioLoader {
  // Resolve path/glob to files, decode each (TS or YAML), enforce id uniqueness across the set.
  // Aborts with LoadError.DuplicateId naming both offending paths; the CLI maps this to exit 2.
  loadFromPath(pathOrGlob: string): Effect.Effect<ReadonlyArray<Scenario>, LoadError, never>;

  // Decode a single YAML source into a Scenario (schema-validated at the boundary).
  // YAML callers cannot serialize function-shaped deterministic checks (spec Q4.2 recommended A).
  loadFromYaml(source: string, originPath: string): Effect.Effect<Scenario, LoadError, never>;
}

export declare const scenarioLoader: ScenarioLoader;
