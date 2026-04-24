import { Effect, Either } from "effect";
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

export function expectLeft<E, A>(value: Either.Either<A, E>): E {
  return Either.match(value, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("expected Left");
    },
  });
}

// `_tag` values of Effect's Either discriminant. Shared across test files that
// assert on runPromise + Effect.either results.
export const EITHER_LEFT = "Left" as const;
export const EITHER_RIGHT = "Right" as const;
