import { defineConfig } from "vitest/config";

// Integration tests run against real external services (Docker daemon,
// real subprocess binaries). They live under tests/integration/ and are
// excluded from the default `pnpm test` run; invoke them with
// `pnpm test:integration`. Each suite is responsible for skipping
// gracefully when its dependency is unavailable so this config can be
// run unconditionally on any CI box.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Pulling images and building containers can be slow on cold caches.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
