import { describe, expect, it } from "vitest";
import {
  resolveThinkingAccess,
  selectThinkingLevel,
} from "../../src/models/thinking-access.ts";
import type { AgentModelAccess } from "../../src/config/types.ts";

const reasoningModel = {
  provider: "openai",
  id: "gpt-5",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: null },
} as any;

function access(overrides: Partial<AgentModelAccess> = {}): AgentModelAccess {
  return {
    providers: {},
    ...overrides,
  };
}

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveThinkingAccess({
    agentAccess: access(),
    model: reasoningModel,
    modelKey: "openai/gpt-5",
    parentModelKey: "anthropic/sonnet",
    parentThinkingLevel: "medium",
    scopedThinkingLevel: undefined,
    ...overrides,
  } as any);
}

describe("resolveThinkingAccess", () => {
  it("allows every model-supported level and defaults alternates from high", () => {
    expect(resolve()).toEqual({
      allowed: ["off", "minimal", "low", "medium", "high", "xhigh"],
      default: "high",
      source: "baseline",
    });
  });

  it("inherits the parent session thinking for the exact Parent default", () => {
    expect(resolve({
      modelKey: "openai/gpt-5",
      parentModelKey: "openai/gpt-5",
      parentThinkingLevel: "medium",
    })).toEqual({
      allowed: ["off", "minimal", "low", "medium", "high", "xhigh"],
      default: "medium",
      source: "baseline",
    });
  });

  it("uses the exact Agent/model override across parent and alternate roles", () => {
    const agentAccess = access({
      thinking: {
        "openai/gpt-5": { allowed: ["low", "high"], default: "low" },
      },
    });
    expect(resolve({ agentAccess })).toEqual({
      allowed: ["low", "high"],
      default: "low",
      source: "override",
    });
    expect(resolve({
      agentAccess,
      parentModelKey: "openai/gpt-5",
    })).toEqual({
      allowed: ["low", "high"],
      default: "low",
      source: "override",
    });
  });

  it("lets a Model scope pin replace the saved policy", () => {
    const agentAccess = access({
      thinking: {
        "openai/gpt-5": { allowed: ["low", "high"], default: "low" },
      },
    });
    expect(resolve({ agentAccess, scopedThinkingLevel: "xhigh" })).toEqual({
      allowed: ["xhigh"],
      default: "xhigh",
      source: "scope",
    });
  });

  it("suspends a model when its saved override has no valid allowed/default combination", () => {
    const agentAccess = access({
      thinking: {
        "openai/gpt-5": { allowed: ["max"], default: "max" },
      },
    });
    expect(resolve({ agentAccess })).toBeNull();

    const unsupportedDefault = access({
      thinking: {
        "openai/gpt-5": { allowed: ["low", "max"], default: "max" },
      },
    });
    expect(resolve({ agentAccess: unsupportedDefault })).toBeNull();
  });

  it("uses off as the only baseline for a non-reasoning model", () => {
    expect(resolve({ model: { provider: "openai", id: "plain", reasoning: false } })).toEqual({
      allowed: ["off"],
      default: "off",
      source: "baseline",
    });
  });
});

describe("selectThinkingLevel", () => {
  const policy = {
    allowed: ["low", "medium", "high"],
    default: "medium",
    source: "override",
  } as const;

  it("uses the policy default when thinking is omitted", () => {
    expect(selectThinkingLevel(policy, undefined)).toEqual({ ok: true, level: "medium" });
  });

  it("accepts an explicitly allowed canonical level", () => {
    expect(selectThinkingLevel(policy, "high")).toEqual({ ok: true, level: "high" });
  });

  it("rejects disallowed and non-canonical values without replacement", () => {
    expect(selectThinkingLevel(policy, "xhigh")).toEqual({
      ok: false,
      reason: "thinking-denied",
      allowed: ["low", "medium", "high"],
    });
    expect(selectThinkingLevel(policy, "provider-custom")).toEqual({
      ok: false,
      reason: "thinking-denied",
      allowed: ["low", "medium", "high"],
    });
  });
});
