# Changelog

All notable changes to cc-judge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.3] - 2026-04-29

### Added

- Typed cause-tag constant maps exported from every module that owns a tagged-error union (`BUNDLE_BUILD_CAUSE`, `BUNDLE_DECODE_CAUSE`, `HARNESS_EXECUTION_CAUSE`, `PUBLISH_ERROR_CAUSE`, `RUN_COORDINATION_CAUSE`, `RUNNER_RESOLUTION_CAUSE`, `TRACE_DECODE_CAUSE`, `INSPECT_CAUSE`, `JUDGE_PREFLIGHT_TAG`, `JUDGE_FAILURE_KIND`, `HARNESS_PLAN_CAUSE`, `PLANNED_HARNESS_INGRESS_CAUSE`). Each is `as const satisfies` constrained against its union so a renamed tag breaks compilation.
- `INSPECT_SOURCE`, `TRACE_EVENT_TYPE`, `WAL_WARN_EVENT`, `UNSTRINGIFIABLE_PAYLOAD` / `UNSTRINGIFIABLE_ERROR` exported from their respective modules for structural test assertions.
- Prompt-fragment constants exported from `src/judge/helpers.ts` (`DIFF_PREFIX`, `PROMPT_NO_DIFF`, `TURN_LABEL`, `turnHeader`, `EVENT_PREFIX`, `DEFAULT_AGENT_NAME`) and `src/judge/index.ts` (`PROMPT_HEADING`).
- `JudgeFailureKind` type + schema + optional `failureKind` on `JudgeResult` and `RunRecord`. `criticalFallback` populates it; `buildBundleRecord` propagates it; the Braintrust observer forwards it as run metadata so production observability sees the structural failure mode (Timeout / NoOutput / MalformedJson / etc.) instead of having to grep `reason` text.
- `DETERMINISTIC_JUDGE_MODEL` constant exported from `src/app/pipeline.ts`.
- `formatInspectReport` (pure renderer over `InspectReport`) + `inspectRunAndPrint` (CLI wrapper). Tests assert on the structured report; the CLI does the IO via the wrapper.
- `JudgePreflightResult` tagged enum + `formatJudgePreflightMessage` formatter. CLI invokes both; tests assert on tag instead of substring-matching error messages.

### Changed

- **BREAKING:** `inspectRun(runId, resultsDir)` now returns `Effect<InspectReport, InspectError>` instead of `Effect<void, InspectError>`. SDK consumers calling it for stdout/stderr side effects must switch to `inspectRunAndPrint(runId, resultsDir)`. The CLI is already updated.
- **BREAKING:** `ensureJudgeReady(judgeBackend)` now returns `JudgePreflightResult` (tagged enum) instead of `string | null`. SDK consumers wanting the old human-readable string can pipe through `formatJudgePreflightMessage`.
- `walWarn` signature tightened: accepts `WalWarnEvent` (typed enum) instead of arbitrary `string`. All 14 internal call sites converted to use `WAL_WARN_EVENT.*` constants.

### Fixed

- 199 previously-suppressed `agent-code-guard/no-hardcoded-assertion-literals` ESLint warnings across 21 test files. Tests now import typed constants and assert on structural fields (cause tags, `failureKind`, `JudgePreflightResult` tag, `InspectReport` shape) rather than substring-matching internal user-facing message strings.
- `DETERMINISTIC_JUDGE_MODEL` is now declared above its first use in `src/app/pipeline.ts` (was referenced before the `export const` line, a temporal-dead-zone foot-gun for any future top-level call).

## [0.0.2] - 2026-04-29

### Added

- Real-Docker integration tests for `DockerRuntime` (auto-skip when daemon is unreachable via `docker version --format` probe at module load).
- `docs/WAL.md` documenting the write-ahead log substrate, line schema, partial-line loss window, recovery sweep, and single-writer-per-runId caller contract.
- `src/judge/helpers.ts` with `renderDiff`, `renderTurns`, `renderEvents`, `renderAgents`, `bundleTurnsToEvents`, `extractJsonText`, `coerceIssues`, `coerceSeverity`, `coerceConfidence` extracted as a dedicated test surface.
- `src/runner/helpers.ts` with `parseStreamJson`, `walkWorkspace`, `computeDiff` extracted from `runtime.ts`.
- Test support helpers: `tests/support/streams.ts` (`captureStream`), `tests/support/errors.ts` (`PbtAssertionError`, `IntegrationDockerError`), `tests/support/tmpdir.ts` (`makeTempDir`), and `expectCauseTag` in `tests/support/effect.ts`.
- 188 new tests across 8 new test files (helpers PBT, sink contract, runtime-docker integration, cli-smoke, plus PBT/branch coverage in 4 existing suites).

### Changed

