// AgentRunner interface + bundled DockerRunner, SubprocessRunner.
// Invariant: stop() never fails (teardown is crash-only).

import { Effect } from "effect";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  AgentStartError,
  AgentRunTimeoutError,
  type AgentStartErrorCause,
} from "../core/errors.js";
import {
  ScenarioId,
  type RuntimeKind,
  type Turn,
  type WorkspaceDiff,
  type WorkspaceFileChange,
  type WorkspaceFile,
} from "../core/types.js";
import type { Scenario } from "../core/schema.js";

export interface AgentHandle {
  readonly __brand: "AgentHandle";
  readonly kind: RuntimeKind;
  readonly scenarioId: string;
  readonly workspaceDir: string;
  readonly containerId?: string;
  readonly initialFiles: ReadonlyMap<string, string>;
  readonly turnsExecuted: { count: number };
}

export interface AgentRunner {
  readonly kind: RuntimeKind;
  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never>;
  turn(
    handle: AgentHandle,
    prompt: string,
    opts: { readonly timeoutMs: number },
  ): Effect.Effect<Turn, AgentRunTimeoutError, never>;
  diff(handle: AgentHandle): Effect.Effect<WorkspaceDiff, never, never>;
  stop(handle: AgentHandle): Effect.Effect<void, never, never>;
}

