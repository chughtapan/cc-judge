import { Effect } from "effect";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRunTimeoutError,
  AgentStartError,
  HarnessExecutionError,
} from "../core/errors.js";
import type {
  AgentDeclaration,
  RuntimeKind,
  RunPlan,
  Turn,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceFileChange,
} from "../core/types.js";

const DEFAULT_CLAUDE_ARGS: ReadonlyArray<string> = ["-p", "--output-format", "stream-json", "--verbose"];

interface MutableWorkspaceState {
  readonly baselineFiles: Map<string, string>;
  turnsExecuted: number;
}

export interface RuntimeHandle {
  readonly agent: AgentDeclaration;
  readonly kind: RuntimeKind;
  readonly workspaceDir: string;
  writeWorkspace(files: ReadonlyArray<WorkspaceFile>): Effect.Effect<void, HarnessExecutionError, never>;
  executePrompt(
    prompt: string,
    opts: { readonly timeoutMs: number; readonly abortSignal?: AbortSignal },
  ): Effect.Effect<Turn, AgentRunTimeoutError | HarnessExecutionError, never>;
  diffWorkspace(): Effect.Effect<WorkspaceDiff, never, never>;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  prepare(agent: AgentDeclaration, plan: RunPlan): Effect.Effect<RuntimeHandle, AgentStartError, never>;
  stop(handle: RuntimeHandle): Effect.Effect<void, never, never>;
}

export interface DockerRuntimeOpts {
  readonly network?: "none" | "bridge";
  readonly memoryMb?: number;
  readonly cpus?: number;
  readonly claudeArgs?: ReadonlyArray<string>;
}

export interface SubprocessRuntimeOpts {
  readonly bin: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraArgs?: ReadonlyArray<string>;
}

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

interface PreparedImage {
  readonly image: string;
  readonly removeOnStop: boolean;
}

class PathEscapeSignal {
  constructor(readonly wfPath: string) {}
}

export class DockerRuntime implements AgentRuntime {
  readonly kind: "docker" = "docker";
  readonly #opts: DockerRuntimeOpts;

  constructor(opts: DockerRuntimeOpts = {}) {
    this.#opts = opts;
  }

  prepare(agent: AgentDeclaration, plan: RunPlan): Effect.Effect<RuntimeHandle, AgentStartError, never> {
    const runtimeOpts = this.#opts;
    return Effect.gen(function* () {
      const preparedImage = yield* materializeImage(agent, plan);
      const workspace = yield* makeEmptyWorkspace(plan.scenarioId);
      const containerId = yield* createDockerContainer(preparedImage.image, workspace.dir, runtimeOpts, plan, agent);
      return createDockerHandle({
        agent,
        plan,
        workspaceDir: workspace.dir,
        state: workspace.state,
        containerId,
        claudeArgs: runtimeOpts.claudeArgs ?? DEFAULT_CLAUDE_ARGS,
        preparedImage,
      });
    });
  }

  stop(handle: RuntimeHandle): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const dockerHandle = handle as RuntimeHandle & {
        readonly containerId?: string;
        readonly preparedImage?: PreparedImage;
      };
      if (dockerHandle.containerId !== undefined && dockerHandle.containerId.length > 0) {
        try {
          execSync(`docker kill ${shellQuote(dockerHandle.containerId)}`, { stdio: "ignore" });
        } catch (error) {
          void error;
        }
        try {
          execSync(`docker rm -f ${shellQuote(dockerHandle.containerId)}`, { stdio: "ignore" });
        } catch (error) {
          void error;
        }
      }
      try {
        rmSync(handle.workspaceDir, { recursive: true, force: true });
      } catch (error) {
        void error;
      }
      if (dockerHandle.preparedImage?.removeOnStop === true) {
        try {
          execSync(`docker image rm -f ${shellQuote(dockerHandle.preparedImage.image)}`, { stdio: "ignore" });
        } catch (error) {
          void error;
        }
      }
    });
  }
}

