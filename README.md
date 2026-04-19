# cc-judge

TypeScript-first CLI + SDK that runs Claude Code agents in isolated workspaces (or scores already-executed traces), judges transcripts and workspace diffs with an LLM, and emits a `summary.md` + `results.jsonl` + `details/*.yaml` report triple. Telemetry fans out to Braintrust and Promptfoo via a pluggable `ObservabilityEmitter` adapter.

## Prerequisites

### pnpm

cc-judge requires `pnpm` ≥9.0. Install via npm or Corepack:

```bash
npm install -g pnpm
# or enable Corepack (Node.js 16.9+)
corepack enable
```

### ANTHROPIC_API_KEY

The SDK's `AnthropicJudgeBackend` requires the `ANTHROPIC_API_KEY` environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

This key is used only for judge-backend API calls (Claude model invocations). It is not stored or rotated by cc-judge; manage rotation via your credential provider. The key scope is limited to LLM inference; it cannot modify your Anthropic org or billing.

## Install

```bash
pnpm add cc-judge
```

## CLI

```
cc-judge run   <scenario-path-or-glob> [options]
cc-judge score <traces-path-or-glob>   [options]
```

### CLI Flags

#### `run` command

- `--runner` — Runner backend: `docker` (default) or `subprocess`. See [Runner backends](#runner-backends).
- `--judge` — Judge backend: `anthropic` (default). See [Judging](#judging).
- `--results-dir` — Directory for report output. Default: `./cc-judge-results`.
- `--verbose` — Enable debug logging.

#### `score` command

- `--judge` — Judge backend: `anthropic` (default).
- `--judge-rubric` — Path to a rubric file appended to the judge system prompt. Use this to customize scoring criteria for different trace types (e.g., multi-agent game evaluation).
- `--results-dir` — Directory for report output. Default: `./eval-results`.
- `--verbose` — Enable debug logging.

The `score` command accepts a single file, a glob pattern, or a directory containing `.json`/`.yaml`/`.yml` trace files.

### Exit codes

- `0` — all scenarios passed
- `1` — one or more scenarios failed (judgment failed or agent error)
- `2` — fatal error (invalid config, missing prerequisites like Docker daemon, schema violation)

Exit code `2` indicates an unrecoverable error (e.g., `DockerRunner` cannot reach the daemon, scenario file is malformed, or `ANTHROPIC_API_KEY` is absent). Exit code `1` indicates that one or more test scenarios ran but the judge marked them as failing.

## Scenarios

A **scenario** defines a workspace state and agent prompt; cc-judge runs the agent and judges the output.

### Scenario schema

```ts
interface Scenario {
  name: string;           // Human-readable test name
  description: string;    // What the scenario tests
  workspace: {
    files: Record<string, string>;  // File path → content
  };
  prompt: string;         // Instruction for the Claude Code agent
}
```

### Example scenario

```yaml
name: "Add TypeScript interface"
description: "Agent adds a TypeScript interface to a source file"
workspace:
  files:
    src/types.ts: |
      // User types live here
      export type User = { id: string; name: string };
prompt: |
  The file src/types.ts defines a User type. Add an interface `UserProfile` that extends User with email and roles fields. Write the interface, add JSDoc comments, and validate TypeScript.
```

Use YAML or JSON files. Place scenarios in a directory (e.g., `./scenarios/`) and pass the path or glob to `cc-judge run`:

```bash
cc-judge run ./scenarios/**/*.yaml
```

## SDK

```ts
import { runScenarios, DockerRunner, AnthropicJudgeBackend } from "cc-judge";
import { Effect } from "effect";

const scenarios = [
  {
    name: "Test 1",
    description: "...",
    workspace: { files: { "src/index.ts": "..." } },
    prompt: "...",
  },
  // ... more scenarios
];

const report = await Effect.runPromise(
  runScenarios(scenarios, {
    runner: new DockerRunner({ image: "ghcr.io/anthropics/claude-code:latest" }),
    judge: new AnthropicJudgeBackend({ model: "claude-opus-4-7" }),
    resultsDir: "./eval-results",
  }),
);

console.log(report);
```

## Runner backends

### DockerRunner

Runs each agent in an isolated container using the provided image.

**Prerequisites:**
- Docker daemon must be running and reachable at `/var/run/docker.sock` (Linux) or `//var/run/docker.sock` (WSL2).
- Image must be pulled: `docker pull ghcr.io/anthropics/claude-code:latest`
- Credentials for `ghcr.io`: Public image; no authentication required.
- Fallback behavior: If the Docker daemon is unreachable, cc-judge fails with exit code `2` (fatal). This is intentional—Docker is a hard requirement for isolation. Check daemon status: `docker ps`.

### SubprocessRunner

Runs each agent as a subprocess on the local machine (less isolation; useful for CI or testing).

## Judging

cc-judge judges agent output by comparing the workspace state before and after execution. The judge backend encodes success/failure criteria as a prompt template.

### AnthropicJudgeBackend

Uses Claude to evaluate:
- Did the agent accomplish the scenario's goal?
- Are the generated files valid (syntax, types, tests)?
- Did the agent introduce any breaking changes?

The judge backend:
1. Captures workspace state **before** and **after** agent execution
2. Diffs the two states
3. Prompts Claude (via `ANTHROPIC_API_KEY`) with the diff and the scenario description
4. Returns a **pass** or **fail** verdict plus explanation

**Success criteria:** The judge prompt asks Claude to verify that:
- The prompt's requirements are met (e.g., "add a TypeScript interface")
- Generated code is syntactically valid and type-checks
- The agent did not break existing functionality
- Output is reasonably well-commented (where applicable)

The verdict is binary. A **pass** (exit code `0`) means the judge confirmed success; a **fail** (exit code `1`) means the judge reported failure or the agent encountered an error.

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

Config lives in `stryker.config.js`. Thresholds: break at 50, low at 60, high at 80. The TypeScript checker filters mutations that don't typecheck (expected for Effect-heavy code). HTML report lands in `reports/mutation/`.

**Required CI gate:** PRs block on the mutation-score break threshold. The `mutation` job in `.github/workflows/ci.yml` runs Stryker on every PR and fails the build if coverage drops below 50. Stryker runs with `ignoreStatic`, `incremental` (cached across runs via `actions/cache`), and `concurrency: 4` to keep wall-clock bounded.

## License

MIT.
