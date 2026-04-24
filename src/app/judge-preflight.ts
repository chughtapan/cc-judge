import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  // CLI auth boundary: env presence decides whether the external auth probe is needed.
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
  return (process.env["ANTHROPIC_API_KEY"] ?? "").trim().length === 0;
}

function resolveCacheHome(): string {
  // CLI cache boundary: XDG/OS env is converted to a concrete cache path here.
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
  const xdgCacheHome = (process.env["XDG_CACHE_HOME"] ?? "").trim();
  if (xdgCacheHome.length > 0) {
    return xdgCacheHome;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }
  if (process.platform === "win32") {
    // CLI cache boundary: Windows cache location comes from the host env.
    // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
    const localAppData = (process.env["LOCALAPPDATA"] ?? "").trim();
    if (localAppData.length > 0) {
      return localAppData;
    }
  }
  return path.join(os.homedir(), ".cache");
}

function resolveAnthropicAuthCacheDir(): string {
  return path.join(resolveCacheHome(), "cc-judge");
}

function resolveAnthropicAuthCachePath(): string {
  return path.join(resolveAnthropicAuthCacheDir(), ANTHROPIC_AUTH_CACHE_FILE);
}

function cacheStillFresh(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs > nowMs;
}

function clearInvalidDiskCache(pathname: string): void {
  try {
    rmSync(pathname, { force: true });
  } catch (error) {
    void error;
  }
}

function readAnthropicAuthCache(nowMs: number): boolean {
  if (
    cachedAnthropicAuthSuccessUntilMs !== null &&
    cacheStillFresh(cachedAnthropicAuthSuccessUntilMs, nowMs)
  ) {
    return true;
  }

  const cachePath = resolveAnthropicAuthCachePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("checkedAtMs" in parsed)) {
      clearInvalidDiskCache(cachePath);
      return false;
    }
    const checkedAtMs = parsed.checkedAtMs;
    if (typeof checkedAtMs !== "number" || !Number.isFinite(checkedAtMs)) {
      clearInvalidDiskCache(cachePath);
      return false;
    }
    const expiresAtMs = checkedAtMs + ANTHROPIC_AUTH_CACHE_TTL_MS;
    if (!cacheStillFresh(expiresAtMs, nowMs)) {
      clearInvalidDiskCache(cachePath);
      return false;
    }
    cachedAnthropicAuthSuccessUntilMs = expiresAtMs;
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      clearInvalidDiskCache(cachePath);
    }
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
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("loggedIn" in parsed) ||
      parsed.loggedIn !== true
    ) {
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
  clearInvalidDiskCache(resolveAnthropicAuthCachePath());
}
