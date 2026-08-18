import { describe, expect, it } from "vitest";
import { createModelAccessSettingsOwner } from "../../src/bootstrap/model-access.js";
import { resolveThinkingAccess, type ModelAccessFragment } from "../../src/modules/model-access/public.js";
import type { ConfigSectionIO } from "../../src/bootstrap/configuration.js";

function model(reasoning: boolean) {
  return {
    id: "gpt",
    name: "GPT",
    api: "openai-responses",
    provider: "openai",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function ownerFor(fragment: ModelAccessFragment) {
  const currentModel = model(false);
  const io: ConfigSectionIO = {
    reload: () => "loaded",
    read: () => fragment,
    commit: () => ({ ok: true }),
  };
  return createModelAccessSettingsOwner({
    model: currentModel,
    thinkingLevel: "off",
    scopedModels: [],
    modelRegistry: {
      getAll: () => [currentModel],
      getAvailable: () => [currentModel],
      getError: () => undefined,
    },
  } as never, () => ["general-purpose"], { io });
}

describe("model-access settings projection", () => {
  it("projects the same null effective policy as runtime when capability changes", () => {
    const fragment: ModelAccessFragment = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        "general-purpose": {
          providers: {},
          thinking: { "openai/gpt": { allowed: ["off", "high"], default: "high" } },
        },
      },
    };
    const runtimePolicy = resolveThinkingAccess({
      routing: fragment,
      agentType: "general-purpose",
      modelKey: "openai/gpt",
      parentModelKey: "openai/gpt",
      parentThinkingLevel: "off",
      scopedThinkingLevel: undefined,
      supportedLevels: ["off"],
      fallbackLevel: "off",
    });
    expect(runtimePolicy).toBeNull();

    expect(ownerFor(fragment).thinking("general-purpose", "openai/gpt")).toEqual({
      levels: [{ level: "off", allowed: false, isDefault: false }],
    });
  });
});
