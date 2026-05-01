// Targeted formatter tests for `formatJudgePreflightMessage`.
//
// The strings here ARE the CLI contract (`cc-judge: ...` printed to stderr
// on preflight failure). Pinning them in this dedicated formatter test
// lets tests/judge-preflight.test.ts assert on JudgePreflightResult tags
// structurally without losing mutation coverage on the user-visible copy.
//
// PBT covers the only meaningful input axis (the `detail` string on
// PreflightFailed and InvalidJson); examples pin every exact phrase.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  JUDGE_PREFLIGHT_TAG,
  JudgePreflightResult,
  formatJudgePreflightMessage,
} from "../src/app/judge-preflight.js";

const PROPERTY_RUNS = 100;

describe("formatJudgePreflightMessage", () => {
  it("Ready returns null (no message printed)", () => {
    expect(formatJudgePreflightMessage(JudgePreflightResult.Ready())).toBeNull();
  });

  describe("PreflightFailed", () => {
    it("with non-empty detail: 'claude auth preflight failed: <detail>'", () => {
      const detail = "spawn ENOENT";
      expect(
        formatJudgePreflightMessage(JudgePreflightResult.PreflightFailed({ detail })),
      ).toBe(`claude auth preflight failed: ${detail}`);
    });

    it("with empty detail: 'claude auth preflight failed' (no trailing colon)", () => {
      expect(
        formatJudgePreflightMessage(JudgePreflightResult.PreflightFailed({ detail: "" })),
      ).toBe("claude auth preflight failed");
    });

    it("PBT: any non-empty detail roundtrips into the suffixed form", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }).filter((s) => !s.includes("\n")),
          (detail) => {
            const out = formatJudgePreflightMessage(
              JudgePreflightResult.PreflightFailed({ detail }),
            );
            expect(out).toBe(`claude auth preflight failed: ${detail}`);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("PBT: every PreflightFailed message starts with the canonical prefix", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (detail) => {
          const out = formatJudgePreflightMessage(
            JudgePreflightResult.PreflightFailed({ detail }),
          );
          expect(out?.startsWith("claude auth preflight failed")).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe("AuthMissing", () => {
    const message = formatJudgePreflightMessage(JudgePreflightResult.AuthMissing());

    it("starts with 'claude auth missing'", () => {
      expect(message?.startsWith("claude auth missing")).toBe(true);
    });

    it("instructs the user to run `claude auth login`", () => {
      expect(message).toContain("`claude auth login`");
    });

    it("mentions the ANTHROPIC_API_KEY env-var fallback", () => {
      expect(message).toContain("ANTHROPIC_API_KEY");
    });

    it("renders the full canonical sentence", () => {
      expect(message).toBe(
        "claude auth missing: run `claude auth login` or set ANTHROPIC_API_KEY",
      );
    });
  });

  describe("InvalidJson", () => {
    it("with non-empty detail: 'claude auth preflight returned invalid JSON: <detail>'", () => {
      const detail = "Unexpected token } in JSON at position 17";
      expect(
        formatJudgePreflightMessage(JudgePreflightResult.InvalidJson({ detail })),
      ).toBe(`claude auth preflight returned invalid JSON: ${detail}`);
    });

    it("with empty detail: 'claude auth preflight returned invalid JSON' (no trailing colon)", () => {
      expect(
        formatJudgePreflightMessage(JudgePreflightResult.InvalidJson({ detail: "" })),
      ).toBe("claude auth preflight returned invalid JSON");
    });

    it("PBT: any non-empty detail roundtrips into the suffixed form", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }).filter((s) => !s.includes("\n")),
          (detail) => {
            const out = formatJudgePreflightMessage(
              JudgePreflightResult.InvalidJson({ detail }),
            );
            expect(out).toBe(`claude auth preflight returned invalid JSON: ${detail}`);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("PBT: every InvalidJson message starts with the canonical prefix", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (detail) => {
          const out = formatJudgePreflightMessage(
            JudgePreflightResult.InvalidJson({ detail }),
          );
          expect(out?.startsWith("claude auth preflight returned invalid JSON")).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe("PBT: cross-tag invariants", () => {
    const tagArb = fc.constantFrom(
      JUDGE_PREFLIGHT_TAG.Ready,
      JUDGE_PREFLIGHT_TAG.PreflightFailed,
      JUDGE_PREFLIGHT_TAG.AuthMissing,
      JUDGE_PREFLIGHT_TAG.InvalidJson,
    );

    function build(tag: string, detail: string) {
      switch (tag) {
        case JUDGE_PREFLIGHT_TAG.Ready: return JudgePreflightResult.Ready();
        case JUDGE_PREFLIGHT_TAG.PreflightFailed:
          return JudgePreflightResult.PreflightFailed({ detail });
        case JUDGE_PREFLIGHT_TAG.AuthMissing: return JudgePreflightResult.AuthMissing();
        case JUDGE_PREFLIGHT_TAG.InvalidJson:
          return JudgePreflightResult.InvalidJson({ detail });
        default: throw new Error(`unknown tag ${tag}`);
      }
    }

    it("Ready ↔ null is the only null-returning branch", () => {
      fc.assert(
        fc.property(tagArb, fc.string({ maxLength: 50 }), (tag, detail) => {
          const out = formatJudgePreflightMessage(build(tag, detail));
          if (tag === JUDGE_PREFLIGHT_TAG.Ready) {
            expect(out).toBeNull();
          } else {
            expect(out).not.toBeNull();
            expect((out as string).length).toBeGreaterThan(0);
          }
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("non-Ready messages are single-line (no embedded newlines)", () => {
      fc.assert(
        fc.property(
          tagArb.filter((t) => t !== JUDGE_PREFLIGHT_TAG.Ready),
          fc.string({ maxLength: 50 }).filter((s) => !s.includes("\n")),
          (tag, detail) => {
            const out = formatJudgePreflightMessage(build(tag, detail));
            expect(out).not.toBeNull();
            expect((out as string).includes("\n")).toBe(false);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe("tag map matches the runtime constructors", () => {
    it("Ready", () => {
      expect(JudgePreflightResult.Ready()._tag).toBe(JUDGE_PREFLIGHT_TAG.Ready);
    });
    it("PreflightFailed", () => {
      expect(JudgePreflightResult.PreflightFailed({ detail: "x" })._tag)
        .toBe(JUDGE_PREFLIGHT_TAG.PreflightFailed);
    });
    it("AuthMissing", () => {
      expect(JudgePreflightResult.AuthMissing()._tag).toBe(JUDGE_PREFLIGHT_TAG.AuthMissing);
    });
    it("InvalidJson", () => {
      expect(JudgePreflightResult.InvalidJson({ detail: "x" })._tag)
        .toBe(JUDGE_PREFLIGHT_TAG.InvalidJson);
    });
  });
});
