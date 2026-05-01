/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
  ],
  testRunner: 'vitest',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  ignoreStatic: true,
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  concurrency: 4,
  // Default 5min dryRunTimeout was too tight when the suite grew past 400
  // tests with PBT — Stryker's cold start (instrumentation + checker +
  // first vitest spin-up) needs more headroom than the test suite itself.
  dryRunTimeoutMinutes: 15,
  thresholds: { high: 80, low: 60, break: 50 },
  reporters: ['clear-text', 'html', 'progress'],
};
