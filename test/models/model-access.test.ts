import { describe, expect, it } from "vitest";
import {
  agentTypesForProvider,
  authorizeModel,
  effectiveAlternateModelKeys,
  unavailableModelRules,
} from "../../src/models/model-access.ts";
import type { ModelRoutingConfig } from "../../src/config/types.ts";

function routing(overrides: Partial<ModelRoutingConfig> = {}): ModelRoutingConfig {
  return {
    enabled: true,
    enabledProviders: ["openai", "anthropic"],
    agentAccess: {
      Explore: {
        providers: {
          openai: {},
          anthropic: { models: ["haiku"] },
        },
      },
    },
    ...overrides,
  };
}

function authorize(overrides: Record<string, unknown> = {}) {
  return authorizeModel({
    agentType: "Explore",
    modelKey: "openai/gpt-5",
    parentModelKey: "anthropic/sonnet",
    routing: routing(),
    availableKeys: new Set(["anthropic/sonnet", "anthropic/haiku", "openai/gpt-5", "openai/o3"]),
    scopedKeys: null,
    ...overrides,
  } as any);
}

describe("authorizeModel", () => {
  it("always allows the exact parent before routing and scope gates", () => {
    expect(authorize({
      modelKey: "anthropic/sonnet",
      routing: routing({ enabled: false, enabledProviders: [], agentAccess: {} }),
      availableKeys: new Set(),
      scopedKeys: new Set(["openai/gpt-5"]),
    })).toEqual({ ok: true });
  });

  it("rejects alternate models while routing is OFF", () => {
    expect(authorize({ routing: routing({ enabled: false }) })).toEqual({ ok: false, reason: "routing-disabled" });
  });

  it("requires the provider to be globally enabled", () => {
    expect(authorize({ routing: routing({ enabledProviders: ["anthropic"] }) }))
      .toEqual({ ok: false, reason: "provider-disabled" });
  });

  it("requires an Agent/provider rule", () => {
    expect(authorize({ agentType: "reviewer" }))
      .toEqual({ ok: false, reason: "agent-provider-denied" });
  });

  it("never treats inherited object keys as access rules", () => {
    expect(authorize({
      modelKey: "constructor/worker",
      routing: routing({
        enabledProviders: ["constructor"],
        agentAccess: { Explore: { providers: {} } },
      }),
      availableKeys: new Set(["constructor/worker"]),
    })).toEqual({ ok: false, reason: "agent-provider-denied" });
    expect(authorize({
      agentType: "constructor",
      routing: routing({ agentAccess: {} }),
    })).toEqual({ ok: false, reason: "agent-provider-denied" });
  });

  it("allows all-model rules", () => {
    expect(authorize()).toEqual({ ok: true });
    expect(authorize({ modelKey: "openai/o3" })).toEqual({ ok: true });
  });

  it("requires an exact ID for exact-model rules", () => {
    expect(authorize({ modelKey: "anthropic/haiku" })).toEqual({ ok: true });
    expect(authorize({ modelKey: "anthropic/opus" }))
      .toEqual({ ok: false, reason: "model-denied" });
  });

  it("rejects models absent from Pi availability", () => {
    expect(authorize({ availableKeys: new Set(["anthropic/sonnet"]) }))
      .toEqual({ ok: false, reason: "model-unavailable" });
  });

  it("requires alternate models to be in active scope", () => {
    expect(authorize({ scopedKeys: new Set(["anthropic/sonnet"]) }))
      .toEqual({ ok: false, reason: "out-of-scope" });
  });

  it("works without a parent when an explicit alternate is fully authorized", () => {
    expect(authorize({ parentModelKey: "" })).toEqual({ ok: true });
  });

  it("does not implicitly allow another model from the parent provider", () => {
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: routing({
        enabledProviders: ["openai"],
        agentAccess: { Explore: { providers: { openai: {} } } },
      }),
      availableKeys: new Set(["anthropic/sonnet", "anthropic/opus"]),
    })).toEqual({ ok: false, reason: "provider-disabled" });
  });
});

describe("effectiveAlternateModelKeys", () => {
  const available = new Set(["anthropic/sonnet", "anthropic/haiku", "openai/gpt-5", "openai/o3"]);

  it("expands all-model rules over available keys and removes the exact parent", () => {
    expect(effectiveAlternateModelKeys("Explore", routing(), available, null, "openai/gpt-5"))
      .toEqual(["anthropic/haiku", "openai/o3"]);
  });

  it("omits disabled, unavailable, and out-of-scope entries", () => {
    expect(effectiveAlternateModelKeys(
      "Explore",
      routing({ enabledProviders: ["anthropic"] }),
      available,
      new Set(["anthropic/sonnet"]),
      "anthropic/sonnet",
    )).toEqual([]);
  });
});

describe("provider rule maintenance", () => {
  const policy = routing({
    enabledProviders: ["openai"],
    agentAccess: {
      Explore: { providers: { openai: { models: ["gpt-5", "retired"] } } },
      reviewer: { providers: { openai: { models: ["retired"] } } },
      planner: { providers: { openai: {} } },
    },
  });

  it("lists all saved Agent types for a provider", () => {
    expect(agentTypesForProvider(policy, "openai")).toEqual(["Explore", "planner", "reviewer"]);
  });

  it("finds only missing exact IDs in a reliable present provider registry", () => {
    expect(unavailableModelRules(policy, "openai", new Set(["gpt-5", "o3"]), true, true)).toEqual({
      Explore: ["retired"],
      reviewer: ["retired"],
    });
  });

  it("does not produce cleanup candidates for disabled or unreliable providers", () => {
    expect(unavailableModelRules(
      { ...policy, enabledProviders: [] }, "openai", new Set(), true, true,
    )).toEqual({});
    expect(unavailableModelRules(policy, "openai", new Set(), false, true)).toEqual({});
    expect(unavailableModelRules(policy, "openai", new Set(), true, false)).toEqual({});
  });
});
