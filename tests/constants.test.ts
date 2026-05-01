// Pins the *value* of every typed cause-tag / kind / event constant map
// the v0.0.3 refactor introduced. Without these, mutation testing would
// happily flip "NoOutput" → "" in JUDGE_FAILURE_KIND.NoOutput and survive
// because nothing else asserts on the literal value (everything just uses
// the constant). Pinning here means a renamed tag breaks both compilation
// (the `as const satisfies` constraint) AND a runtime test.

import { describe, expect, it } from "vitest";
import {
  AGENT_LIFECYCLE_STATUS,
  EXECUTION_ARTIFACT_TAG,
  ISSUE_SEVERITY,
  RUN_SOURCE,
  RUNTIME_KIND,
  TRACE_EVENT_TYPE,
} from "../src/core/types.js";
import {
  AGENT_START_CAUSE,
  BUNDLE_BUILD_CAUSE,
  BUNDLE_DECODE_CAUSE,
  ERROR_TAG,
  HARNESS_EXECUTION_CAUSE,
  PUBLISH_ERROR_CAUSE,
  RUN_COORDINATION_CAUSE,
  RUNNER_RESOLUTION_CAUSE,
  TRACE_DECODE_CAUSE,
} from "../src/core/errors.js";
import { JUDGE_FAILURE_KIND } from "../src/core/schema.js";
import { INSPECT_CAUSE, INSPECT_SOURCE } from "../src/app/inspect.js";
import { JUDGE_PREFLIGHT_TAG } from "../src/app/judge-preflight.js";
import {
  RUN_CLOSE_STATUS,
  WAL_LINE_KIND,
  WAL_WARN_EVENT,
  WAL_WARN_SOURCE,
  UNSTRINGIFIABLE_PAYLOAD,
  UNSTRINGIFIABLE_ERROR,
} from "../src/emit/wal.js";
import {
  DIFF_PREFIX,
  EVENT_PREFIX,
  TURN_LABEL,
  PROMPT_NO_DIFF,
  DEFAULT_AGENT_NAME,
  PROMPT_CHANNEL,
  RESPONSE_CHANNEL,
  USER_FROM,
  turnHeader,
} from "../src/judge/helpers.js";
import { PROMPT_HEADING } from "../src/judge/index.js";
import { HARNESS_PLAN_CAUSE } from "../src/plans/types.js";
import { PLANNED_HARNESS_INGRESS_CAUSE } from "../src/plans/schema.js";
import { DETERMINISTIC_JUDGE_MODEL } from "../src/app/pipeline.js";

