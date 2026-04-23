# cc-judge

TypeScript-first CLI + SDK for two jobs:

- run harness-backed plans against real systems
- score already-captured traces or bundles with Claude

`cc-judge` is the generic layer. It owns plan loading, report emission, scoring,
and the CLI. Your system owns the harness module that knows how to boot the
target app and capture a canonical trace.

## Prerequisites

- Node.js 20.11+
- `pnpm` 9+
- Claude judge auth:
  - `claude auth login`, or
  - `ANTHROPIC_API_KEY=...`

If you use a harness that launches Docker workloads, Docker must also be
available.

When `--judge-backend anthropic` is active and `ANTHROPIC_API_KEY` is not set,
`cc-judge` runs `claude auth status` before `run` or `score`. Successful auth
checks are cached for 24 hours under the user cache directory (for example
`$XDG_CACHE_HOME/cc-judge` or `~/.cache/cc-judge`) so repeated invocations do
not keep probing Claude auth.

## Install

```bash
pnpm add cc-judge
```

## Quickstart

### 1. Authenticate the judge

```bash
claude auth login
# or:
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Create a harness-backed plan

`cc-judge run` now expects a shared plan envelope plus a harness module.
The module path resolves relative to the plan file.

Typical layout:

```text
your-repo/
  plans/
    demo.yaml
  dist/
    demo-harness.js
```

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

Required top-level fields:

- `project`: stable project identifier
- `scenarioId`: stable scenario identifier
- `name`: human-readable name shown in reports
- `description`: scenario description shown in reports
- `requirements.expectedBehavior`: free-form success description for the judge
- `requirements.validationChecks`: concrete checklist for the judge
- `harness.module`: module path relative to the plan file
- `harness.payload`: harness-specific configuration blob

The harness module must export `load(args)` as the default export unless you
set `harness.export`.

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

For real systems, the harness usually returns either:

- `plan + harness + runtime`, or
- `plan + harness + coordinator`

MoltZap and Arena both use the second form.

### 3. Run the plan

```bash
cc-judge run ./plans/**/*.yaml --results ./eval-results --log-level info
```

Successful and failed runs both emit the same artifact set:

```text
eval-results/
  summary.md
  results.jsonl
  details/
    <scenario-id>.<run-number>.yaml
```

Exit codes:

- `0`: every run passed
- `1`: one or more runs executed but failed judgment
- `2`: fatal operator error such as bad input, missing auth, or harness load failure

## Score existing traces

If you already have canonical traces, use `score` directly.

Minimal canonical trace example:

```json
{
  "traceId": "trace-1",
  "scenarioId": "demo-trace",
  "name": "multi-agent-game",
  "turns": [],
  "expectedBehavior": "game completes",
  "validationChecks": ["all players participate"],
  "events": [
    {
      "type": "message",
      "from": "Agent-1",
      "channel": "town_square",
      "text": "Hello",
      "ts": 1000
    }
  ]
}
```

Optional rubric file:

```md
Judge the run strictly.
Fail the run if the agent returns an auth error, empty output, or an off-topic answer.
```

Run scoring:

```bash
cc-judge score ./traces/**/*.json \
  --results ./eval-results \
  --judge-rubric ./rubric.md \
  --log-level info
```

Supported trace formats:

- `canonical` (default)
- `otel`

Use `canonical` when you already have `cc-judge`-shaped trace JSON/YAML.
Use `otel` when your source system already emits OTel spans and you want the
adapter to normalize them into the canonical trace shape.

## CLI

```text
cc-judge run <input>
cc-judge score <traces>
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

- `--runtime docker|subprocess`
- `--bin <path>`

These are only relevant when the loaded harness defers execution to
`cc-judge`'s built-in coordinator/runtime path. Systems like MoltZap and Arena
already provide their own coordinator, so the extra runtime flags are usually
not needed.

### `score`

Important options:

- `--trace-format canonical|otel`
- `--results <dir>`
- `--judge <model>`
- `--judge-rubric <path>`
- `--concurrency <n>`
- `--log-level debug|info|warn|error`
- `--total-timeout-ms <ms>`

## SDK

Main entrypoints:

- `runPlans(...)` for harness-backed planned runs
- `scoreTraces(...)`
- `scoreBundles(...)`

Harness ingress types:

- `SharedHarnessPlanDocument`
- `ExternalHarnessModule`
- `HarnessPlanLoadArgs`

Which entrypoint to use:

- `runPlans(...)`: harness-backed planned runs
- `scoreTraces(...)`: scoring-only path for canonical or OTel traces
- `scoreBundles(...)`: scoring-only path when you already have normalized bundles

## Local development

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

## What is verified here

Current tree coverage includes:

- planned harness YAML ingress
- module resolution/import/load failures
- timeout cleanup in the judge and pipeline layers
- canonical and OTel trace decoding
- bundle and trace scoring

## License

MIT