// Shared: write workspace files + capture initial snapshot (before agent runs).
function makeWorkspace(scenario: Scenario): { dir: string; initialFiles: Map<string, string> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cc-judge-${scenario.id}-`));
  const initialFiles = new Map<string, string>();
  const files: ReadonlyArray<WorkspaceFile> = scenario.workspace ?? [];
  for (const wf of files) {
    const abs = path.join(dir, wf.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, wf.content, "utf8");
    initialFiles.set(wf.path, wf.content);
  }
  return { dir, initialFiles };
}

function walkWorkspace(dir: string): Effect.Effect<ReadonlyMap<string, string>, never, never> {
  const out = new Map<string, string>();
  return walkInto(dir, dir, out).pipe(Effect.map(() => out as ReadonlyMap<string, string>));
}

function walkInto(
  root: string,
  cur: string,
  out: Map<string, string>,
): Effect.Effect<void, never, never> {
  const listing = Effect.tryPromise({
    try: () => readdir(cur, { withFileTypes: true }),
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed([])));

  return listing.pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (e) => {
          const abs = path.join(cur, e.name);
          if (e.isDirectory()) return walkInto(root, abs, out);
          if (e.isFile()) {
            return Effect.tryPromise({
              try: () => readFile(abs, "utf8"),
              catch: () => null,
            }).pipe(
              Effect.match({
                onFailure: () => undefined,
                onSuccess: (content: string) => {
                  out.set(path.relative(root, abs), content);
                },
              }),
            );
          }
          return Effect.succeed(undefined);
        },
        { discard: true },
      ),
    ),
  );
}

function computeDiff(
  initial: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): WorkspaceDiff {
  const changed: WorkspaceFileChange[] = [];
  const seen = new Set<string>();
  for (const [relPath, before] of initial) {
    seen.add(relPath);
    const after = current.get(relPath);
    if (after === undefined) {
      changed.push({ path: relPath, before, after: null });
    } else if (after !== before) {
      changed.push({ path: relPath, before, after });
    }
  }
  for (const [relPath, after] of current) {
    if (!seen.has(relPath)) {
      changed.push({ path: relPath, before: null, after });
    }
  }
  return { changed };
}

// Simple stdout parser: tries JSON-stream-of-events first, falls back to text.
// Claude Agent SDK CLI emits one JSON object per line with `type: "assistant" | "result" | "tool_use" | ...`
// when called with `--output-format stream-json`.
interface ParsedTurn {
  readonly response: string;
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface StreamJsonEvent {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly result?: unknown;
  readonly usage?: unknown;
}

interface StreamJsonUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

function parseStreamJson(stdout: string): ParsedTurn {
  let response = "";
  let toolCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let sawStructured = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      void err;
      // Non-JSON line: ignored. The fallback path below handles pure-text agents.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    sawStructured = true;
    const obj: StreamJsonEvent = parsed;
    const type = typeof obj.type === "string" ? obj.type : "";
    switch (type) {
      case "assistant": {
        const content = obj.content;
        if (typeof content === "string") response += content;
        break;
      }
      case "result": {
        const result = obj.result;
        if (typeof result === "string") response = response.length > 0 ? response : result;
        break;
      }
      case "tool_use":
      case "tool_call": {
        toolCallCount += 1;
        break;
      }
      default:
        // Other events (system, user echoes) ignored.
        break;
    }
    const usage = obj.usage;
    if (typeof usage === "object" && usage !== null) {
      const u: StreamJsonUsage = usage;
      if (typeof u.input_tokens === "number") inputTokens += u.input_tokens;
      if (typeof u.output_tokens === "number") outputTokens += u.output_tokens;
      if (typeof u.cache_read_input_tokens === "number") cacheReadTokens += u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === "number") cacheWriteTokens += u.cache_creation_input_tokens;
    }
  }
  if (!sawStructured) {
    response = stdout;
  }
  return { response, toolCallCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// -------------------- SubprocessRunner --------------------

export interface SubprocessRunnerOpts {
  readonly bin: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  // Extra argv passed before the prompt. Default: ["-p", "--output-format", "stream-json"].
  readonly extraArgs?: ReadonlyArray<string>;
}

const DEFAULT_CLAUDE_ARGS: ReadonlyArray<string> = ["-p", "--output-format", "stream-json"];

export class SubprocessRunner implements AgentRunner {
  readonly kind: "subprocess" = "subprocess";
  readonly #opts: SubprocessRunnerOpts;

  constructor(opts: SubprocessRunnerOpts) {
    this.#opts = opts;
  }

  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never> {
    return Effect.suspend(() => {
      if (!existsSync(this.#opts.bin)) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: scenario.id,
            cause: { _tag: "BinaryNotFound", path: this.#opts.bin } as AgentStartErrorCause,
          }),
        );
      }
      try {
        const { dir, initialFiles } = makeWorkspace(scenario);
        const handle: AgentHandle = {
          __brand: "AgentHandle",
          kind: "subprocess",
          scenarioId: scenario.id,
          workspaceDir: dir,
          initialFiles,
          turnsExecuted: { count: 0 },
        };
        return Effect.succeed(handle);
      } catch (err: unknown) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: scenario.id,
            cause: {
              _tag: "WorkspaceSetupFailed",
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    });
  }

  turn(
    handle: AgentHandle,
    prompt: string,
    opts: { readonly timeoutMs: number },
  ): Effect.Effect<Turn, AgentRunTimeoutError, never> {
    const turnIndex = handle.turnsExecuted.count;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const args = [...(this.#opts.extraArgs ?? DEFAULT_CLAUDE_ARGS), prompt];
    const cwd = this.#opts.cwd ?? handle.workspaceDir;
    const spawnEnv = this.#opts.env ?? undefined;

    return Effect.async<Turn, AgentRunTimeoutError, never>((resume) => {
      let finished = false;
      const child: ChildProcess = spawn(this.#opts.bin, args, {
        cwd,
        env: spawnEnv !== undefined ? { ...process.env, ...spawnEnv } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          child.kill("SIGKILL");
        } catch (err) { void err;
          // Process may already be gone; teardown proceeds regardless (invariant #7).
        }
        resume(
          Effect.fail(
            new AgentRunTimeoutError({
              scenarioId: ScenarioId(handle.scenarioId),
              turnIndex,
              timeoutMs: opts.timeoutMs,
            }),
          ),
        );
      }, opts.timeoutMs);
      child.on("close", () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        handle.turnsExecuted.count += 1;
        const parsed = parseStreamJson(stdout);
        const responseText = parsed.response.length > 0 ? parsed.response : stderr;
        const turn: Turn = {
          index: turnIndex,
          prompt,
          response: responseText,
          startedAt,
          latencyMs: Date.now() - startMs,
          toolCallCount: parsed.toolCallCount,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
        };
        resume(Effect.succeed(turn));
      });
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Spawn error mid-run: surface as a timeout-tagged failure so the pipeline
        // folds it into a critical-severity RunRecord via the judge.
        resume(
          Effect.fail(
            new AgentRunTimeoutError({
              scenarioId: ScenarioId(handle.scenarioId),
              turnIndex,
              timeoutMs: opts.timeoutMs,
            }),
          ),
        );
        void err;
      });
      return Effect.sync(() => {
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch (err) { void err;
          // Nothing to clean up — kill is best-effort during interruption.
        }
      });
    });
  }

  diff(handle: AgentHandle): Effect.Effect<WorkspaceDiff, never, never> {
    return walkWorkspace(handle.workspaceDir).pipe(
      Effect.map((current) => computeDiff(handle.initialFiles, current)),
    );
  }

  stop(handle: AgentHandle): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      try {
        rmSync(handle.workspaceDir, { recursive: true, force: true });
      } catch (err) { void err;
        // Teardown is best-effort. Invariant #7: stop never fails.
      }
    });
  }
}

// -------------------- DockerRunner --------------------

export interface DockerRunnerOpts {
  readonly image: string;
  readonly network?: "none" | "bridge";
  readonly memoryMb?: number;
  readonly cpus?: number;
}

export class DockerRunner implements AgentRunner {
  readonly kind: "docker" = "docker";
  readonly #opts: DockerRunnerOpts;

  constructor(opts: DockerRunnerOpts) {
    this.#opts = opts;
  }

  start(scenario: Scenario): Effect.Effect<AgentHandle, AgentStartError, never> {
    return Effect.suspend(() => {
      const imageAvailable = dockerImageExists(this.#opts.image);
      if (!imageAvailable) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: scenario.id,
            cause: { _tag: "ImageMissing", image: this.#opts.image },
          }),
        );
      }
      try {
        const { dir, initialFiles } = makeWorkspace(scenario);
        const network = this.#opts.network ?? "none";
        const args = [
          "create",
          "--rm",
          "-v",
          `${dir}:/workspace`,
          "-w",
          "/workspace",
          "--network",
          network,
          ...(this.#opts.memoryMb !== undefined ? ["--memory", `${this.#opts.memoryMb}m`] : []),
          ...(this.#opts.cpus !== undefined ? ["--cpus", String(this.#opts.cpus)] : []),
          this.#opts.image,
          "tail",
          "-f",
          "/dev/null",
        ];
        const cid = execSync(`docker ${args.map(shellQuote).join(" ")}`, { stdio: ["ignore", "pipe", "pipe"] })
          .toString("utf8")
          .trim();
        execSync(`docker start ${shellQuote(cid)}`, { stdio: "ignore" });
        const handle: AgentHandle = {
          __brand: "AgentHandle",
          kind: "docker",
          scenarioId: scenario.id,
          workspaceDir: dir,
          containerId: cid,
          initialFiles,
          turnsExecuted: { count: 0 },
        };
        return Effect.succeed(handle);
      } catch (err: unknown) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: scenario.id,
            cause: {
              _tag: "ContainerStartFailed",
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    });
  }

  turn(
    handle: AgentHandle,
    prompt: string,
    opts: { readonly timeoutMs: number },
  ): Effect.Effect<Turn, AgentRunTimeoutError, never> {
    const turnIndex = handle.turnsExecuted.count;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const cid = handle.containerId ?? "";
    const args = ["exec", cid, "claude", ...DEFAULT_CLAUDE_ARGS, prompt];

    return Effect.async<Turn, AgentRunTimeoutError, never>((resume) => {
      let finished = false;
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          child.kill("SIGKILL");
        } catch (err) { void err;
          // docker exec process may have already exited; container is handled in stop().
        }
        resume(
          Effect.fail(
            new AgentRunTimeoutError({
              scenarioId: ScenarioId(handle.scenarioId),
              turnIndex,
              timeoutMs: opts.timeoutMs,
            }),
          ),
        );
      }, opts.timeoutMs);
      child.on("close", () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        handle.turnsExecuted.count += 1;
        const parsed = parseStreamJson(stdout);
        const responseText = parsed.response.length > 0 ? parsed.response : stderr;
        const turn: Turn = {
          index: turnIndex,
          prompt,
          response: responseText,
          startedAt,
          latencyMs: Date.now() - startMs,
          toolCallCount: parsed.toolCallCount,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
        };
        resume(Effect.succeed(turn));
      });
      child.on("error", () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resume(
          Effect.fail(
            new AgentRunTimeoutError({
              scenarioId: ScenarioId(handle.scenarioId),
              turnIndex,
              timeoutMs: opts.timeoutMs,
            }),
          ),
        );
      });
      return Effect.sync(() => {
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch (err) { void err;
          // Interrupted mid-flight; container cleanup is stop()'s job.
        }
      });
    });
  }

  diff(handle: AgentHandle): Effect.Effect<WorkspaceDiff, never, never> {
    return walkWorkspace(handle.workspaceDir).pipe(
      Effect.map((current) => computeDiff(handle.initialFiles, current)),
    );
  }

  stop(handle: AgentHandle): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const cid = handle.containerId;
      if (cid !== undefined && cid.length > 0) {
        try {
          execSync(`docker kill ${shellQuote(cid)}`, { stdio: "ignore" });
        } catch (err) { void err;
          // Already dead — that is fine.
        }
        try {
          execSync(`docker rm -f ${shellQuote(cid)}`, { stdio: "ignore" });
        } catch (err) { void err;
          // --rm handles most cleanup; this is a safety net.
        }
      }
      try {
        rmSync(handle.workspaceDir, { recursive: true, force: true });
      } catch (err) { void err;
        // Filesystem cleanup best-effort; invariant #7 forbids propagation.
      }
    });
  }
}

function dockerImageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${shellQuote(image)}`, { stdio: "ignore" });
    return true;
  } catch (err) { void err;
    return false;
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:@./=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

void readFileSync;
