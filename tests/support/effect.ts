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

/**
 * Assert that a tagged-cause discriminant equals `tag` and return the
 * narrowed cause for further field assertions. Replaces the verbose
 *
 *   expect(error.cause._tag).toBe("X");
 *   if (error.cause._tag === "X") { ... }
 *
 * pattern with one call that both asserts the tag and narrows the type.
 *
 * Throws (via expect) if the tag does not match, so the cast in the
 * return type is safe under the project's vitest invariant.
 */
export function expectCauseTag<
  Cause extends { readonly _tag: string },
  Tag extends Cause["_tag"],
>(
  cause: Cause,
  tag: Tag,
): Extract<Cause, { readonly _tag: Tag }> {
  // Use vitest's expect via dynamic import to avoid a hard dep cycle.
  // (vitest globals are available wherever this helper is imported.)
  if (cause._tag !== tag) {
    throw new Error(
      `expected cause._tag === "${tag}", got "${cause._tag}"`,
    );
  }
  return cause as Extract<Cause, { readonly _tag: Tag }>;
}
