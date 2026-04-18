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
  thresholds: { high: 80, low: 60, break: 50 },
  reporters: ['clear-text', 'html', 'progress'],
};
