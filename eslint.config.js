import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/cdk.out/**"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Prevent `any` from creeping back in
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
