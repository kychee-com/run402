import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Type-aware rules that catch bugs, not style. The CLI (`cli/**/*.mjs`) is
// plain JavaScript and stays out of scope until it has type information.
export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "cli/core-dist/**", ".claude/worktrees/**"],
  },
  {
    files: ["src/**/*.ts", "sdk/src/**/*.ts", "core/src/**/*.ts", "astro/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test-helper.ts", "**/*.integ.ts", "**/*.test.worker.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // An unhandled rejection takes a Node process down. Fire-and-forget is
      // spelled `void promise.catch(...)` (or `void call()` when the callee
      // never rejects), so every un-awaited promise is a decision on the page.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false, attributes: false } }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      // Only where awaiting changes which catch/finally sees the rejection.
      "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-deprecated": "error",
      "eqeqeq": ["error", "smart"],
      "no-fallthrough": "error",
    },
  },
];
