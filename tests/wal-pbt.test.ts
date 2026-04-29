// Property-based tests for pure helpers in src/emit/wal.ts.
// These exist to kill mutation-test survivors that example-based tests
// only hit narrowly. Each fc.property generates many inputs across the
// relevant input domain in a single test case.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { PAYLOAD_PREVIEW_MAX_CHARS, previewPayload } from "../src/emit/wal.js";

const PROPERTY_RUNS = 200;

describe("previewPayload (PBT)", () => {
  it("returns a string for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        expect(typeof previewPayload(payload)).toBe("string");
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
          expect(out).toBe("<unstringifiable>");
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
          expect(previewPayload(payload)).toBe("<unstringifiable>");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("returns '<unstringifiable>' on circular references (JSON.stringify throws)", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(previewPayload(circular)).toBe("<unstringifiable>");
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
