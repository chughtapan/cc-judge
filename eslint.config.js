// Day-one safer floor: eslint-plugin-agent-code-guard @ recommended preset,
// plus the @typescript-eslint companion plugin for baseline TS hygiene.
//
// Spec rev 2 invariant #11: strict tsconfig + Effect + TypeBox + this plugin
// at recommended is the initial-commit floor for cc-judge.

import guard from "eslint-plugin-agent-code-guard";
import tsParser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";

export default [
  // Block 1: application source.
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.spec.ts", "dist/**", "node_modules/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      "agent-code-guard": guard,
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...guard.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // Block 2: tests. Full recommended preset applies. `@typescript-eslint/no-explicit-any`
  // is relaxed to warn because test fixtures occasionally need escape hatches.
  {
    files: ["tests/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      "agent-code-guard": guard,
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...guard.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Block 3: integration tests. Enables no-vitest-mocks so integration suites
  // cannot mock the boundary they're supposed to be exercising for real.
  {
    files: ["tests/integration/**/*.ts", "**/*.integration.test.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "agent-code-guard": guard },
    rules: guard.configs.integrationTests.rules,
  },

  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eval-results/**",
      "tools/vendor/**",
    ],
  },
];
