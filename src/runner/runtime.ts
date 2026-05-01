import Docker from "dockerode";
import * as tarFs from "tar-fs";
import { Effect, Exit } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDiff, parseStreamJson, walkWorkspace } from "./helpers.js";
import {
  AgentRunTimeoutError,
  AgentStartError,
  AgentStartErrorCause,
  HarnessExecutionCause,
  HarnessExecutionError,
} from "../core/errors.js";
import type {
  AgentDeclaration,
  RuntimeKind,
  RunPlan,
  Turn,
  WorkspaceDiff,
  WorkspaceFile,
} from "../core/types.js";

const DEFAULT_CLAUDE_ARGS: ReadonlyArray<string> = ["-p", "--output-format", "stream-json", "--verbose"];

// One Docker client per process. Defaults to the local socket
// (/var/run/docker.sock on POSIX, named pipe on Windows). All Docker
// lifecycle operations — build, pull, inspect, create, kill, remove —
// flow through this client. Prompt execution still uses `docker exec`
// via spawn() because the streaming stdout parse needs a real
// child-process lifecycle; that's a follow-up.
const docker = new Docker();

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
      // Workspace is acquired before container creation; release deletes it
      // on any non-success exit (failure or interrupt) so partial-prepare
      // failures cannot leak tmpdirs. On success, the returned handle owns
      // the workspace and stop() handles cleanup.
      return yield* Effect.acquireUseRelease(
        makeEmptyWorkspace(plan.scenarioId),
        (workspace) =>
          createDockerContainer(preparedImage.image, workspace.dir, runtimeOpts, plan, agent).pipe(
            Effect.map((containerId) =>
              createDockerHandle({
                agent,
                plan,
                workspaceDir: workspace.dir,
                state: workspace.state,
                containerId,
                claudeArgs: runtimeOpts.claudeArgs ?? DEFAULT_CLAUDE_ARGS,
                preparedImage,
              }),
            ),
          ),
        (workspace, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                try {
                  rmSync(workspace.dir, { recursive: true, force: true });
                } catch (error) {
                  void error;
                }
              }),
      );
    });
  }

  stop(handle: RuntimeHandle): Effect.Effect<void, never, never> {
    const dockerHandle = handle as RuntimeHandle & {
      readonly containerId?: string;
      readonly preparedImage?: PreparedImage;
    };
    return Effect.gen(function* () {
      if (dockerHandle.containerId !== undefined && dockerHandle.containerId.length > 0) {
        const container = docker.getContainer(dockerHandle.containerId);
        // Best-effort: an already-stopped container or one that AutoRemove
        // already reaped both throw — those are expected on the cleanup
        // path and not worth surfacing.
        yield* Effect.tryPromise(() => container.kill()).pipe(Effect.catchAll(() => Effect.void));
        yield* Effect.tryPromise(() => container.remove({ force: true })).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }
      yield* Effect.sync(() => {
        try {
          rmSync(handle.workspaceDir, { recursive: true, force: true });
        } catch (error) {
          void error;
        }
      });
      if (dockerHandle.preparedImage?.removeOnStop === true) {
        const imageName = dockerHandle.preparedImage.image;
        yield* Effect.tryPromise(() => docker.getImage(imageName).remove({ force: true })).pipe(
          Effect.catchAll(() => Effect.void),
        );
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
    const opts = this.#opts;
    return Effect.suspend(() => {
      if (!existsSync(opts.bin)) {
        return Effect.fail(
          new AgentStartError({
            scenarioId: plan.scenarioId,
            agentId: agent.id,
            cause: AgentStartErrorCause.BinaryNotFound({
              path: opts.bin,
            }),
          }),
        );
      }
      // createSubprocessHandle is sync today; the acquireUseRelease shape
      // guards against future failure paths and fiber interruption between
      // yield points so the workspace cannot leak.
      return Effect.acquireUseRelease(
        makeEmptyWorkspace(plan.scenarioId),
        ({ dir, state }) =>
          Effect.sync(() =>
            createSubprocessHandle({
              agent,
              plan,
              workspaceDir: dir,
              state,
              opts,
            }),
          ),
        ({ dir }, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                try {
                  rmSync(dir, { recursive: true, force: true });
                } catch (error) {
                  void error;
                }
              }),
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
        cause: AgentStartErrorCause.WorkspaceSetupFailed({
          message: error instanceof Error ? error.message : String(error),
        }),
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
        cause: HarnessExecutionCause.ExecutionFailed({
          message: error instanceof PathEscapeSignal
            ? `workspace path escapes root for agent ${agent.id}: ${error.wfPath}`
            : `${plan.scenarioId} workspace write failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
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
  // Runtime boundary: inherit the host environment unless the caller supplied one.
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime
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
        cause: HarnessExecutionCause.ExecutionFailed({
          message: `${params.agent.id} prompt execution aborted`,
        }),
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
            cause: HarnessExecutionCause.ExecutionFailed({
              message: `${params.agent.id} prompt execution failed: ${error.message}`,
            }),
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
    case "SubprocessArtifact":
      return Effect.fail(invalidArtifactForDocker(agent, plan));
  }
}

// Wrong-runtime tag in the Docker materialization path; surfaced as
// ImageMissing with an `invalid-artifact:<tag>` sentinel image so callers
// see one cause shape regardless of which guard fires.
function invalidArtifactForDocker(
  agent: AgentDeclaration,
  plan: RunPlan,
): AgentStartError {
  return new AgentStartError({
    scenarioId: plan.scenarioId,
    agentId: agent.id,
    cause: AgentStartErrorCause.ImageMissing({
      image: `invalid-artifact:${agent.artifact._tag}`,
    }),
  });
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
        cause: AgentStartErrorCause.DockerBuildFailed({
          message: `expected DockerBuildArtifact, received ${artifact._tag}`,
        }),
      }),
    );
  }
  return Effect.suspend(() => {
    const contextPath = path.resolve(artifact.contextPath);
    if (!existsSync(contextPath)) {
      return Effect.fail(
        new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: AgentStartErrorCause.BuildContextMissing({
            path: contextPath,
          }),
        }),
      );
    }
    const autoTag = `cc-judge-${sanitizeId(plan.scenarioId)}-${sanitizeId(agent.id)}-${Date.now()}`;
    const imageTag = artifact.imageTag ?? autoTag;
    const ownsTag = artifact.imageTag === undefined;
    // dockerode wants Dockerfile as a path RELATIVE to the build context
    // (it embeds the file inside the streamed tarball); resolve to the
    // relative form whether or not the user passed an absolute path.
    const dockerfileRel = artifact.dockerfilePath !== undefined
      ? path.relative(contextPath, path.resolve(contextPath, artifact.dockerfilePath))
      : undefined;
    const buildOpts: Docker.ImageBuildOptions = {
      t: imageTag,
      ...(dockerfileRel !== undefined ? { dockerfile: dockerfileRel } : {}),
      ...(artifact.target !== undefined ? { target: artifact.target } : {}),
      ...(artifact.buildArgs !== undefined ? { buildargs: { ...artifact.buildArgs } } : {}),
    };
    return runDockerBuild(contextPath, buildOpts).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.succeed({ image: imageTag, removeOnStop: ownsTag }),
        onFailure: (message) =>
          // Best-effort cleanup of partial image when we own the tag.
          // Docker build can leave a tagged-but-incomplete image if it
          // fails after `-t` takes effect; without this, autoTag-named
          // artifacts accumulate forever. User-supplied tags are left
          // alone — their lifecycle belongs to the user.
          (ownsTag ? bestEffortRemoveImage(imageTag) : Effect.void).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new AgentStartError({
                  scenarioId: plan.scenarioId,
                  agentId: agent.id,
                  cause: AgentStartErrorCause.DockerBuildFailed({ message }),
                }),
              ),
            ),
          ),
      }),
    );
  });
}

// Build the image via dockerode + tar-fs. tar-fs.pack streams the
// context dir without writing intermediate files; followProgress drains
// the build response stream to completion and surfaces any errorDetail
// frame as the failure message. Returns the build error message
// directly so the caller can wrap it without parsing.
function runDockerBuild(
  contextPath: string,
  buildOpts: Docker.ImageBuildOptions,
): Effect.Effect<void, string, never> {
  return Effect.tryPromise({
    try: () => docker.buildImage(tarFs.pack(contextPath), buildOpts),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  }).pipe(Effect.flatMap(drainBuildStream));
}

interface DockerStreamFrame {
  readonly stream?: string;
  readonly error?: string;
  readonly errorDetail?: { readonly message?: string };
}

// Drain the demuxed JSON-frame stream that `buildImage` and `pull`
// return. Yields void on a clean run; fails with the concatenated error
// messages from any errorDetail/error frames, or the followProgress
// callback's err arg.
function drainBuildStream(stream: NodeJS.ReadableStream): Effect.Effect<void, string, never> {
  return Effect.async<void, string>((resume) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err !== null) {
        resume(Effect.fail(err instanceof Error ? err.message : String(err)));
        return;
      }
      const frames = (output ?? []) as ReadonlyArray<DockerStreamFrame>;
      const errors = frames
        .map((frame) => frame.errorDetail?.message ?? frame.error)
        .filter((message): message is string => typeof message === "string" && message.length > 0);
      if (errors.length > 0) {
        resume(Effect.fail(errors.join("; ")));
        return;
      }
      resume(Effect.void);
    });
  });
}

// Cleanup helpers. Both swallow internally — they only run on a
// failure/teardown path where surfacing a secondary error would mask
// the primary one.
function bestEffortRemoveImage(image: string): Effect.Effect<void, never, never> {
  return Effect.tryPromise(() => docker.getImage(image).remove({ force: true })).pipe(
    Effect.catchAll(() => Effect.void),
  );
}

function ensureDockerImage(
  agent: AgentDeclaration,
  plan: RunPlan,
): Effect.Effect<PreparedImage, AgentStartError, never> {
  const artifact = agent.artifact;
  if (artifact._tag !== "DockerImageArtifact") {
    return Effect.fail(invalidArtifactForDocker(agent, plan));
  }
  const image = artifact.image;
  const pullPolicy = artifact.pullPolicy ?? "if-missing";
  return Effect.gen(function* () {
    const initiallyExists = yield* dockerImageExists(image);
    if (pullPolicy === "always" || (pullPolicy === "if-missing" && !initiallyExists)) {
      yield* runDockerPull(image).pipe(
        Effect.mapError(
          (message) =>
            new AgentStartError({
              scenarioId: plan.scenarioId,
              agentId: agent.id,
              cause: AgentStartErrorCause.ImagePullFailed({ image, message }),
            }),
        ),
      );
    }
    if (pullPolicy === "never" && !initiallyExists) {
      return yield* Effect.fail(
        new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: AgentStartErrorCause.ImageMissing({ image }),
        }),
      );
    }
    // Re-check after the pull attempt — pull(...) returning success
    // doesn't guarantee the image is locally available (rare, but a
    // partial pull aborted by the daemon would land us here).
    const finalExists = yield* dockerImageExists(image);
    if (!finalExists) {
      return yield* Effect.fail(
        new AgentStartError({
          scenarioId: plan.scenarioId,
          agentId: agent.id,
          cause: AgentStartErrorCause.ImageMissing({ image }),
        }),
      );
    }
    return { image, removeOnStop: false };
  });
}

function runDockerPull(image: string): Effect.Effect<void, string, never> {
  return Effect.tryPromise({
    try: () => docker.pull(image) as Promise<NodeJS.ReadableStream>,
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  }).pipe(Effect.flatMap(drainBuildStream));
}

function createDockerContainer(
  image: string,
  workspaceDir: string,
  opts: DockerRuntimeOpts,
  plan: RunPlan,
  agent: AgentDeclaration,
): Effect.Effect<string, AgentStartError, never> {
  const config: Docker.ContainerCreateOptions = {
    Image: image,
    // tail -f keeps the container alive while we issue `docker exec`
    // calls for each prompt turn.
    Cmd: ["tail", "-f", "/dev/null"],
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [`${workspaceDir}:/workspace`],
      NetworkMode: opts.network ?? "none",
      // No AutoRemove: stop() handles removal explicitly via dockerode's
      // synchronous remove(). AutoRemove triggers daemon-side async cleanup
      // that races with our remove() call, leaving stop() callers unable
      // to assume the container is gone when stop() resolves.
      ...(opts.memoryMb !== undefined ? { Memory: opts.memoryMb * 1024 * 1024 } : {}),
      ...(opts.cpus !== undefined ? { NanoCpus: Math.round(opts.cpus * 1_000_000_000) } : {}),
    },
  };
  const containerStartFailed = (error: unknown): AgentStartError =>
    new AgentStartError({
      scenarioId: plan.scenarioId,
      agentId: agent.id,
      cause: AgentStartErrorCause.ContainerStartFailed({
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  return Effect.tryPromise({
    try: () => docker.createContainer(config),
    catch: containerStartFailed,
  }).pipe(
    Effect.flatMap((container) =>
      Effect.tryPromise({
        try: () => container.start(),
        catch: containerStartFailed,
      }).pipe(Effect.as(container.id)),
    ),
  );
}

function dockerImageExists(image: string): Effect.Effect<boolean, never, never> {
  return Effect.tryPromise(() => docker.getImage(image).inspect()).pipe(
    Effect.match({
      onSuccess: () => true,
      onFailure: () => false,
    }),
  );
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
