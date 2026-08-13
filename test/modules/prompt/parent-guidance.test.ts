import { describe, expect, it } from "vitest";
import { createParentGuidance } from "../../../src/modules/prompt/public.js";

describe("REQ-MODEL-006 parent guidance use case", () => {
  it("reads agents from the catalogue port and assembles guidance", () => {
    const guidance = createParentGuidance({
      catalogue: {
        listAgents: () => [{ name: "Explore", description: "Fast exploration" }],
      },
    });
    const result = guidance.assemble({
      parentModelKey: "anthropic/sonnet",
      parentThinkingLevel: "medium",
      parentSupportedLevels: ["off", "medium", "high"],
      parentFallbackLevel: "high",
      parentScopedThinkingLevel: null,
      routing: {
        enabled: false,
        enabledProviders: [],
        agentAccess: { Explore: { providers: {} } },
      },
      availableModels: [],
      scopedKeys: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.guidance).toContain("Explore: Fast exploration");
      expect(result.guidance).toContain("parent default: anthropic/sonnet");
    }
  });
});
