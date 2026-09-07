/**
 * powershell-execution.test.ts — Verification for PowerShell tool execution (AC-7).
 *
 * Verifies that the powershell tool can be allocated to a subagent and executed
 * successfully with standard commands (e.g. dir, git status), returning a valid ToolResult.
 */

import { describe, it, expect, vi } from "vitest";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, resolveVisibleTools } from "../../src/agents/agent-types.js";

describe("PowerShell execution and tool integration (AC-7)", () => {
  it("powershell tool definition has name 'powershell' and standard schema", () => {
    const tool = createPowerShellTool(process.cwd());
    expect(tool.name).toBe("powershell");
    expect(tool.execute).toBeTypeOf("function");
  });

  it("powershell tool executes commands via operations and returns ToolResult", async () => {
    const mockExec = vi.fn().mockImplementation(async (command, cwd, options) => {
      options.onData?.(Buffer.from("Directory: C:\\project\nMode LastWriteTime Length Name\n---- ------------- ------ ----\n"));
      return { exitCode: 0 };
    });

    const mockOperations = {
      exec: mockExec,
    };

    const tool = createPowerShellTool(process.cwd(), {
      operations: mockOperations,
    });

    const result = await tool.execute("call-1", { command: "dir" });
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    const textBlock = result.content.find((c: any) => c.type === "text");
    expect(textBlock?.text).toContain("Directory: C:\\project");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("dir"),
      process.cwd(),
      expect.anything(),
    );
  });

  it("subagent allocated with powershell tool retains powershell in resolved visible set", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("powershell");

    const visible = resolveVisibleTools({
      activeTools: ["read", "powershell", "edit", "write"],
      tools: ["powershell", "read"],
    });

    expect(visible).toEqual(["powershell", "read"]);
    expect(visible).not.toContain("bash");
  });

  it("handles git status execution in PowerShell", async () => {
    const mockExec = vi.fn().mockImplementation(async (command, cwd, options) => {
      options.onData?.(Buffer.from("On branch main\nnothing to commit, working tree clean\n"));
      return { exitCode: 0 };
    });

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    const result = await tool.execute("call-2", { command: "git status" });
    expect(result).toBeDefined();
    const text = result.content[0]?.text;
    expect(text).toContain("On branch main");
    expect(text).toContain("working tree clean");
  });
});
