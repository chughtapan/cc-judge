// CLI entrypoints: `cc-judge run` and `cc-judge inspect`.
// Built on @effect/cli — declarative options + args, validated parsing,
// errors flow as tagged unions through the Effect channel.
//
// Exit codes: 0 all-pass, 1 any-fail, 2 fatal/preflight-failed/parse-error.

import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { absurd } from "../core/types.js";
import { BraintrustEmitter, PromptfooEmitter, type ObservabilityEmitter } from "../emit/observability.js";
import { AnthropicJudgeBackend } from "../judge/index.js";
import { SubprocessRuntime, type AgentRuntime } from "../runner/index.js";
import { runPlannedHarnessPath } from "../plans/compiler.js";
import { ensureJudgeReady, formatJudgePreflightMessage } from "./judge-preflight.js";
import { inspectRunAndPrint, type InspectErrorCause } from "./inspect.js";

export type CliExitCode = 0 | 1 | 2;

const DEFAULT_JUDGE_MODEL = "claude-opus-4-7";
const DEFAULT_JUDGE_BACKEND = "anthropic";
const DEFAULT_RESULTS_DIR = "./eval-results";
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LOG_LEVEL = "info" as const;

type LogLevel = "debug" | "info" | "warn" | "error";

// ── option builders ─────────────────────────────────────────────────────────
//
// Each Options/Args declaration is a contract: yargs's `unknown`-coerce
// goes away, and an invalid `--concurrency abc` fails at parse time with
// a typed error instead of silently coercing to the default.

const judgeOpt = Options.text("judge").pipe(
  Options.withDescription("Judge model identifier"),
  Options.withDefault(DEFAULT_JUDGE_MODEL),
);

const judgeBackendOpt = Options.text("judge-backend").pipe(
  Options.withDescription("Judge backend"),
  Options.withDefault(DEFAULT_JUDGE_BACKEND),
);

const resultsOpt = Options.text("results").pipe(
  Options.withDescription("Output directory for summary, results.jsonl, details/"),
  Options.withDefault(DEFAULT_RESULTS_DIR),
);

const concurrencyOpt = Options.integer("concurrency").pipe(
  Options.withDescription("Maximum concurrent harness runs"),
  Options.withDefault(DEFAULT_CONCURRENCY),
);

const logLevelOpt = Options.choice("log-level", ["debug", "info", "warn", "error"] as const).pipe(
  Options.withDescription("Log verbosity"),
  Options.withDefault(DEFAULT_LOG_LEVEL),
);

const totalTimeoutMsOpt = Options.integer("total-timeout-ms").pipe(
  Options.withDescription("Wall-clock cap for the entire run, in milliseconds"),
  Options.optional,
);

const githubCommentOpt = Options.integer("github-comment").pipe(
  Options.withDescription("GitHub PR number to publish the summary comment on"),
  Options.optional,
);

const githubCommentArtifactUrlOpt = Options.text("github-comment-artifact-url").pipe(
  Options.withDescription("Artifact URL to link in the GitHub PR comment"),
  Options.optional,
);

const emitBraintrustOpt = Options.boolean("emit-braintrust").pipe(
  Options.withDescription("Emit results to Braintrust (requires BRAINTRUST_API_KEY)"),
  Options.withDefault(false),
);

const emitPromptfooOpt = Options.text("emit-promptfoo").pipe(
  Options.withDescription("Path to write a Promptfoo-shaped results file"),
  Options.optional,
);

const runtimeOpt = Options.choice("runtime", ["subprocess"] as const).pipe(
  Options.withDescription("Override the harness runtime (compatibility flag)"),
  Options.optional,
);

const binOpt = Options.text("bin").pipe(
  Options.withDescription("Path to the agent binary when --runtime subprocess is set"),
  Options.optional,
);

const runInputArg = Args.text({ name: "input" }).pipe(
  Args.withDescription("Plan YAML file, glob, or directory"),
);

const inspectRunIdArg = Args.text({ name: "runId" }).pipe(
  Args.withDescription("Run identifier (matches inflight/<id>.jsonl or runs/<id>.jsonl)"),
);

