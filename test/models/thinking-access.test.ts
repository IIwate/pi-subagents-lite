import { describe, expect, it } from "vitest";
import {
  resolveThinkingAccess,
  selectThinkingLevel,
  type ThinkingAccessOverride,
  type ThinkingLevel,
} from "../../src/modules/model-access/public.js";

const reasoningLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveThinkingAccess({
    modelKey: "openai/gpt-5",
    parentModelKey: "anthropic/sonnet",
    parentThinkingLevel: "medium",
    scopedThinkingLevel: undefined,
    supportedLevels: reasoningLevels,
    fallbackLevel: "high",
    override: undefined,
    ...overrides,
  });
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
    const override: ThinkingAccessOverride = { allowed: ["low", "high"], default: "low" };
    expect(resolve({ override })).toEqual({
      allowed: ["low", "high"],
      default: "low",
      source: "override",
    });
    expect(resolve({
      override,
      parentModelKey: "openai/gpt-5",
    })).toEqual({
      allowed: ["low", "high"],
      default: "low",
      source: "override",
    });
  });

  it("lets a Model scope pin replace the saved policy", () => {
    expect(resolve({
      override: { allowed: ["low", "high"], default: "low" },
      scopedThinkingLevel: "xhigh",
    })).toEqual({
      allowed: ["xhigh"],
      default: "xhigh",
      source: "scope",
    });
  });

  it("suspends a model when its saved override has no valid allowed/default combination", () => {
    expect(resolve({ override: { allowed: ["max"], default: "max" } })).toBeNull();
    expect(resolve({ override: { allowed: ["low", "max"], default: "max" } })).toBeNull();
  });

  it("uses off as the only baseline for a non-reasoning model", () => {
    expect(resolve({ supportedLevels: ["off"], fallbackLevel: "off" })).toEqual({
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
