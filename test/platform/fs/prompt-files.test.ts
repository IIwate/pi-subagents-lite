import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCustomPromptFile, readProjectContextFiles } from "../../../src/platform/fs/prompt-files.js";

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
