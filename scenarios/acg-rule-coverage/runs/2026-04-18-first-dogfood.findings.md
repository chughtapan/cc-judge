# First dogfood run — findings

**Date:** 2026-04-18
**Scenario:** `scenarios/acg-rule-coverage/no-raw-throw-to-tagged.yaml`
**Runtime:** SubprocessRunner (`--runtime subprocess --bin /home/tapanc/.local/bin/claude`)
**Judge:** AnthropicJudgeBackend (`claude-opus-4-7`, auth via host `claude` CLI OAuth; no `ANTHROPIC_API_KEY` env present)
**Exit code:** 1 (0/1 passed, failed: 1, avg latency 7265 ms)
**Invocation:**

```
node dist/bin.js run scenarios/acg-rule-coverage/no-raw-throw-to-tagged.yaml \
  --runtime subprocess --bin /home/tapanc/.local/bin/claude \
  --runs 1 --results ./eval-results \
  --emit-promptfoo ./scenarios/acg-rule-coverage/runs/2026-04-18-first-dogfood.promptfoo.json \
  --log-level debug --total-timeout-ms 600000
```

## What the pipeline did

End-to-end traversal worked. Scenario loader parsed the YAML, SubprocessRunner created a workspace and spawned the agent, the judge produced a verdict, and both the native report triple (`summary.md` + `results.jsonl` + `details/*.yaml`) and the Promptfoo emitter output were written. So the top-level composition story is intact.

The judge correctly scored this run `pass=false, overallSeverity=critical` because the agent did not edit `src/validate.ts`. That is the right verdict. But the reason the agent didn't edit the file was not a model failure — it was a runner-side defect. The judge caught this and called it out explicitly in `reason`.

## Defects surfaced

### D1 — CRITICAL — `SubprocessRunner` default args broken against current `claude` CLI

**Location:** `src/runner/index.ts:228`

```ts
const DEFAULT_CLAUDE_ARGS: ReadonlyArray<string> = ["-p", "--output-format", "stream-json"];
```

**Reproducer:** Point `--bin` at any Claude Code CLI ≥ ~v2.1 and run any scenario. Agent stderr surfaces as the turn response:

> `When using --print, --output-format=stream-json requires --verbose`

Because no file edits happen, every subprocess-runtime run fails with the same critical-severity verdict. No scenarios can currently be dogfooded via `--runtime subprocess` without overriding `extraArgs`.

**Proposed fix (separate task):** add `--verbose` to `DEFAULT_CLAUDE_ARGS`, or switch the default to `--output-format json` (which does not require `--verbose`), and add a smoke test that at least asserts one workspace file change.

**Next modality:** `implement-junior` — single-module fix in `src/runner/index.ts` plus one test.

### D2 — SIGNIFICANT — `transcriptPath` points at the deleted workspace dir

**Locations:** `src/app/pipeline.ts:197`, `src/runner/index.ts:376` / `567`

`RunRecord.transcriptPath` is set to `handle.workspaceDir`. The same handle's `stop()` removes that directory at the end of the run. Every emitted record therefore carries a path that no longer exists on disk by the time anyone inspects it. Post-hoc debugging (“what did the agent actually say?”) is not possible: the spawned subprocess stdout is consumed into the in-memory `Turn` and then dropped.

**Reproducer:** See committed `2026-04-18-first-dogfood.detail.yaml` — `transcriptPath: /tmp/cc-judge-acg-rule-coverage.no-raw-throw-to-tagged-bly4H7`, which does not exist.

**Proposed fix (separate task):** either (a) persist the turn transcript as JSON to `resultsDir/transcripts/<scenarioId>.<runNumber>.jsonl` and point `transcriptPath` at that, or (b) if transcripts are explicitly out-of-scope for v1, set `transcriptPath: ""` and remove the field from the schema. Current state is the worst of both worlds.

**Next modality:** `implement-senior` — pipeline + schema + runner coordination (schema change is out-of-scope for junior).

### D3 — MINOR — `dist/bin.js` built without executable bit

**Location:** `package.json` (`"bin": { "cc-judge": "./dist/bin.js" }`), `tsconfig.json`, build script.

`tsc` emits `dist/bin.js` with mode `0644`. The shebang `#!/usr/bin/env node` is present but `./dist/bin.js` fails with `Permission denied`. `pnpm install` inside the repo does not create `node_modules/.bin/cc-judge`, so `pnpm exec cc-judge` also fails until the package is published. The README instruction `pnpm exec cc-judge run ...` cannot succeed against a fresh clone; consumers must fall back to `node dist/bin.js ...`.

**Proposed fix (separate task):** add a post-build step to `chmod +x dist/bin.js`, or declare it at the npm-pack boundary. Optionally add a `package.json#scripts.postbuild`.

**Next modality:** `implement-junior` — one-line script change.

## What worked (and should keep working)

- Scenario YAML loader: accepted the scenario, validated paths, decoded cleanly.
- Judge `pass=false` reasoning cited the real root cause (agent CLI error message) with high confidence (0.98). Judge is doing its job.
- Report triple and Promptfoo emitter both wrote well-formed artifacts; the Promptfoo JSON shape matched `PromptfooResultsSchema`.
- Judge backend worked without `ANTHROPIC_API_KEY` because the host `claude` CLI is OAuth-authenticated and `@anthropic-ai/claude-agent-sdk`'s `query()` inherits that auth. Stub not required.

## Confidence

HIGH — D1 and D2 are reproduced against committed artifacts in this PR (`runs/2026-04-18-first-dogfood.*`). D3 is reproduced by `ls -l /tmp/ccj-dogfood/dist/bin.js` after `pnpm build`.
