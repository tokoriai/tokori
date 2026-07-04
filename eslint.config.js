import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dist-hosted",
      "docs/.vitepress/dist",
      "docs/.vitepress/cache",
      "src-tauri/target",
      "mcp-server/dist",
      "node_modules",
      // Coding-agent worktrees + caches: the harness drops full repo
      // copies under .claude/. Linting them double-counts every file and
      // floods `npm run lint` with hundreds of phantom errors.
      ".claude",
      "coverage",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // The baseline is intentionally permissive: most rules are
      // warnings so `npm run lint` is useful without blocking ship.
      // Tighten over time.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-irregular-whitespace": "warn",
      "no-control-regex": "warn",
      "no-misleading-character-class": "warn",
      "no-prototype-builtins": "warn",
      "no-fallthrough": "warn",
      "no-cond-assign": "warn",
      "no-async-promise-executor": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      // Hard error: a hook after an early return changes hook order
      // between renders and crashes React at runtime. The codebase is
      // clean of these (audited 2026-06), so keep it a build-breaker.
      "react-hooks/rules-of-hooks": "error",
      // eslint-plugin-react-hooks v7 ships React Compiler analyses.
      // Keep them as warnings until the codebase is migrated — they
      // flag real perf issues, not launch blockers.
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/component-hook-factories": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/void-use-memo": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/unsupported-syntax": "warn",
      "react-hooks/syntax": "warn",
      "react-hooks/config": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/no-deriving-state-in-effects": "warn",
      "react-hooks/memoized-effect-dependencies": "warn",
      "react-hooks/exhaustive-effect-dependencies": "warn",
      "react-hooks/memo-dependencies": "warn",
      "react-hooks/capitalized-calls": "warn",
      "preserve-caught-error": "warn",
    },
  },
  {
    files: [
      "scripts/**/*.{js,ts,cjs,mjs}",
      "*.config.{js,ts,cjs,mjs}",
      "vite.config.ts",
      "vitest.config.ts",
      "eslint.config.js",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["mcp-server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
