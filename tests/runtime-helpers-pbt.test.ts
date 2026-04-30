// Property-based + example tests for the pure helpers extracted into
// src/runner/helpers.ts. These cover the stream-json parser and the
// workspace walk/diff that runtime.ts used to inline. Real-Docker
// tests in runtime-docker.test.ts cover the orchestration; this file
// covers the per-event and per-file logic that doesn't need a daemon.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import * as fc from "fast-check";
import {
  computeDiff,
  parseStreamJson,
  walkWorkspace,
} from "../src/runner/helpers.js";
import { itEffect } from "./support/effect.js";
import { makeTempDir } from "./support/tmpdir.js";

const RUNS = 100;

// ── parseStreamJson ─────────────────────────────────────────────────────────

describe("parseStreamJson: events", () => {
  it("returns the raw stdout when no JSON event is present (fallback)", () => {
    const stdout = "plain text output\nno json here\n";
    const out = parseStreamJson(stdout);
    expect(out.response).toBe(stdout);
    expect(out.toolCallCount).toBe(0);
  });

  it("returns empty turn for empty input", () => {
    const out = parseStreamJson("");
    expect(out.response).toBe("");
    expect(out.toolCallCount).toBe(0);
  });

  it("concatenates multiple assistant content events", () => {
    const partA = "Hello ";
    const partB = "world.";
    const stdout = [
      JSON.stringify({ type: "assistant", content: partA }),
      JSON.stringify({ type: "assistant", content: partB }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe(partA + partB);
  });

  it("uses result event when no assistant content was seen", () => {
    const result = "final answer";
    const stdout = JSON.stringify({ type: "result", result });
    expect(parseStreamJson(stdout).response).toBe(result);
  });

  it("ignores result event when assistant content was already collected", () => {
    const realAnswer = "the real answer";
    const stdout = [
      JSON.stringify({ type: "assistant", content: realAnswer }),
      JSON.stringify({ type: "result", result: "should be ignored" }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe(realAnswer);
  });

  it("counts tool_use and tool_call events", () => {
    const types = ["tool_use", "tool_call", "tool_use"];
    const stdout = types.map((t) => JSON.stringify({ type: t })).join("\n");
    expect(parseStreamJson(stdout).toolCallCount).toBe(types.length);
  });

  it("ignores unknown event types", () => {
    const stdout = JSON.stringify({ type: "unknown_type", content: "x" });
    const out = parseStreamJson(stdout);
    expect(out.response).toBe("");
    expect(out.toolCallCount).toBe(0);
  });

  it("ignores assistant event with non-string content", () => {
    const stdout = JSON.stringify({ type: "assistant", content: 42 });
    expect(parseStreamJson(stdout).response).toBe("");
  });

  it("ignores result event with non-string result field", () => {
    const stdout = JSON.stringify({ type: "result", result: { wrong: "shape" } });
    expect(parseStreamJson(stdout).response).toBe("");
  });

  it("skips malformed JSON lines silently and continues parsing the rest", () => {
    const goodContent = "after the bad line";
    const stdout = [
      "not json {{{",
      JSON.stringify({ type: "assistant", content: goodContent }),
      "more garbage",
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe(goodContent);
  });

  it("skips lines that parse to non-object values (string, number, null, array)", () => {
    const goodContent = "final";
    const stdout = [
      '"a string"',
      "42",
      "null",
      "[1, 2, 3]",
      JSON.stringify({ type: "assistant", content: goodContent }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe(goodContent);
  });

  it("skips blank lines (whitespace-only)", () => {
    const stdout = [
      "",
      "   ",
      "\t",
      JSON.stringify({ type: "assistant", content: "ok" }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe("ok");
  });
});

describe("parseStreamJson: usage tokens", () => {
  it("aggregates token counts across multiple events", () => {
    const inputs = [10, 3];
    const outputs = [5, 2];
    const stdout = inputs
      .map((n, i) =>
        JSON.stringify({ type: "result", usage: { input_tokens: n, output_tokens: outputs[i] } }),
      )
      .join("\n");
    const out = parseStreamJson(stdout);
    expect(out.inputTokens).toBe(inputs.reduce((a, b) => a + b, 0));
    expect(out.outputTokens).toBe(outputs.reduce((a, b) => a + b, 0));
  });

  it("aggregates cache_read and cache_creation tokens separately", () => {
    const cacheRead = 80;
    const cacheWrite = 20;
    const stdout = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    });
    const out = parseStreamJson(stdout);
    expect(out.cacheReadTokens).toBe(cacheRead);
    expect(out.cacheWriteTokens).toBe(cacheWrite);
  });

  it("ignores non-numeric token fields silently", () => {
    const stdout = JSON.stringify({
      type: "result",
      usage: { input_tokens: "10", output_tokens: null, cache_read_input_tokens: undefined },
    });
    const out = parseStreamJson(stdout);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.cacheReadTokens).toBe(0);
  });

  it("handles event with no usage field", () => {
    const stdout = JSON.stringify({ type: "assistant", content: "x" });
    const out = parseStreamJson(stdout);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
  });

  it("handles non-object usage field", () => {
    const stdout = JSON.stringify({ type: "result", usage: "not an object" });
    const out = parseStreamJson(stdout);
    expect(out.inputTokens).toBe(0);
  });
});

describe("parseStreamJson (PBT)", () => {
  it("output is always a structurally complete ParsedTurn", () => {
    fc.assert(
      fc.property(fc.string(), (stdout) => {
        const out = parseStreamJson(stdout);
        // .length is only callable on strings — exercising it confirms the type
        // structurally without hardcoding the typeof tag.
        expect(out.response.length).toBeGreaterThanOrEqual(0);
        expect(out.toolCallCount).toBeGreaterThanOrEqual(0);
        expect(out.inputTokens).toBeGreaterThanOrEqual(0);
        expect(out.outputTokens).toBeGreaterThanOrEqual(0);
        expect(out.cacheReadTokens).toBeGreaterThanOrEqual(0);
        expect(out.cacheWriteTokens).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("token counts are the sum of per-event input_tokens for valid result events", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 10 }),
        (counts) => {
          const stdout = counts
            .map((n) => JSON.stringify({ type: "result", usage: { input_tokens: n } }))
            .join("\n");
          const out = parseStreamJson(stdout);
          expect(out.inputTokens).toBe(counts.reduce((a, b) => a + b, 0));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("tool_call+tool_use count equals total instances in input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("tool_use", "tool_call", "noise"), { maxLength: 20 }),
        (types) => {
          const stdout = types
            .map((t) => JSON.stringify({ type: t }))
            .join("\n");
          const expected = types.filter((t) => t === "tool_use" || t === "tool_call").length;
          expect(parseStreamJson(stdout).toolCallCount).toBe(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── walkWorkspace ───────────────────────────────────────────────────────────

describe("walkWorkspace", () => {
  itEffect("returns empty map when directory does not exist", function* () {
    const result = yield* walkWorkspace("/this/path/does/not/exist/cc-judge");
    expect(result.size).toBe(0);
  });

  itEffect("returns empty map for an empty directory", function* () {
    const dir = makeTempDir("walk-empty");
    const result = yield* walkWorkspace(dir);
    expect(result.size).toBe(0);
  });

  itEffect("collects flat files keyed by their relative path", function* () {
    const dir = makeTempDir("walk-flat");
    const files = [
      { name: "a.txt", body: "alpha" },
      { name: "b.txt", body: "beta" },
    ];
    for (const f of files) writeFileSync(path.join(dir, f.name), f.body, "utf8");
    const result = yield* walkWorkspace(dir);
    expect(result.size).toBe(files.length);
    for (const f of files) expect(result.get(f.name)).toBe(f.body);
  });

  itEffect("recurses into subdirectories with relative path keys", function* () {
    const dir = makeTempDir("walk-nested");
    mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
    const files = [
      { rel: "root.txt", body: "1" },
      { rel: path.join("sub", "mid.txt"), body: "2" },
      { rel: path.join("sub", "deep", "leaf.txt"), body: "3" },
    ];
    for (const f of files) writeFileSync(path.join(dir, f.rel), f.body, "utf8");
    const result = yield* walkWorkspace(dir);
    expect(result.size).toBe(files.length);
    for (const f of files) expect(result.get(f.rel)).toBe(f.body);
  });

  itEffect("skips non-file entries (symlinks pointing nowhere)", function* () {
    const dir = makeTempDir("walk-symlink");
    writeFileSync(path.join(dir, "real.txt"), "yes", "utf8");
    // Symlink to nowhere — entry.isFile() will be false.
    try {
      symlinkSync("/nonexistent-target", path.join(dir, "broken-link"));
    } catch (err) {
      // On some CI environments symlink creation may not be permitted;
      // the test still validates the file-only collection on the real file.
      void err;
    }
    const result = yield* walkWorkspace(dir);
    expect(result.get("real.txt")).toBe("yes");
    expect(result.has("broken-link")).toBe(false);
  });
});

// ── computeDiff ─────────────────────────────────────────────────────────────

describe("computeDiff", () => {
  it("returns no changes when baseline equals current", () => {
    const m = new Map([["a", "1"], ["b", "2"]]);
    expect(computeDiff(m, m).changed).toEqual([]);
  });

  it("classifies a removed file (in baseline, not in current)", () => {
    const baseline = new Map([["x.txt", "v"]]);
    const current = new Map<string, string>();
    expect(computeDiff(baseline, current).changed).toEqual([
      { path: "x.txt", before: "v", after: null },
    ]);
  });

  it("classifies an added file (not in baseline, in current)", () => {
    const baseline = new Map<string, string>();
    const current = new Map([["x.txt", "v"]]);
    expect(computeDiff(baseline, current).changed).toEqual([
      { path: "x.txt", before: null, after: "v" },
    ]);
  });

  it("classifies a modified file (different contents)", () => {
    const baseline = new Map([["x.txt", "before"]]);
    const current = new Map([["x.txt", "after"]]);
    expect(computeDiff(baseline, current).changed).toEqual([
      { path: "x.txt", before: "before", after: "after" },
    ]);
  });

  it("omits unchanged files from the diff", () => {
    const baseline = new Map([["a", "1"], ["b", "2"]]);
    const current = new Map([["a", "1"], ["b", "999"]]);
    const out = computeDiff(baseline, current);
    expect(out.changed).toEqual([{ path: "b", before: "2", after: "999" }]);
  });

  it("handles a mix of added, removed, modified, unchanged", () => {
    const baseline = new Map([["unchanged", "0"], ["modified", "old"], ["removed", "v"]]);
    const current = new Map([["unchanged", "0"], ["modified", "new"], ["added", "v"]]);
    const out = computeDiff(baseline, current);
    const sorted = [...out.changed].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      { path: "added", before: null, after: "v" },
      { path: "modified", before: "old", after: "new" },
      { path: "removed", before: "v", after: null },
    ]);
  });
});

describe("computeDiff (PBT)", () => {
  it("self-diff is always empty", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string()),
        (entries) => {
          const m = new Map(Object.entries(entries));
          expect(computeDiff(m, m).changed).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("changed.length equals symmetric-difference + same-key-different-value count", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        (a, b) => {
          const baseline = new Map(Object.entries(a));
          const current = new Map(Object.entries(b));
          const expected =
            [...baseline.keys()].filter((k) => !current.has(k)).length +
            [...current.keys()].filter((k) => !baseline.has(k)).length +
            [...baseline.keys()].filter(
              (k) => current.has(k) && current.get(k) !== baseline.get(k),
            ).length;
          expect(computeDiff(baseline, current).changed.length).toBe(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
