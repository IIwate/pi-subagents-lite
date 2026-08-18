import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  SubagentPromptRequestSchema,
  SubagentPromptResultSchema,
  assembleSubagentPrompt,
} from "../../../src/modules/prompt/public.js";

// Prompt assembly is one input to REQ-AGENT-001; the requirement's acceptance
// examples live where a spawn is accepted or refused (`test/bootstrap/agent-tool.test.ts`)
// and where a prompt source is unavailable (`test/agents/agent-runner.test.ts`).
describe("Subagent system prompt public seam", () => {
  it("assembles a replace-mode prompt from serializable fragments", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "assemble-subagent-prompt",
      mode: "replace",
      agentName: "reviewer",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: true, branch: "re", platform: "win32" },
      header: null,
      contextFiles: [{ path: "C:/project/AGENTS.md", content: "Follow the house style." }],
      skillElements: ["<skill><name>tdd</name><description>Test first</description></skill>"],
    }));

    const result = assembleSubagentPrompt(command);
    expect(Check(SubagentPromptRequestSchema, command)).toBe(true);
    expect(Check(SubagentPromptResultSchema, result)).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(assembleSubagentPrompt(command)).toEqual(result);
      expect(result.prompt).toContain("You are a Pi, an expert coding sub-agent.");
      expect(result.prompt).toContain("Working directory: C:/project");
      expect(result.prompt).toContain("Branch: re");
      expect(result.prompt).toContain("<active_agent name=\"reviewer\"/>");
      expect(result.prompt).toContain("Review the diff.");
      expect(result.prompt).toContain("Follow the house style.");
      expect(result.prompt).toContain("<name>tdd</name>");
      expect(result.prompt).toContain("<available_skills>");
      expect(result.prompt).toContain("The following skills provide specialized instructions");
    }
  });

  it("strips parent scaffolding in inherit mode and keeps agent instructions", () => {
    const result = assembleSubagentPrompt({
      kind: "assemble-subagent-prompt",
      mode: "inherit",
      agentName: "reviewer",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: false, branch: null, platform: "linux" },
      header: "Parent identity\nCurrent date: 2026-01-01\nCurrent working directory: /tmp\n",
      contextFiles: [],
      skillElements: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain("Parent identity");
      expect(result.prompt).not.toContain("Current date:");
      expect(result.prompt).toContain("Review the diff.");
      expect(result.prompt).not.toContain("You are a Pi, an expert coding sub-agent.");
    }
  });

  it("encodes XML attributes for context paths and active Agent names", () => {
    const result = assembleSubagentPrompt({
      kind: "assemble-subagent-prompt",
      mode: "replace",
      agentName: "name&<>\"",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: false, branch: null, platform: "win32" },
      header: null,
      contextFiles: [{ path: "C:/a&b<\"q\">", content: "Context." }],
      skillElements: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain(
        '<project_instructions path="C:/a&amp;b&lt;&quot;q&quot;&gt;">',
      );
      expect(result.prompt).toContain('<active_agent name="name&amp;&lt;&gt;&quot;"/>');
    }
  });

  it("uses the custom header and strips leftover project and skill scaffolding", () => {
    const result = assembleSubagentPrompt({
      kind: "assemble-subagent-prompt",
      mode: "custom",
      agentName: "reviewer",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: false, branch: null, platform: "linux" },
      header: [
        "Custom header",
        "<project_context>old context</project_context>",
        "<available_skills><skill><name>old</name></skill></available_skills>",
      ].join("\n"),
      contextFiles: [],
      skillElements: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain("Custom header");
      expect(result.prompt).toContain("Not a git repository");
      expect(result.prompt).not.toContain("old context");
      expect(result.prompt).not.toContain("<name>old</name>");
    }
  });

  it("ignores a header in replace mode", () => {
    const result = assembleSubagentPrompt({
      kind: "assemble-subagent-prompt",
      mode: "replace",
      agentName: "reviewer",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: false, branch: null, platform: "linux" },
      header: "Should not appear",
      contextFiles: [],
      skillElements: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain("You are a Pi, an expert coding sub-agent.");
      expect(result.prompt).not.toContain("Should not appear");
    }
  });

  it("rejects a malformed Subagent prompt command", () => {
    const result = assembleSubagentPrompt({ kind: "assemble-subagent-prompt" });
    expect(Check(SubagentPromptResultSchema, result)).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Subagent prompt command is invalid." },
    });
  });

  it("fails inherit mode when the header is missing, empty, or whitespace-only", () => {
    for (const header of [null, "", "   \n\t"]) {
      const result = assembleSubagentPrompt({
        kind: "assemble-subagent-prompt",
        mode: "inherit",
        agentName: "reviewer",
        agentInstructions: "Review the diff.",
        cwd: "C:/project",
        env: { isGitRepo: false, branch: null, platform: "linux" },
        header,
        contextFiles: [],
        skillElements: [],
      });
      expect(Check(SubagentPromptResultSchema, result)).toBe(true);
      expect(result).toEqual({
        ok: false,
        error: { code: "invalid-command", message: "Inherited parent prompt is unavailable." },
      });
    }
  });

  it("fails inherit mode when stripping scaffolding leaves an empty header", () => {
    const result = assembleSubagentPrompt({
      kind: "assemble-subagent-prompt",
      mode: "inherit",
      agentName: "reviewer",
      agentInstructions: "Review the diff.",
      cwd: "C:/project",
      env: { isGitRepo: false, branch: null, platform: "linux" },
      header: "Current date: 2026-01-01\nCurrent working directory: /tmp\n",
      contextFiles: [],
      skillElements: [],
    });
    expect(Check(SubagentPromptResultSchema, result)).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Inherited parent prompt is unavailable." },
    });
  });
});
