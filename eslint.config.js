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

  // Block 2: tests. Start from recommended, then carve out the two rules that
  // fight vitest idioms today: `async-keyword` (tests use async/await; Effect.gen
  // conversion lands in a follow-up) and `no-hardcoded-assertion-literals` (many
  // assertions still use raw literals). Both carve-outs are temporary and removed
  // when /safer:implement-senior rewrites the suite.
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
      "agent-code-guard/async-keyword": "off",
      "agent-code-guard/no-hardcoded-assertion-literals": "off",
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
