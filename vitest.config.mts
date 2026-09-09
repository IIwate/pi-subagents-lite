import { defineConfig } from "vitest/config";

// Note: see .agents/notes/implemented/testing/2026-09-09-test-layers-and-scenario-harness.md
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "scenarios", include: ["test/scenarios/**/*.test.ts"] } },
    ],
  },
});
