import { describe, expect, it } from "vitest";
import {
  agentTypesForProvider,
  authorizeModelAccess,
  effectiveAlternateModelKeys,
  unavailableModelRules,
  type ModelAccessFragment,
} from "../../src/modules/model-access/public.js";

function routing(overrides: Partial<ModelAccessFragment> = {}): ModelAccessFragment {
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
  const availableKeys = overrides.availableKeys instanceof Set
    ? [...overrides.availableKeys as Set<string>]
    : ["anthropic/sonnet", "anthropic/haiku", "openai/gpt-5", "openai/o3"];
  const scopedKeys = overrides.scopedKeys instanceof Set
    ? [...overrides.scopedKeys as Set<string>]
    : overrides.scopedKeys === undefined
      ? null
      : overrides.scopedKeys;
  const { availableKeys: _a, scopedKeys: _s, ...rest } = overrides;
  return authorizeModelAccess({
    kind: "authorize",
    agentType: "Explore",
    modelKey: "openai/gpt-5",
    parentModelKey: "anthropic/sonnet",
    routing: routing(),
    availableKeys,
    scopedKeys,
    ...rest,
  });
}

describe("REQ-MODEL-002 alternate model authorization", () => {
  it("allows the exact parent when Parent model access is omitted", () => {
    expect(authorize({
      modelKey: "anthropic/sonnet",
      routing: routing({
        enabled: false,
        enabledProviders: [],
        agentAccess: { Explore: { providers: {} } },
      }),
      availableKeys: new Set(),
      scopedKeys: new Set(["openai/gpt-5"]),
    })).toEqual({ ok: true });
  });

  it("rejects the exact parent when Parent model access is denied", () => {
    expect(authorize({
      modelKey: "anthropic/sonnet",
      routing: routing({
        enabled: true,
        enabledProviders: ["anthropic"],
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { anthropic: { models: ["sonnet"] } },
          },
        },
      }),
    })).toEqual({ ok: false, reason: "parent-model-denied" });
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

  it("REQ-MODEL-004 requires alternate models to be in active scope", () => {
    expect(authorize({ scopedKeys: new Set(["anthropic/sonnet"]) }))
      .toEqual({ ok: false, reason: "out-of-scope" });
  });

  it("works without a parent when an explicit alternate is fully authorized", () => {
    expect(authorize({ parentModelKey: "" })).toEqual({ ok: true });
  });

  it("requires explicit Provider access for current-parent-provider alternates", () => {
    const parentProviderRule = routing({
      enabledProviders: [],
      agentAccess: { Explore: { providers: { anthropic: { models: ["opus"] } } } },
    });
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: parentProviderRule,
      availableKeys: new Set(["anthropic/sonnet", "anthropic/opus"]),
    })).toEqual({ ok: false, reason: "provider-disabled" });

    expect(authorize({
      modelKey: "anthropic/opus",
      routing: routing({
        enabledProviders: ["anthropic"],
        agentAccess: parentProviderRule.agentAccess,
      }),
      availableKeys: new Set(["anthropic/sonnet", "anthropic/opus"]),
    })).toEqual({ ok: true });
  });

  it("keeps every alternate-model gate for current-parent-provider alternates", () => {
    const parentProviderRule = routing({
      enabledProviders: ["anthropic"],
      agentAccess: { Explore: { providers: { anthropic: { models: ["opus"] } } } },
    });
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: { ...parentProviderRule, enabled: false },
    })).toEqual({ ok: false, reason: "routing-disabled" });
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: { ...parentProviderRule, agentAccess: {} },
    })).toEqual({ ok: false, reason: "agent-provider-denied" });
    expect(authorize({
      modelKey: "anthropic/haiku",
      routing: parentProviderRule,
    })).toEqual({ ok: false, reason: "model-denied" });
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: parentProviderRule,
      availableKeys: new Set(["anthropic/sonnet"]),
    })).toEqual({ ok: false, reason: "model-unavailable" });
    expect(authorize({
      modelKey: "anthropic/opus",
      routing: parentProviderRule,
      availableKeys: new Set(["anthropic/sonnet", "anthropic/opus"]),
      scopedKeys: new Set(["anthropic/sonnet"]),
    })).toEqual({ ok: false, reason: "out-of-scope" });
  });
});

describe("effectiveAlternateModelKeys", () => {
  const available = ["anthropic/sonnet", "anthropic/haiku", "openai/gpt-5", "openai/o3"];

  it("expands all-model rules over available keys and removes the exact parent", () => {
    expect(effectiveAlternateModelKeys("Explore", routing(), available, null, "openai/gpt-5"))
      .toEqual(["anthropic/haiku", "openai/o3"]);
  });

  it("omits disabled, unavailable, and out-of-scope entries", () => {
    expect(effectiveAlternateModelKeys(
      "Explore",
      routing({ enabledProviders: ["anthropic"] }),
      available,
      ["anthropic/sonnet"],
      "anthropic/sonnet",
    )).toEqual([]);
  });

  it("does not move Provider access when the parent changes", () => {
    const policy = routing({
      enabledProviders: [],
      agentAccess: {
        Explore: {
          providers: {
            anthropic: { models: ["haiku"] },
            openai: { models: ["o3"] },
          },
        },
      },
    });
    expect(effectiveAlternateModelKeys("Explore", policy, available, null, "anthropic/sonnet"))
      .toEqual([]);
    expect(effectiveAlternateModelKeys("Explore", policy, available, null, "openai/gpt-5"))
      .toEqual([]);

    const enabled = routing({ ...policy, enabledProviders: ["anthropic", "openai"] });
    expect(effectiveAlternateModelKeys("Explore", enabled, available, null, "anthropic/sonnet"))
      .toEqual(["anthropic/haiku", "openai/o3"]);
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

  it("preserves prototype-like Agent IDs as own cleanup entries", () => {
    const agentAccess: ModelAccessFragment["agentAccess"] = {};
    Object.defineProperty(agentAccess, "__proto__", {
      value: { providers: { openai: { models: ["retired"] } } },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = unavailableModelRules(
      routing({ enabledProviders: ["openai"], agentAccess }),
      "openai",
      new Set(),
      true,
      true,
    );
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual(["retired"]);
  });

  it("keeps cleanup independent of routing state but requires a reliable catalogue provider", () => {
    expect(unavailableModelRules(
      { ...policy, enabledProviders: [] }, "openai", new Set(["gpt-5"]), true, true,
    )).toEqual({ Explore: ["retired"], reviewer: ["retired"] });
    expect(unavailableModelRules(policy, "openai", new Set(), false, true)).toEqual({});
    expect(unavailableModelRules(policy, "openai", new Set(), true, false)).toEqual({});
  });
});
