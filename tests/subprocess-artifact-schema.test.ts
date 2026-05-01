// Schema accept/reject tests for the SubprocessArtifact variant
// (safer-by-default spec #252 §5 PR 1, §8.1 (B)).

import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ExecutionArtifactSchema } from "../src/core/schema.js";

describe("ExecutionArtifactSchema with SubprocessArtifact variant", () => {
  it("accepts a minimal SubprocessArtifact payload", () => {
    const payload = { _tag: "SubprocessArtifact" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(true);
  });

  it("accepts a SubprocessArtifact with an optional label", () => {
    const payload = { _tag: "SubprocessArtifact", label: "local-claude" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(true);
  });

  it("rejects a SubprocessArtifact whose label is not a string", () => {
    const payload = { _tag: "SubprocessArtifact", label: 42 };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(false);
  });

  it("rejects a SubprocessArtifact whose label is an empty string", () => {
    const payload = { _tag: "SubprocessArtifact", label: "" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(false);
  });

  it("continues to accept a DockerImageArtifact payload (compat)", () => {
    const payload = { _tag: "DockerImageArtifact", image: "repo/agent:latest" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(true);
  });

  it("continues to accept a DockerBuildArtifact payload (compat)", () => {
    const payload = { _tag: "DockerBuildArtifact", contextPath: "./ctx" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(true);
  });

  it("rejects an unknown _tag", () => {
    const payload = { _tag: "MysteryArtifact", label: "x" };
    expect(Value.Check(ExecutionArtifactSchema, payload)).toBe(false);
  });
});
