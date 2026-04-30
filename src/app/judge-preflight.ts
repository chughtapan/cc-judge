import { Data } from "effect";
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

// No in-process cache by design: an in-memory layer would survive a
// `claude logout` mid-process and serve stale "success" until the Node
// process exits. Long-lived hosts (test runners, daemons) saw this as
// silent staleness. Disk-only caching with a 24h TTL is the source of
// truth; the cost is one extra `claude auth status` call (~50-200ms) on
// the first cc-judge invocation per process.

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
}

// Typed preflight outcome. CLI formats it for stderr; tests assert on the tag.

export type JudgePreflightResult =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "PreflightFailed"; readonly detail: string }
  | { readonly _tag: "AuthMissing" }
  | { readonly _tag: "InvalidJson"; readonly detail: string };

export const JudgePreflightResult = Data.taggedEnum<JudgePreflightResult>();

export const JUDGE_PREFLIGHT_TAG = {
  Ready: "Ready",
  PreflightFailed: "PreflightFailed",
  AuthMissing: "AuthMissing",
  InvalidJson: "InvalidJson",
} as const satisfies { readonly [K in JudgePreflightResult["_tag"]]: K };

export function ensureJudgeReady(judgeBackend: string): JudgePreflightResult {
  if (!shouldPreflightClaudeAuth(judgeBackend)) {
    return JudgePreflightResult.Ready();
  }

  const nowMs = Date.now();
  if (readAnthropicAuthCache(nowMs)) {
    return JudgePreflightResult.Ready();
  }

  const result = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
  });

  if (result.error !== undefined) {
    return JudgePreflightResult.PreflightFailed({ detail: result.error.message });
  }
  if (result.status !== 0) {
    return JudgePreflightResult.PreflightFailed({ detail: result.stderr.trim() });
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("loggedIn" in parsed) ||
      parsed.loggedIn !== true
    ) {
      return JudgePreflightResult.AuthMissing();
    }
    writeAnthropicAuthCache(nowMs);
    return JudgePreflightResult.Ready();
  } catch (error) {
    return JudgePreflightResult.InvalidJson({
      detail: error instanceof Error ? error.message : "",
    });
  }
}

export function formatJudgePreflightMessage(result: JudgePreflightResult): string | null {
  switch (result._tag) {
    case "Ready":
      return null;
    case "PreflightFailed":
      return result.detail.length > 0
        ? `claude auth preflight failed: ${result.detail}`
        : "claude auth preflight failed";
    case "AuthMissing":
      return "claude auth missing: run `claude auth login` or set ANTHROPIC_API_KEY";
    case "InvalidJson":
      return result.detail.length > 0
        ? `claude auth preflight returned invalid JSON: ${result.detail}`
        : "claude auth preflight returned invalid JSON";
  }
}

// Kept as an alias for backward-compat with existing test suites that
// called both reset+clear in beforeEach. With no in-memory cache there is
// no separate "memory" state to reset; both functions now clear the
// disk cache.
export function resetJudgePreflightCacheForTests(): void {
  clearInvalidDiskCache(resolveAnthropicAuthCachePath());
}

export function clearJudgePreflightDiskCacheForTests(): void {
  clearInvalidDiskCache(resolveAnthropicAuthCachePath());
}
