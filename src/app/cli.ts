// CLI entrypoints: `cc-judge run` and `cc-judge score`.
// Built on yargs. Exit codes: 0 all-pass, 1 any-fail, 2 fatal.
// Non-interactive by default (spec Goal 12, non-goal #24).

import type { Effect } from "effect";

// Return type is a process exit code. Effect error channel is `never`: fatal errors
// map to exit 2 before the Effect returns.
export type CliExitCode = 0 | 1 | 2;

export declare function main(argv: ReadonlyArray<string>): Effect.Effect<CliExitCode, never, never>;

// Subcommand entrypoints. Called by `main` after yargs parsing.
export declare function runCommand(args: RunCliArgs): Effect.Effect<CliExitCode, never, never>;
export declare function scoreCommand(args: ScoreCliArgs): Effect.Effect<CliExitCode, never, never>;

export interface RunCliArgs {
  readonly scenarioPath: string;
  readonly runtime: "docker" | "subprocess";
  readonly image?: string;
  readonly bin?: string;
  readonly judge: string;
  readonly judgeBackend: string;
  readonly runs: number;
  readonly scenarioIds?: ReadonlyArray<string>;
  readonly results: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
  readonly concurrency: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly totalTimeoutMs?: number;
  readonly emitBraintrust: boolean;
  readonly emitPromptfoo?: string;
}

export interface ScoreCliArgs {
  readonly tracesPath: string;
  readonly traceFormat: "canonical" | "otel";
  readonly judge: string;
  readonly judgeBackend: string;
  readonly results: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
  readonly concurrency: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly totalTimeoutMs?: number;
  readonly emitBraintrust: boolean;
  readonly emitPromptfoo?: string;
}