// ── handler helpers ─────────────────────────────────────────────────────────

function buildObservability(
  emitBraintrust: boolean,
  emitPromptfoo: Option.Option<string>,
): ReadonlyArray<ObservabilityEmitter> {
  const emitters: ObservabilityEmitter[] = [];
  if (emitBraintrust) {
    // CLI boundary: env is converted into typed emitter config here.
    // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
    const apiKey = process.env["BRAINTRUST_API_KEY"];
    // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
    const project = process.env["BRAINTRUST_PROJECT"] ?? "cc-judge";
    if (apiKey !== undefined && apiKey.length > 0) {
      emitters.push(new BraintrustEmitter({ apiKey, project }));
    }
  }
  if (Option.isSome(emitPromptfoo)) {
    emitters.push(new PromptfooEmitter({ outputPath: emitPromptfoo.value }));
  }
  return emitters;
}

function resolveSubprocessRuntime(
  runtime: Option.Option<"subprocess">,
  bin: Option.Option<string>,
): AgentRuntime | undefined | "missing-bin" {
  if (Option.isNone(runtime) && Option.isNone(bin)) return undefined;
  if (Option.isNone(bin)) return "missing-bin";
  return new SubprocessRuntime({ bin: bin.value });
}

// Tracks the last exit code chosen by a command handler so the runtime
// layer can read it after the program completes. @effect/cli command
// handlers don't return values; this side-channel lets the two commands
// signal pass/fail to cliEntrypoint. `main()` reads the same channel
// synchronously before resetting it.
let lastExitCode: CliExitCode = 0;

function setExitCode(code: CliExitCode): void {
  lastExitCode = code;
}

function consumeExitCode(): CliExitCode {
  const code = lastExitCode;
  lastExitCode = 0;
  return code;
}

// ── run command ─────────────────────────────────────────────────────────────

interface RunArgs {
  readonly input: string;
  readonly judge: string;
  readonly judgeBackend: string;
  readonly results: string;
  readonly concurrency: number;
  readonly logLevel: LogLevel;
  readonly totalTimeoutMs: Option.Option<number>;
  readonly githubComment: Option.Option<number>;
  readonly githubCommentArtifactUrl: Option.Option<string>;
  readonly emitBraintrust: boolean;
  readonly emitPromptfoo: Option.Option<string>;
  readonly runtime: Option.Option<"subprocess">;
  readonly bin: Option.Option<string>;
}

function runHandler(args: RunArgs): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const runtimeOverride = resolveSubprocessRuntime(args.runtime, args.bin);
    if (runtimeOverride === "missing-bin") {
      process.stderr.write("cc-judge: runtime resolution failed: subprocess: missing --bin\n");
      setExitCode(2);
      return;
    }

    const preflightMessage = formatJudgePreflightMessage(ensureJudgeReady(args.judgeBackend));
    if (preflightMessage !== null) {
      process.stderr.write(`cc-judge: ${preflightMessage}\n`);
      setExitCode(2);
      return;
    }

    const judge = new AnthropicJudgeBackend({ model: args.judge });
    const emitters = buildObservability(args.emitBraintrust, args.emitPromptfoo);

    const report = yield* runPlannedHarnessPath(args.input, {
      judge,
      resultsDir: args.results,
      concurrency: args.concurrency,
      emitters,
      logLevel: args.logLevel,
      ...(runtimeOverride !== undefined ? { runtime: runtimeOverride } : {}),
      ...(Option.isSome(args.githubComment) ? { githubComment: args.githubComment.value } : {}),
      ...(Option.isSome(args.githubCommentArtifactUrl)
        ? { githubCommentArtifactUrl: args.githubCommentArtifactUrl.value }
        : {}),
      ...(Option.isSome(args.totalTimeoutMs) ? { totalTimeoutMs: args.totalTimeoutMs.value } : {}),
    }).pipe(
      Effect.catchTag("PlannedHarnessIngressError", (error) =>
        Effect.sync(() => {
          process.stderr.write(`cc-judge: harness run failed: ${error.cause._tag}\n`);
          return null;
        }),
      ),
    );

    if (report === null) {
      setExitCode(2);
      return;
    }

    process.stdout.write(`cc-judge: ${String(report.summary.passed)}/${String(report.summary.total)} passed\n`);
    setExitCode(report.summary.failed === 0 ? 0 : 1);
  });
}

