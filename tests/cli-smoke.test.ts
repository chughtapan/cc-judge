// Smoke tests for the @effect/cli-based main() entrypoint.
// These cover parse-path branches that the integration tests in
// tests/plans.test.ts and tests/cli-auth-preflight.test.ts don't reach:
// missing positional, invalid integer, unknown flag, missing --bin
// when --runtime subprocess is set.

import { describe, expect, vi } from "vitest";
import { Effect } from "effect";

// Stub the pipeline so the run command never actually executes.
vi.mock("../src/app/pipeline.js", () => ({
  runPlans: vi.fn(() =>
    Effect.succeed({
      runs: [],
      summary: { total: 0, passed: 0, failed: 0, avgLatencyMs: 0 },
    }),
  ),
}));

// Make the auth preflight a no-op for parse-only paths. The Ready() tagged
// constructor is recreated here so the mock factory stays synchronous and we
// don't need the async-import flow that the no-async-keyword rule forbids.
vi.mock("../src/app/judge-preflight.js", () => ({
  ensureJudgeReady: vi.fn(() => ({ _tag: "Ready" }) as const),
  formatJudgePreflightMessage: vi.fn(() => null),
}));

import { main } from "../src/app/cli.js";
import { itEffect } from "./support/effect.js";
import { captureStream } from "./support/streams.js";
import { installDefaultEnvVar } from "./support/env.js";

installDefaultEnvVar("ANTHROPIC_API_KEY", "test-anthropic-api-key");

const EXIT_FATAL = 2;

describe("cli main() parse-path smoke tests", () => {
  itEffect("rejects unknown subcommand with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["does-not-exist"]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("rejects 'run' with no positional argument with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["run"]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("rejects --concurrency with non-integer value with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["run", "plan.yaml", "--concurrency", "abc"]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("rejects unknown --flag with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["run", "plan.yaml", "--this-flag-doesnt-exist"]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("rejects --log-level with invalid choice with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["run", "plan.yaml", "--log-level", "verbose"]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("rejects --runtime subprocess without --bin with exit 2", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main([
        "run",
        "plan.yaml",
        "--runtime",
        "subprocess",
        "--log-level",
        "error",
      ]);
      expect(code).toBe(EXIT_FATAL);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("--help on the root command exits cleanly", function* () {
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["--help"]);
      expect(code).toBe(0);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  itEffect("--help on 'run' subcommand exits cleanly", function* () {
    // @effect/cli writes help to its internal Terminal layer, not to
    // process.stdout/stderr, so we only assert the exit code here. The
    // shape of the help text is verified manually via `node dist/bin.js
    // run --help` and is asserted by @effect/cli's own tests upstream.
    const stderr = captureStream(process.stderr);
    const stdout = captureStream(process.stdout);
    try {
      const code = yield* main(["run", "--help"]);
      expect(code).toBe(0);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });
});
