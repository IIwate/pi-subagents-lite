import { describe, expect, it } from "vitest";
import { buildCurrentAgentGuidance } from "../../src/prompt/agent-guidance.ts";

const agents = [
  { name: "reviewer", description: "Focused review" },
  { name: "Explore", description: "Fast exploration", registeredTools: ["grep", "read"] },
];

function build(overrides: Record<string, unknown> = {}): string {
  return buildCurrentAgentGuidance({
    agents,
    parentModelKey: "anthropic/sonnet",
    routing: {
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        Explore: {
          providers: {
            openai: {},
            google: { models: ["gemini-pro", "missing"] },
          },
        },
      },
    },
    registryKeys: new Set(["anthropic/sonnet", "openai/gpt-5", "openai/o3", "google/gemini-pro"]),
    scopedKeys: new Set(["anthropic/sonnet", "openai/gpt-5", "google/gemini-pro"]),
    ...overrides,
  } as any);
}

describe("buildCurrentAgentGuidance", () => {
  it("is deterministic and sorts Agent types", () => {
    const first = build();
    expect(build()).toBe(first);
    expect(first.indexOf("Explore: Fast exploration")).toBeLessThan(first.indexOf("reviewer: Focused review"));
  });

  it("includes critical tool rules and the exact parent default", () => {
    const guidance = build();
    expect(guidance).toContain("[Subagent access]");
    expect(guidance).toContain("anthropic/sonnet");
    expect(guidance).toContain("run_in_background: true");
    expect(guidance).toContain("Do not poll");
    expect(guidance).toContain("worktree_path");
    expect(guidance).toContain("Never silently replace");
  });

  it("advertises all-model rules as wildcards and exact effective keys only", () => {
    const guidance = build();
    expect(guidance).toContain("openai/*");
    expect(guidance).toContain("google/gemini-pro");
    expect(guidance).not.toContain("openai/o3");
    expect(guidance).not.toContain("google/missing");
  });

  it("describes routing OFF without alternate access", () => {
    const guidance = build({
      routing: { enabled: false, enabledProviders: [], agentAccess: {} },
    });
    expect(guidance).toContain("Model routing is OFF");
    expect(guidance).not.toContain("alternate access:");
  });

  it("handles a missing parent while retaining explicit alternate guidance", () => {
    const guidance = build({ parentModelKey: "" });
    expect(guidance).toContain("No parent default is active");
    expect(guidance).toContain("openai/*");
  });
});
