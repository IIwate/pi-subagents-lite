/**
 * powershell-execution.test.ts — PowerShell tool operations boundary.
 *
 * Verifies that the powershell tool can be allocated to a subagent and executed
 * successfully with standard commands (e.g. dir, git status), returning a valid ToolResult.
 */

import { describe, it, expect, vi } from "vitest";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";

describe("PowerShell tool operations", () => {
  it("powershell tool definition has name 'powershell' and standard schema", () => {
    const tool = createPowerShellTool(process.cwd());
    expect(tool.name).toBe("powershell");
    expect(tool.execute).toBeTypeOf("function");
  });

  it("powershell tool executes commands via operations and returns ToolResult", async () => {
    const mockExec = vi.fn().mockImplementation(async (_command, _cwd, options) => {
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
    const textBlock = result.content.find(c => c.type === "text");
    expect(textBlock?.text).toContain("Directory: C:\\project");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("dir"),
      process.cwd(),
      expect.anything(),
    );
  });

  it("handles git status execution in PowerShell", async () => {
    const mockExec = vi.fn().mockImplementation(async (_command, _cwd, options) => {
      options.onData?.(Buffer.from("On branch main\nnothing to commit, working tree clean\n"));
      return { exitCode: 0 };
    });

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    const result = await tool.execute("call-2", { command: "git status" });
    expect(result).toBeDefined();
    const text = result.content.find(block => block.type === "text")?.text;
    expect(text).toContain("On branch main");
    expect(text).toContain("working tree clean");
  });
});

describe("PowerShell execution edge cases", () => {
  it("captures non-zero exit code and throws error with output", async () => {
    const mockExec = vi.fn().mockImplementation(async (_cmd, _cwd, options) => {
      options.onData?.(Buffer.from("Get-Item: Cannot find path 'C:\\invalid' because it does not exist.\n"));
      return { exitCode: 1 };
    });

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    await expect(tool.execute("call-err", { command: "Get-Item C:\\invalid" })).rejects.toThrow(
      /Cannot find path 'C:\\invalid'/,
    );
  });

  it("handles operations.exec throwing an unexpected rejection", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("Process spawn failed: EPERM"));

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    await expect(tool.execute("call-fail", { command: "dir" })).rejects.toThrow("Process spawn failed: EPERM");
  });

  it("executes multi-line PowerShell commands with UTF-8 outputs", async () => {
    const multiLineScript = "$items = @('alpha', 'beta', '测试');\n$items | ForEach-Object { Write-Output $_ }";
    const mockExec = vi.fn().mockImplementation(async (_cmd, _cwd, options) => {
      options.onData?.(Buffer.from("alpha\nbeta\n测试\n"));
      return { exitCode: 0 };
    });

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    const result = await tool.execute("call-utf8", { command: multiLineScript });
    const text = result.content.find(block => block.type === "text")?.text;
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("测试");
  });
});
