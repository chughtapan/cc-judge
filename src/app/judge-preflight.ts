import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface ClaudeAuthStatus {
  readonly loggedIn?: unknown;
}

interface AnthropicAuthSuccessCache {
  readonly checkedAtMs: number;
}

const CLAUDE_PREFLIGHT_TIMEOUT_MS = 5_000;
const ANTHROPIC_AUTH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const ANTHROPIC_AUTH_CACHE_FILE = "anthropic-auth-success.json";

let cachedAnthropicAuthSuccessUntilMs: number | null = null;

function shouldPreflightClaudeAuth(judgeBackend: string): boolean {
  if (judgeBackend !== "anthropic") {
    return false;
  }
  return (process.env["ANTHROPIC_API_KEY"] ?? "").trim().length === 0;
}

function resolveAnthropicAuthCacheDir(): string {
  const configuredCacheDir = (process.env["XDG_CACHE_HOME"] ?? "").trim();
  const baseDir =
    configuredCacheDir.length > 0
      ? configuredCacheDir
      : path.join(os.homedir(), ".cache");
  return path.join(baseDir, "cc-judge");
}

function resolveAnthropicAuthCachePath(): string {
  return path.join(resolveAnthropicAuthCacheDir(), ANTHROPIC_AUTH_CACHE_FILE);
}

function cacheStillFresh(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs > nowMs;
}

function readAnthropicAuthCache(nowMs: number): boolean {
  if (
    cachedAnthropicAuthSuccessUntilMs !== null &&
    cacheStillFresh(cachedAnthropicAuthSuccessUntilMs, nowMs)
  ) {
    return true;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(resolveAnthropicAuthCachePath(), "utf8"),
    ) as AnthropicAuthSuccessCache;
    if (typeof parsed.checkedAtMs !== "number") {
      return false;
    }
    const expiresAtMs = parsed.checkedAtMs + ANTHROPIC_AUTH_CACHE_TTL_MS;
    if (!cacheStillFresh(expiresAtMs, nowMs)) {
      return false;
    }
    cachedAnthropicAuthSuccessUntilMs = expiresAtMs;
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

function writeAnthropicAuthCache(nowMs: number): void {
  const cacheDir = resolveAnthropicAuthCacheDir();
  const cachePath = resolveAnthropicAuthCachePath();
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  const payload: AnthropicAuthSuccessCache = { checkedAtMs: nowMs };

  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(tempPath, JSON.stringify(payload), "utf8");
  renameSync(tempPath, cachePath);
  cachedAnthropicAuthSuccessUntilMs = nowMs + ANTHROPIC_AUTH_CACHE_TTL_MS;
}

export function ensureJudgeReady(judgeBackend: string): string | null {
  if (!shouldPreflightClaudeAuth(judgeBackend)) {
    return null;
  }

  const nowMs = Date.now();
  if (readAnthropicAuthCache(nowMs)) {
    return null;
  }

  const result = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
  });

  if (result.error !== undefined) {
    return `claude auth preflight failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return stderr.length > 0
      ? `claude auth preflight failed: ${stderr}`
      : "claude auth preflight failed";
  }
  try {
    const parsed = JSON.parse(result.stdout) as ClaudeAuthStatus;
    if (parsed.loggedIn !== true) {
      return "claude auth missing: run `claude auth login` or set ANTHROPIC_API_KEY";
    }
    writeAnthropicAuthCache(nowMs);
    return null;
  } catch (error) {
    return error instanceof Error
      ? `claude auth preflight returned invalid JSON: ${error.message}`
      : "claude auth preflight returned invalid JSON";
  }
}

export function resetJudgePreflightCacheForTests(): void {
  cachedAnthropicAuthSuccessUntilMs = null;
}

export function clearJudgePreflightDiskCacheForTests(): void {
  try {
    rmSync(resolveAnthropicAuthCachePath(), { force: true });
  } catch (error) {
    void error;
    // Best-effort cleanup for isolated tests.
  }
}
