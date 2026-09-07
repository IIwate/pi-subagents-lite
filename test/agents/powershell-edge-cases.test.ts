/**
 * powershell-edge-cases.test.ts — Edge case testing for PowerShell and defaultTools inheritance.
 *
 * Verifies:
 *   - defaultTools duplicates, empty list, and Agent tool injection defense
 *   - Frontmatter policy conflicts (tools vs excludeTools, tools: false, tools: true)
 *   - Explore read-only agent adaptation under edge configurations
 *   - Error handling and non-zero exit codes in PowerShell operations
 *   - UI command formatting edge cases
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import {
  resolveDefaultRegisteredTools,
  adaptExploreRegisteredTools,
  resolveVisibleTools,
  resolveSessionAllowedTools,
  resolveAcceptedRunPolicy,
  registerAgents,
  DEFAULT_FALLBACK_TOOLS,
  EXCLUDED_TOOL_NAMES,
} from "../../src/agents/agent-types.js";
import { summarizeToolArgs } from "../../src/ui/format.js";
import type { AgentConfig } from "../../src/agents/types.js";

describe("defaultTools edge cases & sanitization", () => {
  beforeEach(() => {
    registerAgents(new Map(), { disableDefaultAgents: false });
  });
  it("deduplicates redundant tool names in defaultTools", () => {
    const input = ["read", "powershell", "powershell", "edit", "read"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).toEqual(["read", "powershell", "edit"]);
  });

  it("strictly filters Agent tool even if maliciously or mistakenly included in defaultTools", () => {
    const input = ["read", "powershell", "Agent", "edit"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).not.toContain("Agent");
    expect(result).toEqual(["read", "powershell", "edit"]);
  });

  it("falls back to platform defaults when defaultTools only contains excluded tools", () => {
    const input = ["Agent"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).not.toContain("Agent");
    if (process.platform !== "win32") {
      expect(result).toEqual(DEFAULT_FALLBACK_TOOLS);
    }
  });

  it("falls back to platform defaults when defaultTools is an empty array", () => {
    const result = resolveDefaultRegisteredTools([]);
    if (process.platform !== "win32") {
      expect(result).toEqual(DEFAULT_FALLBACK_TOOLS);
    }
  });

  it("handles defaultTools with extension tool syntax", () => {
    const input = ["read", "tavily/web_search", "powershell"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).toEqual(["read", "tavily/web_search", "powershell"]);
  });
});

describe("Frontmatter policy conflicts & resolution order", () => {
  it("tools whitelist wins over excludeTools when both are specified", () => {
    // tools has "powershell", excludeTools has "powershell"
    // Rule: tools wins over excludeTools
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "edit"],
      tools: ["powershell", "read"],
      excludeTools: ["powershell"],
    });
    expect(result).toEqual(["powershell", "read"]);
  });

  it("tools: false strictly yields an empty tool list regardless of defaultTools", () => {
    const policy = resolveAcceptedRunPolicy("general-purpose", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: ["read", "powershell", "edit"],
    })!;

    const sessionTools = resolveSessionAllowedTools({
      registeredTools: policy.registeredTools,
      restrictToRegisteredTools: policy.restrictToRegisteredTools,
      tools: false,
    });
    expect(sessionTools).toEqual([]);

    const visibleTools = resolveVisibleTools({
      activeTools: ["read", "powershell"],
      tools: false,
    });
    expect(visibleTools).toEqual([]);
  });

  it("tools: true preserves active tools while stripping excluded tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "Agent"],
      tools: true,
    });
    expect(result).toEqual(["read", "powershell"]);
    expect(result).not.toContain("Agent");
  });

  it("excludeTools: ['bash'] removes bash from active list containing powershell", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "powershell", "edit"],
      excludeTools: ["bash"],
    });
    expect(result).toEqual(["read", "powershell", "edit"]);
    expect(result).not.toContain("bash");
  });
});

describe("Explore agent adaptation edge cases", () => {
  it("does not mutate user-defined Explore agent (source !== undefined)", () => {
    const customExplore: AgentConfig = {
      name: "Explore",
      displayName: "Custom Explore",
      description: "Custom user explore agent",
      registeredTools: ["read", "find"],
      source: "project",
      systemPrompt: "custom prompt",
    };
    registerAgents(new Map([["Explore", customExplore]]), { disableDefaultAgents: true });

    const policy = resolveAcceptedRunPolicy("Explore", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: ["powershell"],
    })!;

    expect(policy).toBeDefined();
    // User's explicit registeredTools ["read", "find"] should be preserved intact
    expect(policy.registeredTools).toEqual(["read", "find"]);
    expect(policy.registeredTools).not.toContain("powershell");
  });

  it("adaptExploreRegisteredTools handles tools list already containing powershell", () => {
    const tools = ["read", "powershell", "grep", "find"];
    const adapted = adaptExploreRegisteredTools(tools, ["powershell"]);
    expect(adapted).toEqual(["read", "powershell", "grep", "find"]);
  });

  it("adaptExploreRegisteredTools handles tools without read", () => {
    const tools = ["bash", "grep", "find"];
    const adapted = adaptExploreRegisteredTools(tools, ["powershell"]);
    expect(adapted).toContain("powershell");
    expect(adapted).toContain("read");
    expect(adapted).not.toContain("bash");
  });
});

describe("PowerShell execution edge cases", () => {
  it("captures non-zero exit code and throws error with output", async () => {
    const mockExec = vi.fn().mockImplementation(async (cmd, cwd, options) => {
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
    const mockExec = vi.fn().mockImplementation(async (cmd, cwd, options) => {
      options.onData?.(Buffer.from("alpha\nbeta\n测试\n"));
      return { exitCode: 0 };
    });

    const tool = createPowerShellTool(process.cwd(), {
      operations: { exec: mockExec },
    });

    const result = await tool.execute("call-utf8", { command: multiLineScript });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text;
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("测试");
  });
});

describe("UI tool arguments summarizer edge cases (summarizeToolArgs)", () => {
  it("formats normal PowerShell command", () => {
    const summary = summarizeToolArgs("powershell", { command: "Get-Process -Name node" });
    expect(summary).toBe('("Get-Process -Name node")');
  });

  it("truncates long PowerShell command beyond MAX_COMMAND_DISPLAY_LENGTH (100 chars)", () => {
    const longCommand = "Write-Output " + "A".repeat(120);
    const summary = summarizeToolArgs("powershell", { command: longCommand });
    expect(summary.length).toBeLessThanOrEqual(106);
    expect(summary).toContain("…");
  });

  it("handles powershell call with empty, non-string or missing command argument safely", () => {
    expect(summarizeToolArgs("powershell", {})).toBe("");
    expect(summarizeToolArgs("powershell", undefined)).toBe("");
    expect(summarizeToolArgs("powershell", { command: null as any })).toBe('("")');
    expect(summarizeToolArgs("powershell", { command: 12345 as any })).toBe('("")');
  });
});
