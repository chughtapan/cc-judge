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
    const out = parseStreamJson("plain text output\nno json here\n");
    expect(out.response).toBe("plain text output\nno json here\n");
    expect(out.toolCallCount).toBe(0);
  });

  it("returns empty turn for empty input", () => {
    const out = parseStreamJson("");
    expect(out.response).toBe("");
    expect(out.toolCallCount).toBe(0);
  });

  it("concatenates multiple assistant content events", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", content: "Hello " }),
      JSON.stringify({ type: "assistant", content: "world." }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe("Hello world.");
  });

  it("uses result event when no assistant content was seen", () => {
    const stdout = JSON.stringify({ type: "result", result: "final answer" });
    expect(parseStreamJson(stdout).response).toBe("final answer");
  });

  it("ignores result event when assistant content was already collected", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", content: "the real answer" }),
      JSON.stringify({ type: "result", result: "should be ignored" }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe("the real answer");
  });

  it("counts tool_use and tool_call events", () => {
    const stdout = [
      JSON.stringify({ type: "tool_use" }),
      JSON.stringify({ type: "tool_call" }),
      JSON.stringify({ type: "tool_use" }),
    ].join("\n");
    expect(parseStreamJson(stdout).toolCallCount).toBe(3);
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
    const stdout = [
      "not json {{{",
      JSON.stringify({ type: "assistant", content: "after the bad line" }),
      "more garbage",
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe("after the bad line");
  });

  it("skips lines that parse to non-object values (string, number, null, array)", () => {
    const stdout = [
      '"a string"',
      "42",
      "null",
      "[1, 2, 3]",
      JSON.stringify({ type: "assistant", content: "final" }),
    ].join("\n");
    expect(parseStreamJson(stdout).response).toBe("final");
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
    const stdout = [
      JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({ type: "result", usage: { input_tokens: 3, output_tokens: 2 } }),
    ].join("\n");
    const out = parseStreamJson(stdout);
    expect(out.inputTokens).toBe(13);
    expect(out.outputTokens).toBe(7);
  });

  it("aggregates cache_read and cache_creation tokens separately", () => {
    const stdout = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    const out = parseStreamJson(stdout);
    expect(out.cacheReadTokens).toBe(80);
    expect(out.cacheWriteTokens).toBe(20);
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
        expect(typeof out.response).toBe("string");
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
    writeFileSync(path.join(dir, "a.txt"), "alpha", "utf8");
    writeFileSync(path.join(dir, "b.txt"), "beta", "utf8");
    const result = yield* walkWorkspace(dir);
    expect(result.size).toBe(2);
    expect(result.get("a.txt")).toBe("alpha");
    expect(result.get("b.txt")).toBe("beta");
  });

  itEffect("recurses into subdirectories with relative path keys", function* () {
    const dir = makeTempDir("walk-nested");
    mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
    writeFileSync(path.join(dir, "root.txt"), "1", "utf8");
    writeFileSync(path.join(dir, "sub", "mid.txt"), "2", "utf8");
    writeFileSync(path.join(dir, "sub", "deep", "leaf.txt"), "3", "utf8");
    const result = yield* walkWorkspace(dir);
    expect(result.size).toBe(3);
    expect(result.get("root.txt")).toBe("1");
    expect(result.get(path.join("sub", "mid.txt"))).toBe("2");
    expect(result.get(path.join("sub", "deep", "leaf.txt"))).toBe("3");
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
