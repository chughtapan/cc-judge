// Day-one safer floor: eslint-plugin-safer-by-default @ recommended preset
// (the renamed published form of agent-code-guard), plus the @typescript-eslint
// companion plugin for baseline TS hygiene.
//
// Spec rev 2 invariant #11: strict tsconfig + Effect + TypeBox + this plugin
// at recommended is the initial-commit floor for cc-judge.

import guard from "eslint-plugin-safer-by-default";
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
      "safer-by-default": guard,
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...guard.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // Block 2: tests. Looser rules (no `no-vitest-mocks` here either way; we lean on real integrations).
  {
    files: ["tests/**/*.ts", "**/*.test.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      "safer-by-default": guard,
      "@typescript-eslint": tseslint,
    },
    rules: {
      "safer-by-default/bare-catch": "error",
      "safer-by-default/no-hardcoded-secrets": "error",
      "@typescript-eslint/no-explicit-any": "warn",
    },
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
