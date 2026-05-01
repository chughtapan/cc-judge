// Batch helper for the dominant subprocess embedding stack. Pre-composes
// SubprocessRuntime + PromptWorkspaceHarness + AnthropicJudgeBackend + the
// default ReportEmitter and routes every scenario through `runPlans`.
// Invariant I5: the helper has no private behavior an embedder cannot
// reproduce by composing the four primitives directly.

import { Effect } from "effect";
import type { Report } from "../core/schema.js";
import {
  AgentId,
  type AgentDeclaration,
  type ExecutionArtifact,
  type ProjectId,
  type RunPlan,
  type RunRequirements,
  type ScenarioId,
  type WorkspaceFile,
} from "../core/types.js";
import {
  AnthropicJudgeBackend,
  type AnthropicJudgeBackendOpts,
  type JudgeBackend,
} from "../judge/index.js";
import {
  PromptWorkspaceHarness,
  SubprocessRuntime,
  type AgentRuntime,
  type ExecutionHarness,
  type SubprocessRuntimeOpts,
} from "../runner/index.js";
import type { HarnessRunOpts, PlannedRunInput } from "./opts.js";
import { runPlans } from "./pipeline.js";

export interface SubprocessScenario {
  readonly project: ProjectId;
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly requirements: RunRequirements;
  readonly prompts: readonly [string, ...string[]];
  readonly workspace?: ReadonlyArray<WorkspaceFile>;
  readonly turnTimeoutMs?: number;
  /** Defaults to AgentId(`${scenarioId}-agent`) when omitted. */
  readonly agentId?: AgentId;
  /** Defaults to `scenario.name` when omitted. */
  readonly agentName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface RunSubprocessScenariosBaseOpts
  extends Partial<Omit<HarnessRunOpts, "runtime">> {
  readonly judgeOpts?: AnthropicJudgeBackendOpts;
  /**
   * Single harness reused across every scenario in the batch. Use this when
   * prompts are uniform across the batch or when a custom harness consumes
   * prompts/workspace from plan metadata; the per-scenario `prompts`,
   * `workspace`, and `turnTimeoutMs` fields are ignored when this is set.
   * The dominant single-prompt-per-scenario path leaves this undefined and
   * the helper builds a `PromptWorkspaceHarness` per scenario.
   */
  readonly harness?: ExecutionHarness;
}

type RuntimeSelector =
  | {
      readonly bin: string;
      readonly runtimeOpts?: Partial<Omit<SubprocessRuntimeOpts, "bin">>;
      readonly runtime?: never;
    }
  | {
      readonly runtime: AgentRuntime;
      readonly bin?: never;
      readonly runtimeOpts?: never;
    };

export type RunSubprocessScenariosOpts = RunSubprocessScenariosBaseOpts &
  RuntimeSelector;

// PR-1 transition fallback: until cc-judge#254 (`SubprocessArtifact`) lands,
// the helper synthesizes a `DockerImageArtifact` stub for the agent's
// artifact field. Bin lives on `SubprocessRuntimeOpts` regardless (spec
// §8.1), so subprocess execution is unaffected. Architect §8.4 default;
// follow-up commit will swap to `SubprocessArtifact` once #254 merges.
const PR1_TRANSITION_ARTIFACT: ExecutionArtifact = {
  _tag: "DockerImageArtifact",
  image: "n/a",
};

export function runSubprocessScenarios(
  scenarios: ReadonlyArray<SubprocessScenario>,
  opts: RunSubprocessScenariosOpts,
): Effect.Effect<Report, never, never> {
  const runtime: AgentRuntime = resolveRuntime(opts);
  const judge: JudgeBackend =
    opts.judge ?? new AnthropicJudgeBackend(opts.judgeOpts);

  const inputs: ReadonlyArray<PlannedRunInput> = scenarios.map((scenario) => ({
    plan: buildRunPlan(scenario),
    harness: opts.harness ?? buildPromptWorkspaceHarness(scenario),
    runtime,
  }));

  return runPlans(inputs, mergedHarnessOpts(opts, judge));
}

function resolveRuntime(opts: RunSubprocessScenariosOpts): AgentRuntime {
  if (opts.runtime !== undefined) {
    return opts.runtime;
  }
  return new SubprocessRuntime({
    bin: opts.bin,
    ...(opts.runtimeOpts ?? {}),
  });
}

function buildRunPlan(scenario: SubprocessScenario): RunPlan {
  const agentId = scenario.agentId ?? AgentId(`${scenario.scenarioId}-agent`);
  const agentName = scenario.agentName ?? scenario.name;
  const agent: AgentDeclaration = {
    id: agentId,
    name: agentName,
    artifact: PR1_TRANSITION_ARTIFACT,
    promptInputs: {},
    ...(scenario.metadata !== undefined ? { metadata: scenario.metadata } : {}),
  };
  return {
    project: scenario.project,
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    description: scenario.description,
    agents: [agent],
    requirements: scenario.requirements,
    ...(scenario.metadata !== undefined ? { metadata: scenario.metadata } : {}),
  };
}

function buildPromptWorkspaceHarness(
  scenario: SubprocessScenario,
): PromptWorkspaceHarness {
  return new PromptWorkspaceHarness({
    prompts: scenario.prompts,
    ...(scenario.workspace !== undefined ? { workspace: scenario.workspace } : {}),
    ...(scenario.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: scenario.turnTimeoutMs }
      : {}),
  });
}

function mergedHarnessOpts(
  opts: RunSubprocessScenariosOpts,
  judge: JudgeBackend,
): HarnessRunOpts {
  return {
    judge,
    ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.resultsDir !== undefined ? { resultsDir: opts.resultsDir } : {}),
    ...(opts.logLevel !== undefined ? { logLevel: opts.logLevel } : {}),
    ...(opts.totalTimeoutMs !== undefined
      ? { totalTimeoutMs: opts.totalTimeoutMs }
      : {}),
    ...(opts.emitters !== undefined ? { emitters: opts.emitters } : {}),
    ...(opts.githubComment !== undefined
      ? { githubComment: opts.githubComment }
      : {}),
    ...(opts.githubCommentArtifactUrl !== undefined
      ? { githubCommentArtifactUrl: opts.githubCommentArtifactUrl }
      : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  };
}