describe("typed cause-tag / kind constants — value pins", () => {
  it("TRACE_EVENT_TYPE", () => {
    expect(TRACE_EVENT_TYPE).toEqual({
      Message: "message",
      Phase: "phase",
      Action: "action",
      State: "state",
    });
  });

  it("AGENT_LIFECYCLE_STATUS", () => {
    expect(AGENT_LIFECYCLE_STATUS).toEqual({
      Completed: "completed",
      TimedOut: "timed_out",
      FailedToStart: "failed_to_start",
      Cancelled: "cancelled",
      RuntimeError: "runtime_error",
    });
  });

  it("ISSUE_SEVERITY", () => {
    expect(ISSUE_SEVERITY).toEqual({
      Minor: "minor",
      Significant: "significant",
      Critical: "critical",
    });
  });

  it("RUN_SOURCE", () => {
    expect(RUN_SOURCE).toEqual({ Bundle: "bundle" });
  });

  it("RUNTIME_KIND", () => {
    expect(RUNTIME_KIND).toEqual({ Docker: "docker", Subprocess: "subprocess" });
  });

  it("EXECUTION_ARTIFACT_TAG", () => {
    expect(EXECUTION_ARTIFACT_TAG).toEqual({
      DockerBuildArtifact: "DockerBuildArtifact",
      DockerImageArtifact: "DockerImageArtifact",
    });
  });

  it("JUDGE_FAILURE_KIND", () => {
    expect(JUDGE_FAILURE_KIND).toEqual({
      SdkFailed: "SdkFailed",
      NoOutput: "NoOutput",
      MalformedJson: "MalformedJson",
      SchemaInvalid: "SchemaInvalid",
      Timeout: "Timeout",
      ResultError: "ResultError",
    });
  });

  it("INSPECT_CAUSE", () => {
    expect(INSPECT_CAUSE).toEqual({
      RunNotFound: "RunNotFound",
      DuplicateSeq: "DuplicateSeq",
    });
  });

  it("INSPECT_SOURCE", () => {
    expect(INSPECT_SOURCE).toEqual({
      Inflight: "inflight",
      Completed: "completed",
    });
  });

  it("JUDGE_PREFLIGHT_TAG", () => {
    expect(JUDGE_PREFLIGHT_TAG).toEqual({
      Ready: "Ready",
      PreflightFailed: "PreflightFailed",
      AuthMissing: "AuthMissing",
      InvalidJson: "InvalidJson",
    });
  });

  it("WAL_LINE_KIND", () => {
    expect(WAL_LINE_KIND).toEqual({
      Turn: "turn",
      Event: "event",
      Phase: "phase",
      Context: "context",
      WorkspaceDiff: "workspace-diff",
      Outcome: "outcome",
      Orphaned: "orphaned",
    });
  });

  it("RUN_CLOSE_STATUS", () => {
    expect(RUN_CLOSE_STATUS).toEqual({
      Completed: "completed",
      Failed: "failed",
      Cancelled: "cancelled",
    });
  });

  it("WAL_WARN_EVENT", () => {
    expect(WAL_WARN_EVENT).toEqual({
      MkdirFailed: "mkdir.failed",
      PrecreateFailed: "precreate.failed",
      LockFailed: "lock.failed",
      AppendFailed: "append.failed",
      AppendAfterClose: "append.after-close",
      OutcomeAppendFailed: "outcome.append.failed",
      FsyncFailed: "fsync.failed",
      UnlockFailed: "unlock.failed",
      RenameFailed: "rename.failed",
      SweepReaddirFailed: "sweep.readdir.failed",
      SweepCheckFailed: "sweep.check.failed",
      SweepMarkOrphanedFailed: "sweep.mark-orphaned.failed",
      SweepRenameFailed: "sweep.rename.failed",
      SweepScanFailed: "sweep.scan.failed",
    });
  });

  it("WAL_WARN_SOURCE", () => {
    expect(WAL_WARN_SOURCE).toBe("cc-judge:wal");
  });

  it("UNSTRINGIFIABLE sentinels", () => {
    expect(UNSTRINGIFIABLE_PAYLOAD).toBe("<unstringifiable>");
    expect(UNSTRINGIFIABLE_ERROR).toBe("<unstringifiable error>");
  });

  it("AGENT_START_CAUSE", () => {
    expect(AGENT_START_CAUSE).toEqual({
      BuildContextMissing: "BuildContextMissing",
      DockerBuildFailed: "DockerBuildFailed",
      ImageMissing: "ImageMissing",
      ImagePullFailed: "ImagePullFailed",
      ContainerStartFailed: "ContainerStartFailed",
      BinaryNotFound: "BinaryNotFound",
      WorkspacePathEscape: "WorkspacePathEscape",
      WorkspaceSetupFailed: "WorkspaceSetupFailed",
    });
  });

  it("BUNDLE_BUILD_CAUSE", () => {
    expect(BUNDLE_BUILD_CAUSE).toEqual({
      DuplicateOutcome: "DuplicateOutcome",
      MissingOutcomes: "MissingOutcomes",
      UnknownAgent: "UnknownAgent",
      EventOrderViolation: "EventOrderViolation",
      SchemaInvalid: "SchemaInvalid",
    });
  });

  it("BUNDLE_DECODE_CAUSE", () => {
    expect(BUNDLE_DECODE_CAUSE).toEqual({
      UnknownFormat: "UnknownFormat",
      SchemaInvalid: "SchemaInvalid",
    });
  });

  it("HARNESS_EXECUTION_CAUSE", () => {
    expect(HARNESS_EXECUTION_CAUSE).toEqual({
      MissingRuntimeHandle: "MissingRuntimeHandle",
      InvalidPlanMetadata: "InvalidPlanMetadata",
      ExecutionFailed: "ExecutionFailed",
    });
  });

  it("PUBLISH_ERROR_CAUSE", () => {
    expect(PUBLISH_ERROR_CAUSE).toEqual({
      GhCliMissing: "GhCliMissing",
      GhCliFailed: "GhCliFailed",
      BodyTooLarge: "BodyTooLarge",
    });
  });

  it("RUN_COORDINATION_CAUSE", () => {
    expect(RUN_COORDINATION_CAUSE).toEqual({
      AgentStartFailed: "AgentStartFailed",
      HarnessFailed: "HarnessFailed",
      BundleBuildFailed: "BundleBuildFailed",
    });
  });

  it("RUNNER_RESOLUTION_CAUSE", () => {
    expect(RUNNER_RESOLUTION_CAUSE).toEqual({
      InvalidRuntime: "InvalidRuntime",
    });
  });

  it("TRACE_DECODE_CAUSE", () => {
    expect(TRACE_DECODE_CAUSE).toEqual({
      UnknownFormat: "UnknownFormat",
      SchemaInvalid: "SchemaInvalid",
    });
  });

  it("ERROR_TAG", () => {
    expect(ERROR_TAG).toEqual({
      AgentStartError: "AgentStartError",
      AgentRunTimeoutError: "AgentRunTimeoutError",
      TotalTimeoutExceeded: "TotalTimeoutExceeded",
      TraceDecodeError: "TraceDecodeError",
      BundleDecodeError: "BundleDecodeError",
      BundleBuildError: "BundleBuildError",
      HarnessExecutionError: "HarnessExecutionError",
      RunCoordinationError: "RunCoordinationError",
      PublishError: "PublishError",
      RunnerResolutionError: "RunnerResolutionError",
    });
  });

  it("HARNESS_PLAN_CAUSE", () => {
    expect(HARNESS_PLAN_CAUSE).toEqual({
      InvalidPayload: "InvalidPayload",
      InvalidConfiguration: "InvalidConfiguration",
      ImplementationFailure: "ImplementationFailure",
    });
  });

  it("PLANNED_HARNESS_INGRESS_CAUSE", () => {
    expect(PLANNED_HARNESS_INGRESS_CAUSE).toEqual({
      TopLevelNotDocument: "TopLevelNotDocument",
      SchemaInvalid: "SchemaInvalid",
      FileNotFound: "FileNotFound",
      GlobNoMatches: "GlobNoMatches",
      ParseFailure: "ParseFailure",
      DuplicateScenarioId: "DuplicateScenarioId",
      ModuleResolveFailed: "ModuleResolveFailed",
      ModuleImportFailed: "ModuleImportFailed",
      ModuleExportMissing: "ModuleExportMissing",
      InvalidHarnessModule: "InvalidHarnessModule",
      HarnessPlanLoadFailed: "HarnessPlanLoadFailed",
    });
  });
});

