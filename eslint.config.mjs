// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const integerMoney = "Money is integer yen (bigint): use bigint arithmetic, never floating point.";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/.next/",
    "**/dist/",
    "**/coverage/",
    ".wrangler/",
    "docs/",
    "apps/web/next-env.d.ts",
    "packages/db/prisma/migrations/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // The Service Worker (10 §1.1) runs in the browser's worker scope, not in Node.
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ["packages/ledger/src/**/*.ts", "packages/payroll/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: integerMoney }],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "round", message: integerMoney },
        { object: "Math", property: "floor", message: integerMoney },
        { object: "Math", property: "ceil", message: integerMoney },
        { object: "Number", property: "parseFloat", message: integerMoney },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"], reactHooks.configs.flat.recommended],
    settings: { next: { rootDir: "apps/web/" } },
  },
);
