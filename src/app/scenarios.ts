// Batch helper for the dominant subprocess embedding stack.
// Stub for issue #253; impl-staff fills the body in PR #258.

import type { Effect } from "effect";
import type { Report } from "../core/schema.js";
import type {
  AgentId,
  ProjectId,
  RunRequirements,
  ScenarioId,
  WorkspaceFile,
} from "../core/types.js";
import type { AnthropicJudgeBackendOpts } from "../judge/index.js";
import type {
  AgentRuntime,
  ExecutionHarness,
  SubprocessRuntimeOpts,
} from "../runner/index.js";
import type { HarnessRunOpts } from "./opts.js";

export interface SubprocessScenario {
  readonly project: ProjectId;
  readonly scenarioId: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly requirements: RunRequirements;
  readonly prompts: readonly [string, ...string[]];
  readonly workspace?: ReadonlyArray<WorkspaceFile>;
  readonly turnTimeoutMs?: number;
  readonly agentId?: AgentId;
  readonly agentName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface RunSubprocessScenariosBaseOpts
  extends Partial<Omit<HarnessRunOpts, "runtime">> {
  readonly judgeOpts?: AnthropicJudgeBackendOpts;
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

export function runSubprocessScenarios(
  scenarios: ReadonlyArray<SubprocessScenario>,
  opts: RunSubprocessScenariosOpts,
): Effect.Effect<Report, never, never> {
  void scenarios;
  void opts;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub; impl-staff replaces this body in PR #258 (issue #253).
  throw new Error("not implemented");
}
