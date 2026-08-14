import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  applyAgentProviderAccess,
  applyCleanUnavailableModels,
  applyClearModelAccess,
  applyDeleteProviderRules,
  applyParentModelAccess,
  applyProviderEnabled,
  applyQuickAgentProviderAccess,
  applyResetThinkingAccess,
  applyRoutingEnabled,
  applySelectedModelSnapshot,
  applyThinkingAccess,
  parseModelAccessFragment,
  snapshotVisibleSelectedModels,
} from "../../../src/modules/model-access/public.js";

const fresh = {
  enabled: false,
  enabledProviders: [] as string[],
  agentAccess: {},
};

describe("REQ-MODEL-003 and REQ-MODEL-007 fragment updates", () => {
  it("leaves Quick setup unchanged when the selected model set is empty", () => {
    const result = applyQuickAgentProviderAccess(fresh, "Explore", "anthropic", []);
    expect(Check(ModelAccessFragmentSchema, result)).toBe(true);
    expect(result).toEqual(fresh);
  });

  it("snapshots visible models when leaving All models", () => {
    const routing = applyQuickAgentProviderAccess(fresh, "Explore", "openai");
    const selected = snapshotVisibleSelectedModels(["gpt-5", "o3"]);
    const next = applySelectedModelSnapshot(routing, "Explore", "openai", selected);
    expect(Check(ModelAccessFragmentSchema, next)).toBe(true);
    expect(next.agentAccess.Explore.providers.openai).toEqual({ models: ["gpt-5", "o3"] });
  });

  it("stores and resets an exact Thinking override", () => {
    const withOverride = applyThinkingAccess(fresh, "Explore", "openai/gpt-5", ["low", "high"], "low");
    const reset = applyResetThinkingAccess(withOverride, "Explore", "openai/gpt-5");
    expect(Check(ModelAccessFragmentSchema, withOverride)).toBe(true);
    expect(withOverride.agentAccess.Explore.thinking).toEqual({
      "openai/gpt-5": { allowed: ["low", "high"], default: "low" },
    });
    expect(reset.agentAccess).toEqual({});
  });

  it("deletes one provider rule and cleans only unavailable exact IDs", () => {
    const routing = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        Explore: { providers: { openai: { models: ["gpt-5", "retired"] } } },
        reviewer: { providers: { openai: {} } },
      },
    };
    const cleaned = applyCleanUnavailableModels(routing, "openai", ["retired"]);
    const deleted = applyDeleteProviderRules(cleaned, "openai");
    expect(cleaned.agentAccess.Explore.providers.openai).toEqual({ models: ["gpt-5"] });
    expect(cleaned.agentAccess.reviewer.providers.openai).toEqual({});
    expect(deleted.agentAccess).toEqual({});
  });

  it("resets Model access to the fresh Parent-only fragment", () => {
    const result = applyClearModelAccess();
    expect(Check(ModelAccessFragmentSchema, result)).toBe(true);
    expect(result).toEqual(fresh);
  });

  it("rejects an off-contract fragment instead of copying it through", () => {
    const garbage = { enabled: true };
    expect(() => applyRoutingEnabled(garbage, true)).toThrow(TypeError);
    expect(() => applyProviderEnabled(garbage, "openai", true)).toThrow(TypeError);
    expect(() => applySelectedModelSnapshot(garbage, "Explore", "openai", ["gpt-5"])).toThrow(TypeError);
    expect(() => applyThinkingAccess(garbage, "Explore", "openai/gpt-5", ["low"], "low")).toThrow(TypeError);
    expect(() => applyResetThinkingAccess(garbage, "Explore", "openai/gpt-5")).toThrow(TypeError);
    expect(() => applyDeleteProviderRules(garbage, "openai")).toThrow(TypeError);
    expect(() => applyCleanUnavailableModels(garbage, "openai", ["retired"])).toThrow(TypeError);
    expect(() => applyParentModelAccess(garbage, "Explore", false)).toThrow(TypeError);
    expect(() => applyAgentProviderAccess(garbage, "Explore", "openai")).toThrow(TypeError);
    expect(() => applyQuickAgentProviderAccess(garbage, "Explore", "openai")).toThrow(TypeError);
    expect(Check(ModelAccessFragmentSchema, parseModelAccessFragment(garbage))).toBe(true);
    expect(Check(ModelAccessFragmentSchema, applyClearModelAccess())).toBe(true);
  });
});
