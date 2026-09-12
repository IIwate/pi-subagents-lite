import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: ["src/**/*.ts", "test/**/*.ts", "vitest.config.mts"],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  rules: {
    // Setup callbacks may read a forward declaration before its assignment completes.
    "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    // Host adapters and test doubles use Pi APIs with incomplete public types.
    "@typescript-eslint/no-explicit-any": "off",
    // TypeScript already checks unused locals and parameters in both projects.
    "@typescript-eslint/no-unused-vars": "off",
  },
}, {
  files: ["src/ui/format.ts", "src/ui/navigator-view.ts", "test/support/navigator.ts", "test/unit/ui/**/*.test.ts"],
  // Terminal sanitization, ANSI layout, and their tests intentionally match control bytes.
  rules: { "no-control-regex": "off" },
});