- **Runtime rewrite** (`src/runner/runtime.ts`): replaced manual `execSync("docker ...")` + `shellQuote` driving with the `dockerode` API and `tar-fs` build context streaming. All Docker lifecycle (build, pull, inspect, container create/start, kill, remove, image rm) flows through dockerode. Drops `AutoRemove` from container creation in favour of explicit `container.remove({force: true})` in `stop()` so the cycle is synchronous from the caller's perspective.
- **CLI rewrite** (`src/app/cli.ts`): replaced yargs + the `unknown`-coerce parsers with `@effect/cli` declarative `Args` + `Options` + `Command`. Help text is now auto-generated from option `withDescription` calls. SIGINT/SIGTERM handling and uncaught-defect printing come for free via `NodeRuntime.runMain`.
- **Auth preflight** (`src/app/judge-preflight.ts`): dropped the in-memory cache; disk cache (24h TTL under XDG cache home) is the only source of truth. Eliminates a stale-after-`claude logout` window in long-lived processes.
- **Pipeline refactor** (`src/app/pipeline.ts`): `summarizeDiff`, `sumTurns`, `buildReport` now use `reduce` rather than imperative `let` accumulators. `sumAgentTurns` undefined branch delegates to `sumTurns([])` instead of duplicating the zero shape.
- **Judge prompt rendering**: extracted into `src/judge/helpers.ts` with simpler per-event renderers and `coerceConfidence` reduced to `Math.max(0, Math.min(1, v))`.
- **Real-Docker tests folded into the regular suite**: removed `tests/integration/` split + `vitest.config.integration.ts` + `pnpm test:integration` script. The sync `docker version --format` probe at module load skips the suite cleanly when the daemon is down. This makes the tests visible to Stryker mutation testing.
- **CHANGELOG strategy**: PR-author-discoverable rubrics referenced inline in README; `--judge-rubric` CLI flag claim removed (the rubric travels via `requirements.judgeRubric` in YAML, never wired as a CLI flag).

### Fixed

- **P0-1**: `DockerRuntime.prepare` and `SubprocessRuntime.prepare` now wrap workspace allocation in `Effect.acquireUseRelease`; tmpdir cleanup runs on any non-success exit (failure or fiber interrupt). Previously a failed `createDockerContainer` after a successful `makeEmptyWorkspace` leaked the workspace tmpdir.
- **P0-2**: When `buildDockerImage` fails AND the image was auto-tagged (no user `imageTag`), best-effort `docker image rm -f` cleans up the partial image. User-supplied tags are preserved.
- **P0-4**: WAL post-close `append` warning now includes a `payloadPreview` (capped at 200 chars) and `attemptedAt` timestamp so an operator can correlate dropped events.
- **P0-7**: `compilePlannedHarnessDocuments` wraps user-supplied `harness.module.load()` in `Effect.try` + a runtime Effect-shape check + `catchAllDefect`. A misbehaving harness that throws synchronously, returns a non-Effect, or has an internal defect now produces a typed `HarnessPlanLoadFailed` instead of crashing the process.
- **P0-8**: `compilePlannedHarnessDocuments` now passes explicit `concurrency: 1` to `Effect.forEach` (was implicit-default-1) with a comment explaining why harness module imports must not run in parallel.
- **Coordinator sink contract bug** (`src/runner/coordinator.ts`): `makeNormalizedBundleSink` was using `Effect.sync(() => { throw BundleBuildError })`, which converts thrown exceptions into Die defects, not typed failures. The accompanying `Effect.catchAll(asBundleBuildError)` was therefore dead code, and contract violations (UnknownAgent, DuplicateOutcome, MissingOutcomes, SchemaInvalid) leaked as uncaught fiber defects past `mapRunCoordinationError`. Replaced with `Effect.suspend(() => Effect.fail(...))`. The 14 new tests in `tests/sink-contract.test.ts` are what surfaced the bug.

### Removed

- `yargs`, `@types/yargs`, `zod` (zod was already unused; yargs replaced by `@effect/cli`).
- `shellQuote` and `renderBuildArgs` helpers (no longer needed; dockerode takes structured options).
- `tests/runtime-pbt.test.ts` (only existed to PBT `shellQuote`).
- `vitest.config.integration.ts` and the `pnpm test:integration` script (real-Docker tests now live in the regular suite).
- In-memory auth-preflight cache (`cachedAnthropicAuthSuccessUntilMs`) and the dead `void readFileSync;` line in `runtime.ts`.

### Quality

- Mutation score lifted from 35.87% (PR1 start, "covered" 52.64) to 49.09% (PR1 end, "covered" 65.06) across 8 mutation runs. Per-file movement: `compiler.ts` 51→66, `wal.ts` 36→49, `pipeline.ts` 10→38, `judge-preflight.ts` 42→64, `cli.ts` 20→33, `judge/index.ts` 55→57 (new `helpers.ts` is 96), `runtime.ts` 8→19, `coordinator.ts` 40→40 (sink-contract tests landed after the last mutation run).
- New deps: `@effect/cli` 0.75.1, `@effect/platform` 0.96.1, `@effect/platform-node` 0.106.0, `dockerode` 5.0.0, `tar-fs` 3.1.2, `@types/dockerode`, `@types/tar-fs`, `fast-check` 4.7.0.

## [0.0.1] - 2026-04-19

### Added

- Extended trace format with optional `events`, `phases`, `agents`, `context`, and `judgeRubric` fields for multi-agent game evaluation
- Pluggable judge rubrics: pass a rubric file via `--judge-rubric` CLI option to customize judge scoring criteria
- Three layers of judge customization: declarative `judgeRubric` in trace/scenario, `systemPrompt` override on AnthropicJudgeBackend, and full JudgeBackend interface
- Directory and glob trace resolution: point `score` at a directory or glob pattern instead of a single file
- Event rendering in judge prompt: message, phase, action, and state events are formatted for the LLM judge
- Example conversation game rubric at `rubrics/conversation-game.md`
- 8 new tests for extended trace format (events, phases, agents, context, judgeRubric, backward compat, validation)

### Changed

- Judge prompt now conditionally renders events timeline instead of turns when events are present
- `resolveTraceFiles` expanded from single-file to glob/directory/single-file resolution
