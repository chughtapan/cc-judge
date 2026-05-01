// Property-based tests for pure helpers in src/emit/wal.ts.
// These exist to kill mutation-test survivors that example-based tests
// only hit narrowly. Each fc.property generates many inputs across the
// relevant input domain in a single test case.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  PAYLOAD_PREVIEW_MAX_CHARS,
  UNSTRINGIFIABLE_ERROR,
  UNSTRINGIFIABLE_PAYLOAD,
  WAL_LINE_KIND,
  errorToString,
  isEnoent,
  isOutcomeLine,
  previewPayload,
  walPathsFromResultsDir,
} from "../src/emit/wal.js";
import * as path from "node:path";

const PROPERTY_RUNS = 200;

describe("previewPayload (PBT)", () => {
  it("returns a string for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        // .length is only callable on strings; structural check.
        expect(previewPayload(payload).length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("output length never exceeds the cap plus one ellipsis char", () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        const out = previewPayload(payload);
        expect(out.length).toBeLessThanOrEqual(PAYLOAD_PREVIEW_MAX_CHARS + 1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("appends an ellipsis iff the JSON form exceeds the cap", () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        const out = previewPayload(payload);
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(payload);
        } catch (err) {
          void err;
          serialized = undefined;
        }
        if (serialized === undefined) {
          expect(out).toBe(UNSTRINGIFIABLE_PAYLOAD);
          return;
        }
        if (serialized.length > PAYLOAD_PREVIEW_MAX_CHARS) {
          expect(out.endsWith("…")).toBe(true);
          expect(out.length).toBe(PAYLOAD_PREVIEW_MAX_CHARS + 1);
        } else {
          expect(out).toBe(serialized);
          expect(out.endsWith("…")).toBe(false);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("preserves the JSON prefix when truncating", () => {
    // Build payloads guaranteed to exceed the cap so we always hit the
    // truncate branch; the first PAYLOAD_PREVIEW_MAX_CHARS chars must
    // match the head of JSON.stringify exactly.
    fc.assert(
      fc.property(
        fc.string({ minLength: PAYLOAD_PREVIEW_MAX_CHARS + 50 }),
        (longString) => {
          const out = previewPayload(longString);
          const serialized = JSON.stringify(longString);
          expect(out.slice(0, PAYLOAD_PREVIEW_MAX_CHARS)).toBe(
            serialized.slice(0, PAYLOAD_PREVIEW_MAX_CHARS),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns '<unstringifiable>' for values JSON.stringify cannot serialize", () => {
    // Functions and undefined both make JSON.stringify return undefined.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(() => undefined),
          fc.constant(Symbol("x")),
        ),
        (payload) => {
          expect(previewPayload(payload)).toBe(UNSTRINGIFIABLE_PAYLOAD);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("returns '<unstringifiable>' on circular references (JSON.stringify throws)", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(previewPayload(circular)).toBe(UNSTRINGIFIABLE_PAYLOAD);
  });

  it("returns the raw JSON for short payloads (no ellipsis suffix)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.boolean(),
          fc.integer(),
          fc.constantFrom(null, 0, "", "x"),
        ),
        (payload) => {
          const out = previewPayload(payload);
          expect(out).toBe(JSON.stringify(payload));
          expect(out.endsWith("…")).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ── isOutcomeLine ───────────────────────────────────────────────────────────

describe("isOutcomeLine (PBT)", () => {
  it("returns false for non-object inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.integer(),
          fc.string(),
        ),
        (value) => {
          expect(isOutcomeLine(value)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns true iff the object's kind field equals WAL_LINE_KIND.Outcome", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.anything()),
        fc.string(),
        (extras, kindValue) => {
          const obj = { ...extras, kind: kindValue };
          if (kindValue === WAL_LINE_KIND.Outcome) {
            expect(isOutcomeLine(obj)).toBe(true);
          } else {
            expect(isOutcomeLine(obj)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns false for objects without a kind field", () => {
    fc.assert(
      fc.property(
        fc
          .dictionary(fc.string(), fc.anything())
          .filter((o) => !("kind" in o)),
        (obj) => {
          expect(isOutcomeLine(obj)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("recognises a concrete outcome line shape", () => {
    expect(
      isOutcomeLine({ v: 1, runId: "r", seq: 5, ts: 0, kind: WAL_LINE_KIND.Outcome, payload: {} }),
    ).toBe(true);
  });
});

// ── errorToString ───────────────────────────────────────────────────────────

describe("errorToString (PBT)", () => {
  it("returns Error.message for Error instances", () => {
    fc.assert(
      fc.property(fc.string(), (msg) => {
        expect(errorToString(new Error(msg))).toBe(msg);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns String(value) for non-Error inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.integer(),
          fc.string(),
        ),
        (value) => {
          expect(errorToString(value)).toBe(String(value));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns a string for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        // .length is only callable on strings — structural type check.
        expect(errorToString(value).length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("falls back to UNSTRINGIFIABLE_ERROR when String() throws", () => {
    const hostile = {
      toString(): string {
        throw new Error("nope");
      },
    };
    expect(errorToString(hostile)).toBe(UNSTRINGIFIABLE_ERROR);
  });
});

// ── isEnoent ────────────────────────────────────────────────────────────────

describe("isEnoent (PBT)", () => {
  it("returns false for non-object inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.integer(),
          fc.string(),
        ),
        (value) => {
          expect(isEnoent(value)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns true iff the object has code === 'ENOENT'", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.anything()),
        fc.string(),
        (extras, code) => {
          const obj = { ...extras, code };
          if (code === "ENOENT") {
            expect(isEnoent(obj)).toBe(true);
          } else {
            expect(isEnoent(obj)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("returns false for an object with code === 'EACCES' (close miss)", () => {
    expect(isEnoent({ code: "EACCES" })).toBe(false);
  });
});

// ── walPathsFromResultsDir ──────────────────────────────────────────────────

describe("walPathsFromResultsDir (PBT)", () => {
  it("inflightDir is always under resultsDir", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (resultsDir) => {
        const paths = walPathsFromResultsDir(resultsDir);
        expect(paths.resultsDir).toBe(resultsDir);
        expect(paths.inflightDir).toBe(path.join(resultsDir, "inflight"));
        expect(paths.runsDir).toBe(path.join(resultsDir, "runs"));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("inflightDir and runsDir are siblings (different basenames)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (resultsDir) => {
        const paths = walPathsFromResultsDir(resultsDir);
        expect(path.dirname(paths.inflightDir)).toBe(path.dirname(paths.runsDir));
        expect(path.basename(paths.inflightDir)).not.toBe(path.basename(paths.runsDir));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
