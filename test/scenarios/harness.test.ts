import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../support/harness.js";

describe("test resource ownership", () => {
  it("returns physical paths when the temporary root is a directory alias", async () => {
    const harness = createTestHarness();
    try {
      const root = harness.createTempDir();
      const physical = join(root, "physical temporary root");
      const alias = join(root, "alias");
      mkdirSync(physical);
      symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
      for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, alias);

      expect(dirname(harness.createTempDir())).toBe(physical);
    } finally {
      await harness.dispose();
    }
  });

  it("awaits teardown and completes cleanup after a failure without draining another session", async () => {
    const harness = createTestHarness();
    const other = createTestHarness();
    const directory = harness.createTempDir();
    const otherDirectory = other.createTempDir();
    const released = vi.fn();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("session teardown failed");
    harness.onDispose(async () => { await gate.promise; released(); });
    harness.onDispose(() => { throw failure; });
    const cleanup = harness.dispose();
    const rejected = expect(cleanup).rejects.toMatchObject({ errors: [failure] });
    try {
      expect(existsSync(directory)).toBe(true);
      expect(released).not.toHaveBeenCalled();
      gate.resolve();
      await rejected;
      expect(released).toHaveBeenCalledOnce();
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(otherDirectory)).toBe(true);
      await expect(harness.dispose()).rejects.toMatchObject({ errors: [failure] });
      expect(released).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await cleanup.catch(() => {});
      await other.dispose();
    }
  });
});
