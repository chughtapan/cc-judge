import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  clearJudgePreflightDiskCacheForTests,
  ensureJudgeReady,
  resetJudgePreflightCacheForTests,
} from "../src/app/judge-preflight.js";
import { captureEnvVar, restoreEnvVar } from "./support/env.js";

const SAVED_XDG_CACHE_HOME = captureEnvVar("XDG_CACHE_HOME");
const SAVED_ANTHROPIC_API_KEY = captureEnvVar("ANTHROPIC_API_KEY");

describe("judge preflight cache", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    resetJudgePreflightCacheForTests();
    clearJudgePreflightDiskCacheForTests();
    process.env["XDG_CACHE_HOME"] = mkdtempSync(
      path.join(os.tmpdir(), "cc-judge-auth-cache-"),
    );
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    restoreEnvVar("XDG_CACHE_HOME", SAVED_XDG_CACHE_HOME);
    restoreEnvVar("ANTHROPIC_API_KEY", SAVED_ANTHROPIC_API_KEY);
  });

  it("skips preflight entirely when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("caches successful anthropic auth in memory within the same process", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a fresh on-disk success cache after memory reset", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    resetJudgePreflightCacheForTests();
    spawnSyncMock.mockReset();

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("does not cache a failing auth preflight", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not logged in",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toContain("claude auth preflight failed");
    expect(ensureJudgeReady("anthropic")).toContain("claude auth preflight failed");
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("skips anthropic auth preflight for non-anthropic backends", () => {
    expect(ensureJudgeReady("openai")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
