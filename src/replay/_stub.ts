// Internal marker used by architect-only interface stubs.
//
// Every public function in `./replay/*` declares the shape the implementation
// at cc-judge#99 must fill in. Until that lands, each body is a single call
// to `notImplemented()`. The lint rule `agent-code-guard/no-raw-throw-new-error`
// correctly forbids raw `throw new Error(...)` in production code; we funnel
// stub bodies through this one call so exactly one `eslint-disable` line
// exists in the tree, and the impl-staff PR deletes this file when every
// stub has a real body.
//
// Principle 6 (Budget Gate): this marker is the budget boundary. If you are
// editing it to add logic, you are no longer writing a stub.

/** Throws a distinguishable `Error` so failed stub calls are greppable.
 *  Callers never catch this — it is a signal that the architect branch was
 *  loaded without the implementation PR. */
export function notImplemented(label: string): never {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error
  throw new Error(`cc-judge replay substrate: not implemented (${label})`);
}
