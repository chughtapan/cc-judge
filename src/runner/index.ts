// AgentRunner interface + bundled DockerRunner, SubprocessRunner.
// Responsibility: execute one agent turn, capture workspace diff, tear down.
// Invariant: stop() never fails (teardown is crash-only).

import type { Effect } from "effect";
import type {
  AgentRunTimeoutError,
  AgentStartError,
} from "../core/errors.js";
import type { RuntimeKind, Turn, WorkspaceDiff } from "../core/types.js";
import type { Scenario } from "../core/schema.js";

// Branded handle: opaque to callers, owned by the runner.
export interface AgentHandle {
  readonly __brand: "AgentHandle";
  readonly kind: RuntimeKind;
  readonly scenarioId: string;
}

export interface AgentRunner {
  readonly kind: RuntimeKind;

  // Boot the agent for a scenario (mount workspace, seed setupPrompt context, wait-for-ready).
  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never>;

  // Send one prompt, wait for terminal result/success (or timeout), return the populated Turn.
  turn(
    handle: AgentHandle,
    prompt: string,
    opts: { readonly timeoutMs: number },
  ): Effect.Effect<Turn, AgentRunTimeoutError, never>;

  // Snapshot the workspace delta relative to scenario.workspace.
  diff(handle: AgentHandle): Effect.Effect<WorkspaceDiff, never, never>;

  // Teardown. Invariant: never fails; internal errors are logged and swallowed.
  stop(handle: AgentHandle): Effect.Effect<void, never, never>;
}

export interface DockerRunnerOpts {
  // Spec Q-ARCH-2: no default. Caller must supply an image identifier.
  // Docs recommend `ghcr.io/anthropics/claude-code:latest` as a reference.
  readonly image: string;
  readonly network?: "none" | "bridge";
  readonly memoryMb?: number;
  readonly cpus?: number;
}

export declare class DockerRunner implements AgentRunner {
  readonly kind: "docker";
  constructor(opts: DockerRunnerOpts);
  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never>;
  turn(h: AgentHandle, prompt: string, opts: { readonly timeoutMs: number }): Effect.Effect<Turn, AgentRunTimeoutError, never>;
  diff(h: AgentHandle): Effect.Effect<WorkspaceDiff, never, never>;
  stop(h: AgentHandle): Effect.Effect<void, never, never>;
}

export interface SubprocessRunnerOpts {
  // Path to a local `claude` binary (spec assumption #4 — spike-proven in moltzap).
  readonly bin: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export declare class SubprocessRunner implements AgentRunner {
  readonly kind: "subprocess";
  constructor(opts: SubprocessRunnerOpts);
  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never>;
  turn(h: AgentHandle, prompt: string, opts: { readonly timeoutMs: number }): Effect.Effect<Turn, AgentRunTimeoutError, never>;
  diff(h: AgentHandle): Effect.Effect<WorkspaceDiff, never, never>;
  stop(h: AgentHandle): Effect.Effect<void, never, never>;
}
