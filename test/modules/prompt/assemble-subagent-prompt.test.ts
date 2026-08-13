import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  SubagentPromptRequestSchema,
  SubagentPromptResultSchema,
  assembleSubagentPrompt,
} from "../../../src/modules/prompt/public.js";

describe("REQ-AGENT-001 Subagent system prompt public seam", () => {
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
      expect(result.prompt).toContain("You are a Pi, an expert coding sub-agent.");
      expect(result.prompt).toContain("Working directory: C:/project");
      expect(result.prompt).toContain("Branch: re");
      expect(result.prompt).toContain("<active_agent name=\"reviewer\"/>");
      expect(result.prompt).toContain("Review the diff.");
      expect(result.prompt).toContain("Follow the house style.");
      expect(result.prompt).toContain("<name>tdd</name>");
    }
  });
});
