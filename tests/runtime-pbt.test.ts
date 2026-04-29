// Property-based tests for pure helpers in src/runner/runtime.ts.
// shellQuote is the prime PBT target: a tiny pure escaping function with
// crisp invariants (round-trip through bash, idempotent on safe inputs,
// always-quoted on unsafe inputs).

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fc from "fast-check";
import { shellQuote } from "../src/runner/runtime.js";

const PROPERTY_RUNS = 200;
const SAFE_PATTERN = /^[A-Za-z0-9_:@./=-]+$/u;

describe("shellQuote (PBT)", () => {
  it("returns the input unchanged for the safe character set", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_:@./=-]+$/u, { minLength: 1 }),
        (value) => {
          expect(shellQuote(value)).toBe(value);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("wraps any input that contains an unsafe character in single quotes", () => {
    fc.assert(
      fc.property(
        // Force at least one unsafe character (space, $, &, ;, etc.) by
        // splicing it into an arbitrary string.
        fc.tuple(
          fc.string(),
          fc.constantFrom(" ", "$", "&", ";", "*", "\"", "\\", "\n", "(", ")"),
          fc.string(),
        ),
        ([prefix, unsafeChar, suffix]) => {
          const value = prefix + unsafeChar + suffix;
          const out = shellQuote(value);
          // Unsafe → must be single-quote wrapped at both ends. The
          // wrapping is the contract the rest of the file relies on.
          expect(out.startsWith("'")).toBe(true);
          expect(out.endsWith("'")).toBe(true);
          expect(out).not.toBe(value);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("escapes embedded single quotes using the canonical close-escape-reopen pattern", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (value) => {
        if (!value.includes("'")) return; // only relevant when value has a quote
        const out = shellQuote(value);
        // Canonical escape sequence: ' (close) + \' (escaped quote) + ' (reopen).
        // Every embedded quote in `value` should appear as `'\''` in the output.
        const occurrences = (value.match(/'/gu) ?? []).length;
        const escapedOccurrences = (out.match(/'\\''/gu) ?? []).length;
        expect(escapedOccurrences).toBe(occurrences);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("output never contains a bare unescaped quote inside the wrapping", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const out = shellQuote(value);
        if (!out.startsWith("'")) return; // safe-set passthrough; no wrapping
        // Strip outer quotes; the interior should contain quotes only as
        // part of the close-escape-reopen `'\''` sequence.
        const interior = out.slice(1, -1);
        // Replace all valid escape sequences and verify no bare quote remains.
        const stripped = interior.replace(/'\\''/gu, "");
        expect(stripped.includes("'")).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("round-trips through /bin/echo for any printable input", () => {
    // Slow-ish: spawns /bin/echo per case. Cap runs lower than other
    // properties to keep wall time reasonable.
    fc.assert(
      fc.property(
        // Exclude characters that /bin/echo or shell parser interpret
        // outside of the quoting contract (NUL is illegal in argv; a
        // trailing newline is consumed by `-n`'s peer behavior).
        fc.string().filter((s) => !s.includes("\0")),
        (value) => {
          const quoted = shellQuote(value);
          // Use sh -c so the quoting goes through a real shell parser.
          const echoed = execFileSync("sh", ["-c", `printf %s ${quoted}`], {
            encoding: "utf8",
          });
          expect(echoed).toBe(value);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("safe-pattern output equals the input only when the regex matches", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (value) => {
        const out = shellQuote(value);
        if (SAFE_PATTERN.test(value)) {
          expect(out).toBe(value);
        } else {
          expect(out).not.toBe(value);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
