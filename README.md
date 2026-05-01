# cc-judge

TypeScript-first CLI + SDK for planned Claude Code harness runs, LLM bundle judging, and `summary.md` + `results.jsonl` reports. Telemetry can fan out to Braintrust and Promptfoo through pluggable emitters.

## Prerequisites

- Node.js 20.11+
- `pnpm` 9+
- Claude judge auth through `claude auth login` or `ANTHROPIC_API_KEY=...`
- Docker, if your harness launches Docker workloads

When `--judge-backend anthropic` is active and `ANTHROPIC_API_KEY` is not set, `cc-judge` runs `claude auth status` before `run`. Successful checks are cached for 24 hours under the user cache directory.

## Install

```bash
pnpm add cc-judge
```

## Quickstart

Create a harness-backed plan:

```yaml
project: moltzap
scenarioId: EVAL-005
name: Cold outreach response quality
description: Verify the target agent responds helpfully to a first-contact DM.
requirements:
  expectedBehavior: The agent should answer coherently instead of returning an auth or runtime error.
  validationChecks:
    - Response contains non-empty text
    - Response stays on topic
harness:
  module: ../../packages/runtimes/dist/trace-capture-harness.js
  payload:
    runtime:
      kind: openclaw
    conversation:
      kind: direct
      setupMessage: Hello, can you explain how MoltZap conversations work?
```

Run it:

```bash
cc-judge run ./plans/**/*.yaml --results ./eval-results --log-level info
```

Successful and failed runs both emit:

```text
eval-results/
  summary.md
  results.jsonl
  details/
    <scenario-id>.<run-number>.yaml
```

## Quickstart (subprocess SDK)

For embedders running the local Claude binary as a subprocess, `runSubprocessScenarios` pre-composes the four-component default stack — `SubprocessRuntime` + `PromptWorkspaceHarness` + `AnthropicJudgeBackend` + the default `ReportEmitter`:

```ts
import { Effect } from "effect";
import {
  runSubprocessScenarios,
  ProjectId,
  ScenarioId,
} from "@moltzap/cc-judge";

const scenarios = [
  {
    project: ProjectId("moltzap"),
    scenarioId: ScenarioId("hello"),
    name: "First-contact response",
    description: "Verify the agent responds coherently to a first DM.",
    requirements: {
      expectedBehavior: "agent returns non-empty, on-topic text",
      validationChecks: ["Response is non-empty", "Stays on topic"],
    },
    prompts: ["Hello, can you explain how MoltZap conversations work?"] as const,
  },
];

const report = await Effect.runPromise(
  runSubprocessScenarios(scenarios, { bin: "/usr/local/bin/claude" }),
);
```

Override hooks for the four components:

- `concurrency: 4` — run scenarios in parallel (default `1`).
- `judgeOpts: { model: "claude-opus-4-7" }` — tune the bundled `AnthropicJudgeBackend`; or pass `judge: customJudge` to swap the backend wholesale.
- `runtimeOpts: { extraArgs: ["--verbose"] }` — extend the default `SubprocessRuntime`; or pass `runtime: customRuntime` to swap it out (mutually exclusive with `bin` at the type level).
- `harness: customHarness` — share one `ExecutionHarness` across every scenario in the batch (escape hatch when prompts are uniform or the override harness reads prompts from plan metadata; the per-scenario `prompts`/`workspace`/`turnTimeoutMs` are ignored when this is set).

Reports land at `./eval-results/summary.md` and `./eval-results/results.jsonl`; override the directory via `resultsDir`. Per-scenario coordination failures fold into individual `RunRecord`s with `pass: false`; sibling scenarios continue to run.

## Harness Modules

The plan's `harness.module` path resolves relative to the plan file. The module must export `load(args)` as its default export unless the plan sets `harness.export`.

Minimal module shape:

```js
import { Effect } from "effect";

export default {
  load(args) {
    return Effect.succeed({
      plan: {
        project: args.plan.project,
        scenarioId: args.plan.scenarioId,
        name: args.plan.name,
        description: args.plan.description,
        requirements: args.plan.requirements,
        agents: [
          {
            id: "target-agent",
            name: "Target Agent",
            artifact: {
              _tag: "DockerImageArtifact",
              image: "repo/target:latest",
            },
            promptInputs: {},
          },
        ],
      },
      harness: {
        name: "demo-harness",
        run: () =>
          Effect.fail({
            _tag: "ExecutionFailed",
            message: "replace with a real harness or coordinator",
          }),
      },
    });
  },
};
```

For real systems, the harness usually returns either `plan + harness + runtime` or `plan + harness + coordinator`.

## CLI

```text
cc-judge run <input>
cc-judge inspect <run-id>
```

### `run`

`run` accepts harness-backed plan documents with a top-level `harness` block.

Important options:

- `--results <dir>`: output directory, default `./eval-results`
- `--judge <model>`: judge model, default `claude-opus-4-7`
- `--judge-backend anthropic`
- `--concurrency <n>`
- `--log-level debug|info|warn|error`
- `--total-timeout-ms <ms>`
- `--emit-braintrust`
- `--emit-promptfoo <file>`

Compatibility options:

- `--runtime subprocess`
- `--bin <path>`

These are only relevant when the loaded harness defers execution to `cc-judge`'s built-in coordinator/runtime path.

### `inspect`

`inspect` reads the WAL timeline for one run id:

```bash
cc-judge inspect <run-id> --results ./eval-results
```

## SDK

Main entrypoints:

- `runPlans(...)` for harness-backed plan files
- `runWithHarness(...)` for direct harness execution
- `scoreBundles(...)` when you already have normalized `JudgmentBundle` values

Harness ingress types:

- `SharedHarnessPlanDocument`
- `ExternalHarnessModule`
- `HarnessPlanLoadArgs`

## Local Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Mutation testing:

```bash
pnpm mutation
```

## Verified Surfaces

Current tree coverage includes:

- planned harness YAML ingress
- module resolution/import/load failures
- timeout cleanup in the judge and pipeline layers
- bundle scoring
- report, WAL, and observability emitters

## License

MIT
