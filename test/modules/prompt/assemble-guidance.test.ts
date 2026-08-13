import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AgentGuidanceRequestSchema,
  AgentGuidanceResultSchema,
  assembleAgentGuidance,
} from "../../../src/modules/prompt/public.js";

describe("REQ-MODEL-006 Agent guidance public seam", () => {
  it("marks model required when Parent access is denied and lists exact alternates", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "assemble-guidance",
      agents: [{
        name: "Explore",
        description: "Fast exploration",
        registeredTools: ["read"],
      }],
      parentModelKey: "anthropic/sonnet",
      parentThinkingLevel: "medium",
      parentSupportedLevels: ["off", "low", "medium", "high"],
      parentFallbackLevel: "high",
      parentScopedThinkingLevel: null,
      routing: {
        enabled: true,
        enabledProviders: ["openai"],
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { openai: { models: ["gpt-5"] } },
          },
        },
      },
      availableModels: [{
        key: "openai/gpt-5",
        supportedLevels: ["off", "low", "medium", "high"],
        fallbackLevel: "high",
        scopedThinkingLevel: null,
      }],
      scopedKeys: null,
    }));

    const result = assembleAgentGuidance(command);
    expect(Check(AgentGuidanceRequestSchema, command)).toBe(true);
    expect(Check(AgentGuidanceResultSchema, result)).toBe(true);
    expect(result).toEqual({
      ok: true,
      guidance: [
        "[Subagent access]",
        "",
        "Available agent types:",
        "- Explore: Fast exploration (tools: read; `model` is required)",
        "",
        "Agent tool rules:",
        "- Agents start with a fresh conversation.",
        "- For background work, set `run_in_background: true`; results are delivered automatically. Do not poll, sleep, or timeout-wait.",
        "- A background Agent error is final. Do not spawn a replacement unless the user explicitly asks to retry.",
        "- Prefer background for independent work; use foreground when the result gates the next parent action.",
        "- `worktree_path` must be the parent repository's main checkout or a linked worktree.",
        "- Omit `model` only when the chosen Agent type has an authorized parent default.",
        "- For an alternate, pass one exact model key listed below; do not invent or abbreviate model IDs.",
        "- Never silently replace a rejected model or Thinking level.",
        "",
        "Explore alternate models:",
        "- openai/gpt-5 (allowed: off, low, medium, high; default: high)",
      ].join("\n"),
    });
  });
});
