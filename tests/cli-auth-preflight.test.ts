import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { main } from "../src/app/cli.js";
import {
  clearJudgePreflightDiskCacheForTests,
  resetJudgePreflightCacheForTests,
} from "../src/app/judge-preflight.js";
import { itEffect } from "./support/effect.js";

const SAVED_XDG_CACHE_HOME = process.env["XDG_CACHE_HOME"];
const SAVED_ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];

function installStderrCapture(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  type StderrWriteFn = typeof process.stderr.write;
  type StderrWritable = { write: StderrWriteFn };
  const spy: StderrWriteFn = ((value: string | Uint8Array): boolean => {
    chunks.push(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
    return true;
  }) as StderrWriteFn;
  (process.stderr as unknown as StderrWritable).write = spy;
  const restore = (): void => {
    (process.stderr as unknown as StderrWritable).write = original;
  };
  return { chunks, restore };
}

describe("main anthropic auth preflight", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    resetJudgePreflightCacheForTests();
    clearJudgePreflightDiskCacheForTests();
    process.env["XDG_CACHE_HOME"] = mkdtempSync(
      path.join(os.tmpdir(), "cc-judge-cli-auth-cache-"),
    );
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (SAVED_XDG_CACHE_HOME === undefined) {
      delete process.env["XDG_CACHE_HOME"];
    } else {
      process.env["XDG_CACHE_HOME"] = SAVED_XDG_CACHE_HOME;
    }
    if (SAVED_ANTHROPIC_API_KEY === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = SAVED_ANTHROPIC_API_KEY;
    }
  });

  itEffect("fails early with exit 2 when claude auth preflight fails", function* () {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not logged in",
      error: undefined,
    });

    const { chunks, restore } = installStderrCapture();
    const code = yield* Effect.ensuring(
      main(["run", "/tmp/cc-judge-scenario-does-not-matter", "--results", "/tmp/cc-judge-results"]),
      Effect.sync(restore),
    );

    expect(code).toBe(2);
    expect(chunks.join("")).toContain("cc-judge: claude auth preflight failed: not logged in");
  });

  itEffect("reuses the cached success across repeated CLI invocations", function* () {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    yield* main(["run", "/tmp/cc-judge-scenario-missing", "--results", "/tmp/cc-judge-results-a"]);
    yield* main(["run", "/tmp/cc-judge-scenario-missing", "--results", "/tmp/cc-judge-results-b"]);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
