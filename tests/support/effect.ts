import { Effect } from "effect";
import type { YieldWrap } from "effect/Utils";
import { it } from "vitest";

type EffectBody<A> = () => Generator<
  YieldWrap<Effect.Effect<unknown, unknown, never>>,
  A,
  unknown
>;

export function itEffect<A>(name: string, body: EffectBody<A>, timeout?: number): void {
  it(name, () => Effect.runPromise(Effect.gen(body)), timeout);
}

// `_tag` values of Effect's Either discriminant. Shared across test files that
// assert on runPromise + Effect.either results.
export const EITHER_LEFT = "Left" as const;
export const EITHER_RIGHT = "Right" as const;
