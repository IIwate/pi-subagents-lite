import { describe, expect, it } from "vitest";
import { buildCurrentAgentGuidance } from "../../src/prompt/agent-guidance.ts";

const agents = [
  { name: "reviewer", description: "Focused review" },
  { name: "Explore", description: "Fast exploration", registeredTools: ["grep", "read"] },
];

const parentModel = {
  provider: "anthropic",
  id: "sonnet",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: null },
};
const availableModels = [
  parentModel,
  { provider: "anthropic", id: "haiku", reasoning: true },
  { provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } },
  { provider: "openai", id: "o3", reasoning: true },
  { provider: "google", id: "gemini-pro", reasoning: false },
] as any[];

function build(overrides: Record<string, unknown> = {}): string {
  return buildCurrentAgentGuidance({
    agents,
    parentModel,
    parentThinkingLevel: "medium",
    routing: {
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        Explore: {
          parentModelAccess: false,
          providers: {
            openai: {},
            google: { models: ["gemini-pro", "missing"] },
          },
        },
      },
    },
    availableModels,
    scopedModels: [
      { model: parentModel },
      { model: availableModels[2] },
      { model: availableModels[4] },
    ],
    ...overrides,
  } as any);
}

describe("buildCurrentAgentGuidance", () => {
  it("is deterministic and sorts callable Agent types", () => {
    const first = build();
    expect(build()).toBe(first);
    expect(first.indexOf("Explore: Fast exploration")).toBeLessThan(first.indexOf("reviewer: Focused review"));
  });

  it("includes critical tool rules and distinguishes Parent access", () => {
    const guidance = build();
    expect(guidance).toContain("[Subagent access]");
    expect(guidance).toContain("run_in_background: true");
    expect(guidance).toContain("Do not poll");
    expect(guidance).toContain("worktree_path");
    expect(guidance).toContain("anthropic/sonnet");
    expect(guidance).toContain("reviewer");
    expect(guidance).toContain("parent default");
    expect(guidance).toContain("medium");
    expect(guidance).toContain("Explore");
    expect(guidance).toContain("`model` is required");
  });

  it("advertises exact alternates with effective thinking summaries", () => {
    const guidance = build();
    expect(guidance).toContain("Explore alternate models:");
    expect(guidance).toContain("openai/gpt-5");
    expect(guidance).toContain("google/gemini-pro");
    expect(guidance).toContain("default: high");
    expect(guidance).toContain("default: off");
    expect(guidance).not.toContain("openai/*");
    expect(guidance).not.toContain("openai/o3");
    expect(guidance).not.toContain("google/missing");
  });

  it("shows unavailable Agent types when no authorized model exists", () => {
    const guidance = build({
      routing: {
        enabled: false,
        enabledProviders: [],
        agentAccess: {
          Explore: { parentModelAccess: false, providers: {} },
          reviewer: { parentModelAccess: false, providers: {} },
        },
      },
    });
    expect(guidance).toContain("Unavailable agent types:");
    expect(guidance).toContain("Explore: no authorized model");
    expect(guidance).toContain("reviewer: no authorized model");
    expect(guidance).not.toContain("Model routing is OFF. Other models are not authorized.");
  });

  it("retains callable alternates without an active Parent default", () => {
    const guidance = build({ parentModel: undefined, parentThinkingLevel: undefined });
    expect(guidance).toContain("Explore");
    expect(guidance).toContain("openai/gpt-5");
    expect(guidance).toContain("reviewer: no authorized model");
  });

  it("does not advertise current-parent-provider alternates without explicit Provider access", () => {
    const guidance = build({
      routing: {
        enabled: true,
        enabledProviders: [],
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { anthropic: { models: ["haiku"] } },
          },
        },
      },
      scopedModels: [],
    });
    expect(guidance).not.toContain("anthropic/haiku");
    expect(guidance).toContain("Explore: no authorized model");
  });

  it("shows a scope-pinned thinking level as the only allowed/default level", () => {
    const guidance = build({
      scopedModels: [
        { model: parentModel },
        { model: availableModels[2], thinkingLevel: "medium" },
      ],
    });
    const modelLine = guidance.split("\n").find((line) => line.includes("openai/gpt-5"));
    expect(modelLine).toContain("allowed: medium");
    expect(modelLine).toContain("default: medium");
    expect(modelLine).not.toContain("high,");
  });

  it("omits a model whose saved thinking override is no longer valid", () => {
    const guidance = build({
      routing: {
        enabled: true,
        enabledProviders: ["openai"],
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { openai: { models: ["gpt-5"] } },
            thinking: {
              "openai/gpt-5": { allowed: ["max"], default: "max" },
            },
          },
        },
      },
      scopedModels: [],
    });
    expect(guidance).not.toContain("- openai/gpt-5");
    expect(guidance).toContain("Explore: no authorized model");
  });
});
