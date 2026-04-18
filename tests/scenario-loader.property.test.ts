// Property-based tests for the scenario-loader boundary (Principle 2).
// Four properties, mapped to cc-judge#8 acceptance.

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import * as YAML from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scenarioLoader } from "../src/core/scenario.js";

// Narrow ASCII arbitraries. We want YAML to round-trip identically, so we avoid
// leading/trailing whitespace, YAML reserved start characters, and anything that
// the stringifier might re-encode.
const safeStringArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _.,?!:;-]{0,50}$/);
const idArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,40}$/);

const segmentArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/);
const cleanPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

// A mix of clean and hostile paths. The schema's WORKSPACE_PATH_PATTERN must
// reject every hostile shape; clean shapes may pass.
const maybeDirtyPathArb = fc.oneof(
  cleanPathArb,
  cleanPathArb.map((p) => "/" + p),
  cleanPathArb.map((p) => "../" + p),
  cleanPathArb.map((p) => p + "/../etc"),
  cleanPathArb.map((p) => "C:\\windows\\" + p.replaceAll("/", "\\")),
  fc.stringMatching(/^[A-Za-z0-9./_-]{1,40}$/),
);

interface RawScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly setupPrompt: string;
  readonly expectedBehavior: string;
  readonly validationChecks: ReadonlyArray<string>;
  readonly workspace?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

const validScenarioArb: fc.Arbitrary<RawScenario> = fc.record({
  id: idArb,
  name: safeStringArb,
  description: safeStringArb,
  setupPrompt: safeStringArb,
  expectedBehavior: safeStringArb,
  validationChecks: fc.array(safeStringArb, { minLength: 1, maxLength: 3 }),
});

describe("scenarioLoader properties", () => {
  it("Prop1 roundtrip: YAML.stringify → loadFromYaml preserves the generated scenario", async () => {
    await fc.assert(
      fc.asyncProperty(validScenarioArb, async (raw) => {
        const yamlStr = YAML.stringify(raw);
        const decoded = await Effect.runPromise(
          scenarioLoader.loadFromYaml(yamlStr, "mem://rt"),
        );
        expect(String(decoded.id)).toBe(raw.id);
        expect(decoded.name).toBe(raw.name);
        expect(decoded.description).toBe(raw.description);
        expect(decoded.setupPrompt).toBe(raw.setupPrompt);
        expect(decoded.expectedBehavior).toBe(raw.expectedBehavior);
        expect([...decoded.validationChecks]).toEqual([...raw.validationChecks]);
      }),
      { numRuns: 50 },
    );
  });

  it("Prop2 WORKSPACE_PATH_PATTERN invariant: any decoded workspace path is scenario-relative", async () => {
    const base = {
      id: "wp",
      name: "wp",
      description: "d",
      setupPrompt: "p",
      expectedBehavior: "e",
      validationChecks: ["c"],
    };
    await fc.assert(
      fc.asyncProperty(maybeDirtyPathArb, async (p) => {
        const raw = { ...base, workspace: [{ path: p, content: "x" }] };
        const yamlStr = YAML.stringify(raw);
        const result = await Effect.runPromise(
          Effect.either(scenarioLoader.loadFromYaml(yamlStr, "mem://wp")),
        );
        if (result._tag !== "Right") return;
        for (const f of result.right.workspace ?? []) {
          expect(f.path.startsWith("/")).toBe(false);
          expect(f.path.includes("\\")).toBe(false);
          expect(/^[A-Za-z]:/.test(f.path)).toBe(false);
          expect(/(?:^|\/)\.\.(?:\/|$)/.test(f.path)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Prop3 collision detection: two files with the same id yield a tagged DuplicateId error", async () => {
    await fc.assert(
      fc.asyncProperty(idArb, async (id) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "ccj-prop-dup-"));
        const body = `id: ${id}
name: n
description: d
setupPrompt: p
expectedBehavior: e
validationChecks: [c]
`;
        writeFileSync(path.join(dir, "a.yaml"), body, "utf8");
        writeFileSync(path.join(dir, "b.yaml"), body, "utf8");
        const result = await Effect.runPromise(
          Effect.either(scenarioLoader.loadFromPath(dir)),
        );
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left.cause._tag).toBe("DuplicateId");
        }
      }),
      { numRuns: 20 },
    );
  });

  it("Prop4 malformed input: arbitrary garbage resolves to a tagged LoadError, never an uncaught throw", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (garbage) => {
        const result = await Effect.runPromise(
          Effect.either(scenarioLoader.loadFromYaml(garbage, "mem://fuzz")),
        );
        if (result._tag === "Left") {
          const t = result.left.cause._tag;
          expect(t === "ParseFailure" || t === "SchemaInvalid").toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
