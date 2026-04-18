// Pipeline orchestration: composes runner + judge + report + observability.
// Public SDK entrypoints. Invariant #3: error channel is `never` — all internal
// failures fold into per-run RunRecords; the pipeline always produces a Report.

import type { Effect } from "effect";
import type { Report, Scenario, Trace } from "../core/schema.js";
import type { RunOpts, ScoreOpts } from "./opts.js";

// Run one scenario (runsPerScenario applies). Default runner: DockerRunner (image required).
// Default judge: AnthropicJudgeBackend.
export declare function runScenario(
  scenario: Scenario,
  opts?: RunOpts,
): Effect.Effect<Report, never, never>;

// Run a scenario set. Emits per-run RunRecords to results.jsonl as they complete,
// then writes summary.md + details/*.yaml at close.
export declare function runScenarios(
  scenarios: ReadonlyArray<Scenario>,
  opts?: RunOpts,
): Effect.Effect<Report, never, never>;

// Score already-executed traces. No runner invoked; same judge + report path.
// RunRecord.source === "trace" on every emitted record.
export declare function scoreTraces(
  traces: ReadonlyArray<Trace>,
  opts?: ScoreOpts,
): Effect.Effect<Report, never, never>;