describe("prompt-rendering constants — value pins", () => {
  it("DIFF_PREFIX", () => {
    expect(DIFF_PREFIX).toEqual({
      Added: "+ added",
      Removed: "- removed",
      Modified: "~ modified",
    });
  });

  it("EVENT_PREFIX", () => {
    expect(EVENT_PREFIX).toEqual({
      Phase: "PHASE:",
      Action: "ACTION:",
      State: "STATE:",
      MessageArrow: " -> ",
    });
  });

  it("TURN_LABEL", () => {
    expect(TURN_LABEL).toEqual({ User: "USER", Assistant: "ASSISTANT" });
  });

  it("turnHeader(n) format", () => {
    expect(turnHeader(0)).toBe("--- Turn 0 ---");
    expect(turnHeader(7)).toBe("--- Turn 7 ---");
  });

  it("PROMPT_NO_DIFF", () => {
    expect(PROMPT_NO_DIFF).toBe("(no workspace changes)");
  });

  it("agent / channel / from constants", () => {
    expect(DEFAULT_AGENT_NAME).toBe("assistant");
    expect(PROMPT_CHANNEL).toBe("prompt");
    expect(RESPONSE_CHANNEL).toBe("response");
    expect(USER_FROM).toBe("user");
  });

  it("PROMPT_HEADING", () => {
    expect(PROMPT_HEADING).toEqual({
      EvaluationTarget: "# Evaluation target:",
      DescriptionLine: "Description:",
      ExpectedBehaviorLine: "Expected behavior:",
      ValidationChecks: "Validation checks (each must hold for pass=true):",
      Agents: "# Agents",
      EventTimeline: "# Event timeline",
      Transcript: "# Transcript",
      WorkspaceDiff: "# Workspace diff",
      Context: "# Context",
      Trailer: "Return the JSON verdict now.",
    });
  });
});

describe("pipeline constants — value pins", () => {
  it("DETERMINISTIC_JUDGE_MODEL", () => {
    expect(DETERMINISTIC_JUDGE_MODEL).toBe("deterministic/coordinator");
  });
});
