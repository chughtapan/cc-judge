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
  clearJudgePreflightDiskCacheForTests,
  ensureJudgeReady,
  resetJudgePreflightCacheForTests,
} from "../src/app/judge-preflight.js";
import { captureEnvVar, deleteEnvVar, restoreEnvVar, setEnvVar } from "./support/env.js";

// Disk cache lives at <xdgCacheHome>/cc-judge/anthropic-auth-success.json.
// `installXdgCacheHome` in beforeEach captures the per-test path so tests
// can read/seed the cache file without touching process.env at runtime.
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

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("reuses the disk cache for back-to-back anthropic preflight calls", () => {
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

  it("re-runs preflight after the disk cache is cleared", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // No in-memory cache survives a disk cache clear: the next call
    // must hit `claude auth status` again.
    clearJudgePreflightDiskCacheForTests();
    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
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

  // ── disk cache validation paths ───────────────────────────────────────────

  it("re-runs preflight and rewrites cache when on-disk JSON is malformed", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    // Pre-stage a corrupt cache file.
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "not json {{{", "utf8");

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    // Cache was rewritten with a valid record.
    const rewritten = JSON.parse(readFileSync(cachePath, "utf8")) as { checkedAtMs?: unknown };
    expect(typeof rewritten.checkedAtMs).toBe("number");
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

    expect(ensureJudgeReady("anthropic")).toBeNull();
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
    // Pin the timestamp to two days ago so the TTL boundary is unambiguous.
    const expiredCheckedAt = Date.now() - 2 * TWENTY_FOUR_HOURS_MS;
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: expiredCheckedAt }), "utf8");

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    // Cache was overwritten — no longer expired.
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

    expect(ensureJudgeReady("anthropic")).toBeNull();
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

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs preflight when checkedAtMs is Infinity (non-finite)", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      error: undefined,
    });
    const cachePath = cacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    // JSON.stringify converts Infinity to null, so write a hand-crafted
    // body that JSON.parse will return Infinity for is impossible. Use NaN
    // path: write `{"checkedAtMs":null}` which fails the typeof check via
    // `parsed.checkedAtMs` being null, not number.
    writeFileSync(cachePath, '{"checkedAtMs":null}', "utf8");

    expect(ensureJudgeReady("anthropic")).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  // ── claude binary failure modes ───────────────────────────────────────────

  it("surfaces an ENOENT-like result.error from spawnSync as 'preflight failed'", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn claude ENOENT"),
    });

    const result = ensureJudgeReady("anthropic");
    expect(result).toContain("claude auth preflight failed");
    expect(result).toContain("ENOENT");
    // Failed preflight does NOT write a success cache.
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("returns the trimmed stderr when claude exits non-zero with a message", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "  not logged in  \n",
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result).toContain("not logged in");
    // Surrounding whitespace was trimmed out of the message.
    expect(result).not.toMatch(/\s\snot logged in/u);
  });

  it("returns a generic 'preflight failed' when stderr is empty on non-zero exit", () => {
    spawnSyncMock.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toBe("claude auth preflight failed");
  });

  it("treats malformed JSON stdout as an invalid-JSON preflight failure", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "this is not json",
      stderr: "",
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result).toContain("invalid JSON");
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("treats loggedIn=false as the 'auth missing' message and does not cache", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      error: undefined,
    });

    const result = ensureJudgeReady("anthropic");
    expect(result).toContain("claude auth missing");
    expect(result).toContain("claude auth login");
    expect(result).toContain("ANTHROPIC_API_KEY");
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  it("treats stdout without a loggedIn key as 'auth missing'", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ otherField: 1 }),
      stderr: "",
      error: undefined,
    });

    expect(ensureJudgeReady("anthropic")).toContain("claude auth missing");
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

    expect(ensureJudgeReady("anthropic")).toBeNull();

    const cachePath = cacheFilePath();
    expect(existsSync(cachePath)).toBe(true);
    // The atomic write uses ${cachePath}.${pid}.tmp; no such file should
    // remain after a successful renameSync.
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });
});
