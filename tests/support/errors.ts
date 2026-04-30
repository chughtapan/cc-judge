// Tagged error types for tests that need to surface upstream-Promise
// rejections through Effect's typed channel. Without these, tests would
// either use `Effect.promise` (lint forbids — swallows rejections as
// defects) or thread a generic Error (lint forbids — generic errors in
// the Effect channel).
//
// Each error wraps a single `message` string. The tag distinguishes the
// failure source so a downstream test reader can tell why a property
// failed (PBT shrunk counterexample vs. dockerode rejection vs. ...).

import { Data } from "effect";

/**
 * Wraps fast-check `assert(...)` rejections. The message field carries
 * fast-check's full shrunk-counterexample report verbatim.
 */
export class PbtAssertionError extends Data.TaggedError("PbtAssertionError")<{
  readonly message: string;
}> {}

/**
 * Wraps dockerode (or other Docker integration) Promise rejections so
 * they reach test assertions through the typed Effect channel rather
 * than as Die defects.
 */
export class IntegrationDockerError extends Data.TaggedError("IntegrationDockerError")<{
  readonly message: string;
}> {}
