import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { scanAgentFilesInDir } from "../../../src/agents/agent-discovery.js";
import { makeAgentMd, tempDirWithFiles } from "../../support/fixtures.js";

let harness: TestHarness;
beforeEach(() => { harness = createTestHarness(); });
afterEach(async () => { await harness.dispose(); });

describe("scanAgentFilesInDir", () => {
  it("sorts filenames and skips malformed YAML without losing valid agents", async () => {
    const dir = tempDirWithFiles(harness, [
      { name: "z.md", content: "---\r\nname: zeta\r\n---\r\nZeta" },
      { name: "a.md", content: "---\nname: alpha\n---\nAlpha" },
      { name: "m-invalid.md", content: "---\nname: first\nname: second\n---\nInvalid" },
    ]);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    vi.spyOn(fs.promises, "readdir").mockResolvedValueOnce(entries.reverse() as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await scanAgentFilesInDir(dir)).map(agent => agent.name)).toEqual(["alpha", "zeta"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("m-invalid.md"));
  });
  it("returns empty array for non-existent directory", async () => {
    const result = await scanAgentFilesInDir("/tmp/nonexistent-sdf9asdf", "user");
    expect(result).toEqual([]);
  });

  it("parses all .md files in a directory", async () => {
    const dir = tempDirWithFiles(harness, [
      { name: "alpha.md", content: makeAgentMd({ name: "alpha" }) },
      { name: "beta.md", content: makeAgentMd({ name: "beta" }) },
      { name: "gamma.md", content: makeAgentMd({ name: "gamma" }) },
      { name: "readme.txt", content: "not an agent file" },
    ]);

    const agents = await scanAgentFilesInDir(dir, "user");
    expect(agents.map((agent) => agent.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty array when no .md files", async () => {
    const dir = tempDirWithFiles(harness, [
      { name: "data.json", content: "{}" },
    ]);

    const agents = await scanAgentFilesInDir(dir, "user");
    expect(agents).toEqual([]);
  });

  it("assigns source to all parsed agents", async () => {
    const dir = tempDirWithFiles(harness, [
      { name: "agent1.md", content: makeAgentMd({ name: "agent1" }) },
    ]);

    const agents = await scanAgentFilesInDir(dir, "project");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.source).toBe("project");
  });
});
