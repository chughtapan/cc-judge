// itEffect — wrap a vitest `it` around an Effect.gen body.
// The body is a generator yielding Effect values; runs via Effect.runPromise.
// Satisfies agent-code-guard/async-keyword by keeping all test bodies Effect-first.

import { Effect } from "effect";
import type { YieldWrap } from "effect/Utils";
import { it } from "vitest";

type EffectBody<A> = () => Generator<
  YieldWrap<Effect.Effect<unknown, unknown, never>>,
  A,
  unknown
>;

export function itEffect<A>(name: string, body: EffectBody<A>, timeout?: number): void {
  if (timeout === undefined) {
    it(name, () => Effect.runPromise(Effect.gen(body)));
  } else {
    it(name, () => Effect.runPromise(Effect.gen(body)), timeout);
  }
}
