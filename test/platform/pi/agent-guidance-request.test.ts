/**
 * agent-guidance-request.test.ts — Pi session objects projected onto the
 * prompt module's guidance request.
 *
 * The adapter under test owns the translation only: thinking capability from
 * Pi's compat helpers, scope from ExtensionContext. Assertions run on the
 * assembled guidance because that is the observable result of a wrong
 * projection — a dropped alternate or a thinking level that never existed.
 */

import { describe, expect, it } from "vitest";
import { piGuidanceHost, piModelCapability } from "../../../src/platform/pi/agent-guidance-request.ts";
import { createParentGuidance } from "../../../src/modules/prompt/public.js";

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

const guidance = createParentGuidance({ catalogue: { listAgents: () => agents } });

function build(overrides: Record<string, unknown> = {}): string {
  const result = guidance.assemble(piGuidanceHost({
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
  } as any));
  if (!result.ok) throw new Error(`Guidance request rejected: ${result.error.message}`);
  return result.guidance;
}

describe("piModelCapability", () => {
  it("projects a Pi model onto the canonical capability shape", () => {
    expect(piModelCapability(availableModels[2], [])).toEqual({
      key: "openai/gpt-5",
      supportedLevels: expect.arrayContaining(["off", "high"]),
      fallbackLevel: "high",
      scopedThinkingLevel: null,
    });
  });

  it("reports the scope-pinned thinking level for a scoped model", () => {
    const capability = piModelCapability(availableModels[2], [
      { model: availableModels[2], thinkingLevel: "medium" },
    ] as any);
    expect(capability.scopedThinkingLevel).toBe("medium");
  });
});

describe("piGuidanceHost", () => {
  it("is deterministic and sorts callable Agent types", () => {
    const first = build();
    expect(build()).toBe(first);
    expect(first.indexOf("Explore: Fast exploration")).toBeLessThan(first.indexOf("reviewer: Focused review"));
  });

  it("includes critical tool rules and distinguishes Parent access", () => {
    const text = build();
    expect(text).toContain("[Subagent access]");
    expect(text).toContain("run_in_background: true");
    expect(text).toContain("Do not poll");
    expect(text).toContain("worktree_path");
    expect(text).toContain("anthropic/sonnet");
    expect(text).toContain("reviewer");
    expect(text).toContain("parent default");
    expect(text).toContain("medium");
    expect(text).toContain("Explore");
    expect(text).toContain("`model` is required");
  });

  it("advertises exact alternates with effective thinking summaries", () => {
    const text = build();
    expect(text).toContain("Explore alternate models:");
    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("google/gemini-pro");
    expect(text).toContain("default: high");
    expect(text).toContain("default: off");
    expect(text).not.toContain("openai/*");
    expect(text).not.toContain("openai/o3");
    expect(text).not.toContain("google/missing");
  });

  it("shows unavailable Agent types when no authorized model exists", () => {
    const text = build({
      routing: {
        enabled: false,
        enabledProviders: [],
        agentAccess: {
          Explore: { parentModelAccess: false, providers: {} },
          reviewer: { parentModelAccess: false, providers: {} },
        },
      },
    });
    expect(text).toContain("Unavailable agent types:");
    expect(text).toContain("Explore: no authorized model");
    expect(text).toContain("reviewer: no authorized model");
    expect(text).not.toContain("Model routing is OFF. Other models are not authorized.");
  });

  it("retains callable alternates without an active Parent default", () => {
    const text = build({ parentModel: undefined, parentThinkingLevel: undefined });
    expect(text).toContain("Explore");
    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("reviewer: no authorized model");
  });

  it("does not advertise current-parent-provider alternates without explicit Provider access", () => {
    const text = build({
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
    expect(text).not.toContain("anthropic/haiku");
    expect(text).toContain("Explore: no authorized model");
  });

  it("shows a scope-pinned thinking level as the only allowed/default level", () => {
    const text = build({
      scopedModels: [
        { model: parentModel },
        { model: availableModels[2], thinkingLevel: "medium" },
      ],
    });
    const modelLine = text.split("\n").find((line) => line.includes("openai/gpt-5"));
    expect(modelLine).toContain("allowed: medium");
    expect(modelLine).toContain("default: medium");
    expect(modelLine).not.toContain("high,");
  });

  it("omits a model whose saved thinking override is no longer valid", () => {
    const text = build({
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
    expect(text).not.toContain("- openai/gpt-5");
    expect(text).toContain("Explore: no authorized model");
  });
});