const runCommand = Command.make(
  "run",
  {
    input: runInputArg,
    judge: judgeOpt,
    judgeBackend: judgeBackendOpt,
    results: resultsOpt,
    concurrency: concurrencyOpt,
    logLevel: logLevelOpt,
    totalTimeoutMs: totalTimeoutMsOpt,
    githubComment: githubCommentOpt,
    githubCommentArtifactUrl: githubCommentArtifactUrlOpt,
    emitBraintrust: emitBraintrustOpt,
    emitPromptfoo: emitPromptfooOpt,
    runtime: runtimeOpt,
    bin: binOpt,
  },
  runHandler,
).pipe(Command.withDescription("Run harness-backed plans"));

// ── inspect command ─────────────────────────────────────────────────────────

interface InspectArgs {
  readonly runId: string;
  readonly results: string;
}

function inspectHandler(args: InspectArgs): Effect.Effect<void, never, never> {
  return inspectRunAndPrint(args.runId, args.results).pipe(
    Effect.tap(() => Effect.sync(() => setExitCode(0))),
    Effect.catchTag("InspectError", (error) =>
      Effect.sync(() => {
        const cause: InspectErrorCause = error.cause;
        switch (cause._tag) {
          case "RunNotFound":
            process.stderr.write(`cc-judge: inspect: run not found: ${cause.runId}\n`);
            setExitCode(2);
            return;
          case "DuplicateSeq":
            process.stderr.write(
              `cc-judge: inspect: duplicate seq ${String(cause.seq)} in run ${cause.runId}\n`,
            );
            setExitCode(2);
            return;
          default:
            absurd(cause);
        }
      }),
    ),
  );
}

const inspectCommand = Command.make(
  "inspect",
  { runId: inspectRunIdArg, results: resultsOpt },
  inspectHandler,
).pipe(Command.withDescription("Inspect a run's WAL timeline"));

// ── top-level ───────────────────────────────────────────────────────────────

const ccJudgeCommand = Command.make("cc-judge").pipe(
  Command.withDescription("Planned Claude Code harness runs + LLM bundle judging."),
  Command.withSubcommands([runCommand, inspectCommand]),
);

const cli = Command.run(ccJudgeCommand, {
  name: "cc-judge",
  version: "0.0.1",
});

/**
 * Parse + execute one CLI invocation. Resolves to the chosen exit code.
 * On parse failure (unknown option, missing positional, invalid choice),
 * @effect/cli prints a HelpDoc to stderr and the surrounding fiber fails;
 * we map that to exit code 2.
 *
 * Provides NodeContext.layer so the @effect/cli internals (FileSystem,
 * Path, Terminal) are satisfied; tests call this with a synthetic argv
 * and runPromise the result.
 */
export function main(argv: ReadonlyArray<string>): Effect.Effect<CliExitCode, never, never> {
  // @effect/cli expects the full process.argv shape (node + script + args),
  // so prepend two placeholders if the caller passed bare argv.
  const fullArgv = ["node", "cc-judge", ...argv];
  return cli(fullArgv).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => consumeExitCode()),
      onFailure: () => Effect.sync(() => 2 as CliExitCode),
    }),
    Effect.provide(NodeContext.layer),
  );
}

/**
 * Process entrypoint used by bin.ts. Runs main() under NodeRuntime,
 * which installs SIGINT/SIGTERM handlers, prints uncaught defects, and
 * exits with the chosen code.
 */
export function cliEntrypoint(): void {
  const program = main(process.argv.slice(2)).pipe(
    Effect.tap((code) => Effect.sync(() => process.exit(code))),
  );
  NodeRuntime.runMain(program);
}
