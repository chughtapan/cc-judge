// Acceptance test scaffold for runSubprocessScenarios (issue #253, PR #258).
// Bodies filled by impl-staff per the design doc on issue #253.

import { describe, it } from "vitest";

describe("runSubprocessScenarios", () => {
  it.todo("returns a Report with summary.total === 0 for an empty scenarios array");
  it.todo("runs one scenario through SubprocessRuntime + PromptWorkspaceHarness + AnthropicJudgeBackend by default");
  it.todo("runs N scenarios serially when concurrency is unset (default === 1)");
  it.todo("runs N scenarios in parallel when concurrency > 1 is passed through");
  it.todo("uses opts.runtime when supplied (bin/runtimeOpts ignored at the type level)");
  it.todo("uses opts.bin + opts.runtimeOpts to build the default SubprocessRuntime when runtime is not supplied");
  it.todo("uses opts.judge when supplied; otherwise constructs AnthropicJudgeBackend from opts.judgeOpts");
  it.todo("uses opts.harness when supplied; otherwise builds PromptWorkspaceHarness per scenario from prompts/workspace/turnTimeoutMs");
  it.todo("threads opts.resultsDir, opts.emitters, opts.githubComment, opts.totalTimeoutMs, opts.abortSignal into runPlans");
  it.todo("folds a single scenario's coordination failure into a failed RunRecord without aborting sibling scenarios");
  it.todo("derives agent.id and agent.name from scenarioId when SubprocessScenario.agentId/agentName are omitted");
  it.todo("emits a SubprocessArtifact-tagged agent.artifact (compat: tolerates DockerImageArtifact stub during PR-1 transition)");
});
