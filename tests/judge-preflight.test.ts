import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "./support/tmpdir.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  JUDGE_PREFLIGHT_TAG,
  clearJudgePreflightDiskCacheForTests,
  ensureJudgeReady,
  resetJudgePreflightCacheForTests,
} from "../src/app/judge-preflight.js";
import { captureEnvVar, deleteEnvVar, restoreEnvVar, setEnvVar } from "./support/env.js";

// Disk cache lives at <xdgCacheHome>/cc-judge/anthropic-auth-success.json.
let currentXdgCacheHome: string | null = null;

function installXdgCacheHome(): string {
  const dir = makeTempDir("auth-cache");
  setEnvVar("XDG_CACHE_HOME", dir);
  currentXdgCacheHome = dir;
  return dir;
}

function cacheFilePath(): string {
  if (currentXdgCacheHome === null) {
    throw new Error("test invariant: installXdgCacheHome not called this test");
  }
  return path.join(currentXdgCacheHome, "cc-judge", "anthropic-auth-success.json");
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

const SAVED_XDG_CACHE_HOME = captureEnvVar("XDG_CACHE_HOME");
const SAVED_ANTHROPIC_API_KEY = captureEnvVar("ANTHROPIC_API_KEY");

describe("judge preflight cache", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    resetJudgePreflightCacheForTests();
    clearJudgePreflightDiskCacheForTests();
    installXdgCacheHome();
    deleteEnvVar("ANTHROPIC_API_KEY");
  });

  afterEach(() => {
    restoreEnvVar("XDG_CACHE_HOME", SAVED_XDG_CACHE_HOME);
    restoreEnvVar("ANTHROPIC_API_KEY", SAVED_ANTHROPIC_API_KEY);
  });

  it("skips preflight entirely when ANTHROPIC_API_KEY is set", () => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("reuses the disk cache for back-to-back anthropic preflight calls", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs preflight after the disk cache is cleared", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    clearJudgePreflightDiskCacheForTests();
    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failing auth preflight", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not logged in",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("skips anthropic auth preflight for non-anthropic backends", () => {
    expect(ensureJudgeReady("openai")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // ── disk cache validation paths ───────────────────────────────────────────

  it("re-runs preflight and rewrites cache when on-disk JSON is malformed", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "not json {{{", "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const rewritten = JSON.parse(readFileSync(cachePath, "utf8")) as { checkedAtMs?: unknown };
    expect(Number.isFinite(rewritten.checkedAtMs)).toBe(true);
  });

  it("re-runs preflight when cached checkedAtMs is non-numeric", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: "yesterday" }), "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs preflight when cached checkedAtMs is older than the 24h TTL", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const expiredCheckedAt = Date.now() - 2 * TWENTY_FOUR_HOURS_MS;
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: expiredCheckedAt }), "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const rewritten = JSON.parse(readFileSync(cachePath, "utf8")) as { checkedAtMs: number };
    expect(rewritten.checkedAtMs).toBeGreaterThan(expiredCheckedAt);
  });

  it("re-runs preflight when cache JSON is missing the checkedAtMs key entirely", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ wrong: "shape" }), "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs preflight when cache root JSON is null", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(null), "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs preflight when checkedAtMs is null (non-finite)", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, '{"checkedAtMs":null}', "utf8");

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  // ── claude binary failure modes ───────────────────────────────────────────

  it("surfaces an ENOENT-like result.error from spawnSync as PreflightFailed", () => {
    const errorMessage = "spawn claude ENOENT";
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error(errorMessage),
    });

    const result = ensureJudgeReady("anthropic");
    expect(result._tag).toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    if (result._tag === JUDGE_PREFLIGHT_TAG.PreflightFailed) {
      expect(result.detail).toBe(errorMessage);
    }
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("returns the trimmed stderr when claude exits non-zero with a message", () => {
    const stderrMessage = "not logged in";
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: `  ${stderrMessage}  \n`,
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result._tag).toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    if (result._tag === JUDGE_PREFLIGHT_TAG.PreflightFailed) {
      expect(result.detail).toBe(stderrMessage);
    }
  });

  it("returns PreflightFailed with empty detail when stderr is empty on non-zero exit", () => {
    spawnSyncMock.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result._tag).toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    if (result._tag === JUDGE_PREFLIGHT_TAG.PreflightFailed) {
      expect(result.detail).toBe("");
    }
  });

  it("treats malformed JSON stdout as an InvalidJson preflight failure", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "this is not json",
      stderr: "",
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result._tag).toBe(JUDGE_PREFLIGHT_TAG.InvalidJson);
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("treats loggedIn=false as AuthMissing and does not cache", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.AuthMissing);
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("treats stdout without a loggedIn key as AuthMissing", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ otherField: 1 }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.AuthMissing);
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  // ── disk cache write side effect ──────────────────────────────────────────

  it("writes a success cache atomically (no .tmp leftover after successful preflight)", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);

    const cachePath = cacheFilePath();
    expect(existsSync(cachePath)).toBe(true);
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });
});
