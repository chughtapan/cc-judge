# cc-judge

TypeScript-first CLI + SDK that runs Claude Code agents in isolated workspaces (or scores already-executed traces), judges transcripts and workspace diffs with an LLM, and emits a `summary.md` + `results.jsonl` + `details/*.yaml` report triple. Telemetry fans out to Braintrust and Promptfoo via a pluggable `ObservabilityEmitter` adapter.

## Install

```bash
pnpm add cc-judge
```

## CLI

```
cc-judge run   <scenario-path-or-glob> [options]
cc-judge score <traces-path-or-glob>   [options]
```

Exit codes: `0` all-pass, `1` any-fail, `2` fatal.

## SDK

```ts
import { runScenarios, DockerRunner, AnthropicJudgeBackend } from "cc-judge";
import { Effect } from "effect";

const report = await Effect.runPromise(
  runScenarios(scenarios, {
    runner: new DockerRunner({ image: "ghcr.io/anthropics/claude-code:latest" }),
    judge: new AnthropicJudgeBackend({ model: "claude-opus-4-7" }),
    resultsDir: "./eval-results",
  }),
);
```

## Testing

- **vitest** — unit and pipeline tests (`pnpm test`).
- **fast-check** — property-based tests for the scenario loader.
- **Stryker** — mutation testing over `src/**`.
- **testcontainers** — real-Docker integration test for `DockerRunner` under `tests/integration/`. Skips cleanly when the Docker daemon is unreachable.

Playwright is intentionally **not** used: cc-judge is a CLI + SDK with no browser surface.

## Design

- `src/core/` — branded types, tagged errors, TypeBox schemas, scenario loader
- `src/runner/` — `AgentRunner` interface, `DockerRunner`, `SubprocessRunner`
- `src/judge/` — `JudgeBackend` interface, `AnthropicJudgeBackend`
- `src/emit/` — `ReportEmitter`, `BraintrustEmitter`, `PromptfooEmitter`, trace adapters
- `src/app/` — pipeline + CLI

See the [design doc](https://github.com/chughtapan/cc-judge/issues/4) for the full module layout.

## Mutation testing

Mutation testing runs the full `src/**/*.ts` tree through [Stryker](https://stryker-mutator.io/) + `vitest` to measure how many introduced faults the test suite catches.

```
pnpm mutation
```

Config lives in `stryker.config.js`. Thresholds: break at 50, low at 60, high at 80. The TypeScript checker filters mutations that don't typecheck (expected for Effect-heavy code). HTML report lands in `reports/mutation/`. CI is non-gating.

## License

MIT.