export class SubprocessRuntime implements AgentRuntime {
  readonly kind: "subprocess" = "subprocess";
  readonly #opts: SubprocessRuntimeOpts;

  constructor(opts: SubprocessRuntimeOpts) {
    this.#opts = opts;
  }

  prepare(agent: AgentDeclaration, plan: RunPlan): Effect.Effect<RuntimeHandle, AgentStartError, never> {
    return Effect.suspend(() => {
      if (!existsSync(this.#opts.bin)) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: plan.scenarioId,
            agentId: agent.id,
            cause: {
              _tag: "BinaryNotFound",
              path: this.#opts.bin,
            },
          }),
        );
      }
      return makeEmptyWorkspace(plan.scenarioId).pipe(
        Effect.map(({ dir, state }) =>
          createSubprocessHandle({
            agent,
            plan,
            workspaceDir: dir,
            state,
            opts: this.#opts,
          }),
        ),
      );
    });
  }

  stop(handle: RuntimeHandle): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      try {
        rmSync(handle.workspaceDir, { recursive: true, force: true });
      } catch (error) {
        void error;
      }
    });
  }
}

function makeEmptyWorkspace(
  scenarioId: RunPlan["scenarioId"],
): Effect.Effect<{ readonly dir: string; readonly state: MutableWorkspaceState }, AgentStartError, never> {
  return Effect.try({
    try: () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), `cc-judge-${scenarioId}-`));
      return {
        dir,
        state: {
          baselineFiles: new Map<string, string>(),
          turnsExecuted: 0,
        },
      };
    },
    catch: (error) =>
      new AgentStartError({
        scenarioId,
        cause: {
          _tag: "WorkspaceSetupFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  });
}

function createDockerHandle(params: {
  readonly agent: AgentDeclaration;
  readonly plan: RunPlan;
  readonly workspaceDir: string;
  readonly state: MutableWorkspaceState;
  readonly containerId: string;
  readonly claudeArgs: ReadonlyArray<string>;
  readonly preparedImage: PreparedImage;
}): RuntimeHandle {
  return {
    agent: params.agent,
    kind: "docker",
    workspaceDir: params.workspaceDir,
    containerId: params.containerId,
    preparedImage: params.preparedImage,
    writeWorkspace(files) {
      return writeWorkspaceFiles(params.workspaceDir, params.state, files, params.plan, params.agent);
    },
    executePrompt(prompt, opts) {
      return runDockerPrompt(
        params.containerId,
        params.plan,
        params.agent,
        params.state,
        params.claudeArgs,
        prompt,
        opts.timeoutMs,
        opts.abortSignal,
      );
    },
    diffWorkspace() {
      return diffWorkspace(params.workspaceDir, params.state);
    },
  } as RuntimeHandle;
}

function createSubprocessHandle(params: {
  readonly agent: AgentDeclaration;
  readonly plan: RunPlan;
  readonly workspaceDir: string;
  readonly state: MutableWorkspaceState;
  readonly opts: SubprocessRuntimeOpts;
}): RuntimeHandle {
  return {
    agent: params.agent,
    kind: "subprocess",
    workspaceDir: params.workspaceDir,
    writeWorkspace(files) {
      return writeWorkspaceFiles(params.workspaceDir, params.state, files, params.plan, params.agent);
    },
    executePrompt(prompt, opts) {
      return runSubprocessPrompt(
        params.plan,
        params.agent,
        params.state,
        params.workspaceDir,
        params.opts,
        prompt,
        opts.timeoutMs,
        opts.abortSignal,
      );
    },
    diffWorkspace() {
      return diffWorkspace(params.workspaceDir, params.state);
    },
  };
}

function writeWorkspaceFiles(
  workspaceDir: string,
  state: MutableWorkspaceState,
  files: ReadonlyArray<WorkspaceFile>,
  plan: RunPlan,
  agent: AgentDeclaration,
): Effect.Effect<void, HarnessExecutionError, never> {
  return Effect.try({
    try: () => {
      const rootResolved = path.resolve(workspaceDir);
      for (const file of files) {
        const abs = path.resolve(rootResolved, file.path);
        const rel = path.relative(rootResolved, abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new PathEscapeSignal(file.path);
        }
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, file.content, "utf8");
        state.baselineFiles.set(file.path, file.content);
      }
    },
    catch: (error) =>
      new HarnessExecutionError({
        cause: {
          _tag: "ExecutionFailed",
          message: error instanceof PathEscapeSignal
            ? `workspace path escapes root for agent ${agent.id}: ${error.wfPath}`
            : `${plan.scenarioId} workspace write failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      }),
  });
}

function diffWorkspace(
  workspaceDir: string,
  state: MutableWorkspaceState,
): Effect.Effect<WorkspaceDiff, never, never> {
  return walkWorkspace(workspaceDir).pipe(
    Effect.map((current) => computeDiff(state.baselineFiles, current)),
  );
}

function runDockerPrompt(
  containerId: string,
  plan: RunPlan,
  agent: AgentDeclaration,
  state: MutableWorkspaceState,
  claudeArgs: ReadonlyArray<string>,
  prompt: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Effect.Effect<Turn, AgentRunTimeoutError | HarnessExecutionError, never> {
    return runPromptProcess({
      cmd: "docker",
      args: ["exec", containerId, "claude", ...claudeArgs, prompt],
      plan,
      agent,
      state,
      prompt,
      timeoutMs,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
  }

function runSubprocessPrompt(
  plan: RunPlan,
  agent: AgentDeclaration,
  state: MutableWorkspaceState,
  workspaceDir: string,
  opts: SubprocessRuntimeOpts,
  prompt: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Effect.Effect<Turn, AgentRunTimeoutError | HarnessExecutionError, never> {
  const args = [...(opts.extraArgs ?? DEFAULT_CLAUDE_ARGS), prompt];
  const env = opts.env !== undefined ? { ...process.env, ...opts.env } : process.env;
  return runPromptProcess({
    cmd: opts.bin,
    args,
    cwd: opts.cwd ?? workspaceDir,
    env,
    plan,
    agent,
    state,
    prompt,
    timeoutMs,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });
}

function runPromptProcess(params: {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly plan: RunPlan;
  readonly agent: AgentDeclaration;
  readonly state: MutableWorkspaceState;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
}): Effect.Effect<Turn, AgentRunTimeoutError | HarnessExecutionError, never> {
  return Effect.async((resume, signal) => {
    let finished = false;
    const turnIndex = params.state.turnsExecuted;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child: ChildProcess = spawn(params.cmd, [...params.args], {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abortError = () =>
      new HarnessExecutionError({
        cause: {
          _tag: "ExecutionFailed",
          message: `${params.agent.id} prompt execution aborted`,
        },
      });
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      params.abortSignal?.removeEventListener("abort", onAbort);
      signal.removeEventListener("abort", onAbort);
      try {
        child.kill("SIGKILL");
      } catch (error) {
        void error;
      }
    };
    const onAbort = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resume(Effect.fail(abortError()));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (params.abortSignal?.aborted === true || signal.aborted === true) {
      finished = true;
      cleanup();
      resume(Effect.fail(abortError()));
      return Effect.void;
    }
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resume(
        Effect.fail(
          new AgentRunTimeoutError({
            scenarioId: params.plan.scenarioId,
            turnIndex,
            timeoutMs: params.timeoutMs,
          }),
        ),
      );
    }, params.timeoutMs);
    child.on("close", () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      params.state.turnsExecuted += 1;
      const parsed = parseStreamJson(stdout);
      const responseText = parsed.response.length > 0 ? parsed.response : stderr;
      resume(
        Effect.succeed({
          index: turnIndex,
          prompt: params.prompt,
          response: responseText,
          startedAt,
          latencyMs: Date.now() - startMs,
          toolCallCount: parsed.toolCallCount,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
        }),
      );
    });
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resume(
        Effect.fail(
          new HarnessExecutionError({
            cause: {
              _tag: "ExecutionFailed",
              message: `${params.agent.id} prompt execution failed: ${error.message}`,
            },
          }),
        ),
      );
    });
    return Effect.sync(cleanup);
  });
}

function materializeImage(
  agent: AgentDeclaration,
  plan: RunPlan,
): Effect.Effect<PreparedImage, AgentStartError, never> {
  switch (agent.artifact._tag) {
    case "DockerBuildArtifact":
      return buildDockerImage(agent, plan);
    case "DockerImageArtifact":
      return ensureDockerImage(agent, plan);
  }
}

function buildDockerImage(
  agent: AgentDeclaration,
  plan: RunPlan,
): Effect.Effect<PreparedImage, AgentStartError, never> {
  const artifact = agent.artifact;
  if (artifact._tag !== "DockerBuildArtifact") {
    return Effect.fail(
      new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: {
          _tag: "DockerBuildFailed",
          message: `expected DockerBuildArtifact, received ${artifact._tag}`,
        },
      }),
    );
  }
  return Effect.try({
    try: () => {
      const contextPath = path.resolve(artifact.contextPath);
      if (!existsSync(contextPath)) {
        throw new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: {
            _tag: "BuildContextMissing",
            path: contextPath,
          },
        });
      }
      const autoTag = `cc-judge-${sanitizeId(plan.scenarioId)}-${sanitizeId(agent.id)}-${Date.now()}`;
      const imageTag = artifact.imageTag ?? autoTag;
      const dockerfilePath = artifact.dockerfilePath !== undefined
        ? path.resolve(contextPath, artifact.dockerfilePath)
        : undefined;
      const args = [
        "build",
        "-t",
        imageTag,
        ...(dockerfilePath !== undefined ? ["-f", dockerfilePath] : []),
        ...(artifact.target !== undefined ? ["--target", artifact.target] : []),
        ...renderBuildArgs(artifact.buildArgs),
        contextPath,
      ];
      execSync(`docker ${args.map(shellQuote).join(" ")}`, { stdio: "pipe" });
      return {
        image: imageTag,
        removeOnStop: artifact.imageTag === undefined,
      };
    },
    catch: (error) => {
      if (error instanceof AgentStartError) {
        return error;
      }
      return new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: {
          _tag: "DockerBuildFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    },
  });
}

function ensureDockerImage(
  agent: AgentDeclaration,
  plan: RunPlan,
): Effect.Effect<PreparedImage, AgentStartError, never> {
  const artifact = agent.artifact;
  if (artifact._tag !== "DockerImageArtifact") {
    return Effect.fail(
      new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: {
          _tag: "ImageMissing",
          image: `invalid-artifact:${artifact._tag}`,
        },
      }),
    );
  }
  return Effect.try({
    try: () => {
      const image = artifact.image;
      const pullPolicy = artifact.pullPolicy ?? "if-missing";
      const imageAvailable = dockerImageExists(image);
      if (pullPolicy === "always" || (pullPolicy === "if-missing" && !imageAvailable)) {
        try {
          execSync(`docker pull ${shellQuote(image)}`, { stdio: "pipe" });
        } catch (error) {
          throw new AgentStartError({
            scenarioId: plan.scenarioId,
            agentId: agent.id,
            cause: {
              _tag: "ImagePullFailed",
              image,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      if (pullPolicy === "never" && !imageAvailable) {
        throw new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: {
            _tag: "ImageMissing",
            image,
          },
        });
      }
      if (!dockerImageExists(image)) {
        throw new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: {
            _tag: "ImageMissing",
            image,
          },
        });
      }
      return {
        image,
        removeOnStop: false,
      };
    },
    catch: (error) => {
      if (error instanceof AgentStartError) {
        return error;
      }
      return new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: {
          _tag: "ImageMissing",
          image: artifact.image,
        },
      });
    },
  });
}

function createDockerContainer(
  image: string,
  workspaceDir: string,
  opts: DockerRuntimeOpts,
  plan: RunPlan,
  agent: AgentDeclaration,
): Effect.Effect<string, AgentStartError, never> {
  return Effect.try({
    try: () => {
      const args = [
        "create",
        "--rm",
        "-v",
        `${workspaceDir}:/workspace`,
        "-w",
        "/workspace",
        "--network",
        opts.network ?? "none",
        ...(opts.memoryMb !== undefined ? ["--memory", `${opts.memoryMb}m`] : []),
        ...(opts.cpus !== undefined ? ["--cpus", String(opts.cpus)] : []),
        image,
        "tail",
        "-f",
        "/dev/null",
      ];
      const containerId = execSync(`docker ${args.map(shellQuote).join(" ")}`, { stdio: "pipe" })
        .toString("utf8")
        .trim();
      execSync(`docker start ${shellQuote(containerId)}`, { stdio: "ignore" });
      return containerId;
    },
    catch: (error) =>
      new AgentStartError({
        scenarioId: plan.scenarioId,
        agentId: agent.id,
        cause: {
          _tag: "ContainerStartFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  });
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
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      void error;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    sawStructured = true;
    const obj: StreamJsonEvent = parsed;
    const type = typeof obj.type === "string" ? obj.type : "";
    switch (type) {
      case "assistant":
        if (typeof obj.content === "string") {
          response += obj.content;
        }
        break;
      case "result":
        if (typeof obj.result === "string" && response.length === 0) {
          response = obj.result;
        }
        break;
      case "tool_use":
      case "tool_call":
        toolCallCount += 1;
        break;
      default:
        break;
    }
    const usage = obj.usage;
    if (typeof usage === "object" && usage !== null) {
      const tokens: StreamJsonUsage = usage;
      if (typeof tokens.input_tokens === "number") {
        inputTokens += tokens.input_tokens;
      }
      if (typeof tokens.output_tokens === "number") {
        outputTokens += tokens.output_tokens;
      }
      if (typeof tokens.cache_read_input_tokens === "number") {
        cacheReadTokens += tokens.cache_read_input_tokens;
      }
      if (typeof tokens.cache_creation_input_tokens === "number") {
        cacheWriteTokens += tokens.cache_creation_input_tokens;
      }
    }
  }
  if (!sawStructured) {
    response = stdout;
  }
  return {
    response,
    toolCallCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function walkWorkspace(dir: string): Effect.Effect<ReadonlyMap<string, string>, never, never> {
  const output = new Map<string, string>();
  return walkInto(dir, dir, output).pipe(Effect.map(() => output as ReadonlyMap<string, string>));
}

function walkInto(
  root: string,
  currentDir: string,
  output: Map<string, string>,
): Effect.Effect<void, never, never> {
  return Effect.tryPromise({
    try: () => readdir(currentDir, { withFileTypes: true }),
    catch: () => [],
  }).pipe(
    Effect.catchAll(() => Effect.succeed([])),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) => {
          const absolutePath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            return walkInto(root, absolutePath, output);
          }
          if (!entry.isFile()) {
            return Effect.void;
          }
          return Effect.tryPromise({
            try: () => readFile(absolutePath, "utf8"),
            catch: () => null,
          }).pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (content: string | null) => {
                if (content !== null) {
                  output.set(path.relative(root, absolutePath), content);
                }
              },
            }),
          );
        },
        { discard: true },
      ),
    ),
  );
}

function computeDiff(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): WorkspaceDiff {
  const changed: WorkspaceFileChange[] = [];
  const seen = new Set<string>();
  for (const [relativePath, before] of baseline) {
    seen.add(relativePath);
    const after = current.get(relativePath);
    if (after === undefined) {
      changed.push({ path: relativePath, before, after: null });
    } else if (after !== before) {
      changed.push({ path: relativePath, before, after });
    }
  }
  for (const [relativePath, after] of current) {
    if (!seen.has(relativePath)) {
      changed.push({ path: relativePath, before: null, after });
    }
  }
  return { changed };
}

function dockerImageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${shellQuote(image)}`, { stdio: "ignore" });
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

function renderBuildArgs(buildArgs: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> {
  if (buildArgs === undefined) {
    return [];
  }
  return Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_:@./=-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

void readFileSync;
