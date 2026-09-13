import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkingDirectory } from "../../../src/agents/working-directory.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

describe("resolveWorkingDirectory", () => {
  let harness: TestHarness;
  let directory: string;
  beforeEach(() => {
    harness = createTestHarness();
    directory = harness.createTempDir();
  });
  afterEach(() => harness.dispose());

  it("uses the parent directory when cwd is omitted", async () => {
    expect(await resolveWorkingDirectory(undefined, directory)).toBe(directory);
  });

  it("resolves absolute and parent-relative directories without a Git repository", async () => {
    const parent = join(directory, "parent");
    const target = join(directory, "test workspace");
    mkdirSync(parent); mkdirSync(target);
    expect(await resolveWorkingDirectory(target, parent)).toBe(target);
    expect(await resolveWorkingDirectory("../test workspace", parent)).toBe(target);
    expect(await resolveWorkingDirectory(".", parent)).toBe(parent);
  });

  it("resolves directory aliases to their physical target", async () => {
    const target = join(directory, "target");
    const alias = join(directory, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await resolveWorkingDirectory(alias, directory)).toBe(target);
    expect(await resolveWorkingDirectory(undefined, alias)).toBe(target);
  });

  it.each(["", "   ", null, 1, false])("rejects an explicit invalid cwd: %j", async cwd => {
    await expect(resolveWorkingDirectory(cwd, directory)).rejects.toThrow("cwd must be a non-empty directory path");
  });

  it("reports missing paths and files without falling back to the parent", async () => {
    const file = join(directory, "file.txt");
    writeFileSync(file, "A file is not a working directory");
    await expect(resolveWorkingDirectory("missing", directory)).rejects.toThrow(`Cannot use cwd ${JSON.stringify(join(directory, "missing"))}`);
    await expect(resolveWorkingDirectory(file, directory)).rejects.toThrow("not a directory");
  });
});
