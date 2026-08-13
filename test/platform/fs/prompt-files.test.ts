import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomPromptFile,
  customPromptFileExists,
  readCustomPromptFile,
  readProjectContextFiles,
} from "../../../src/platform/fs/prompt-files.js";

describe("platform prompt file adapter", () => {
  it("returns missing, empty, and readable custom prompt contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "prompt-files-"));
    const missing = join(directory, "missing.md");
    const empty = join(directory, "empty.md");
    const filled = join(directory, "filled.md");
    writeFileSync(empty, "   \n", "utf-8");
    writeFileSync(filled, " You are a review sub-agent. \n", "utf-8");

    expect(readCustomPromptFile(missing)).toEqual({
      ok: false,
      reason: "missing",
      message: `Custom prompt file not found: ${missing}`,
    });
    expect(readCustomPromptFile(empty)).toEqual({
      ok: false,
      reason: "empty",
      message: `Custom prompt file is empty: ${empty}`,
    });
    expect(readCustomPromptFile(filled)).toEqual({
      ok: true,
      content: "You are a review sub-agent.",
    });
  });

  it("creates the starter prompt file with missing parent directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "prompt-files-"));
    const target = join(directory, "nested", "agent", "subagent-prompt.md");
    expect(customPromptFileExists(target)).toBe(false);

    expect(createCustomPromptFile(target)).toEqual({ ok: true });
    expect(customPromptFileExists(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("expert coding sub-agent");
  });

  it("reports creation failure instead of throwing when the path is unwritable", () => {
    const directory = mkdtempSync(join(tmpdir(), "prompt-files-"));
    const occupied = join(directory, "occupied");
    writeFileSync(occupied, "not a directory", "utf-8");
    // Parent path is a file, so mkdir/write must fail on every platform.
    const result = createCustomPromptFile(join(occupied, "prompt.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it("returns serialized context files from the host loader", () => {
    const files = readProjectContextFiles({
      cwd: "C:/project",
      agentDir: "C:/agent",
      load: ({ cwd, agentDir }) => {
        expect({ cwd, agentDir }).toEqual({ cwd: "C:/project", agentDir: "C:/agent" });
        return [{ path: "C:/project/AGENTS.md", content: "House style." }];
      },
    });
    expect(files).toEqual([{ path: "C:/project/AGENTS.md", content: "House style." }]);
  });
});
