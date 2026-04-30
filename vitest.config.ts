import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Integration tests require external services (Docker daemon) and
    // run via `pnpm test:integration` against vitest.config.integration.ts.
    exclude: ["tests/e2e/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
