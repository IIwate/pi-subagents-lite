import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  clampInheritedThinking,
  resolveThinkingLevel,
  validateExplicitThinking,
} from "../../../src/models/thinking-resolver.js";

function makeModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    provider: "test",
    id: "reasoning-model",
    name: "Reasoning model",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

describe("validateExplicitThinking", () => {
  it.each([
    ["High", "high"],
    [" LOW ", "low"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(validateExplicitThinking(input, makeModel())).toBe(expected);
  });

  it.each(["super-high", "ultra"])("rejects %s with the legal levels", level => {
    expect(() => validateExplicitThinking(level, makeModel())).toThrow(
      `Invalid thinking level "${level}". Valid levels: off, minimal, low, medium, high, xhigh, max.`,
    );
  });

  it("rejects reasoning on a non-reasoning model", () => {
    expect(() => validateExplicitThinking("low", makeModel({ reasoning: false }))).toThrow(
      'Model "reasoning-model" does not support reasoning.',
    );
  });

  it("accepts off on a non-reasoning model", () => {
    expect(validateExplicitThinking("off", makeModel({ reasoning: false }))).toBe("off");
  });

  it.each(["high", "off"] as const)("rejects an explicitly excluded %s level", level => {
    const model = makeModel({ thinkingLevelMap: { [level]: null } });
    expect(() => validateExplicitThinking(level, model)).toThrow(
      `Thinking level "${level}" is not supported by model "reasoning-model".`,
    );
  });

  it("honors an off exclusion even on a non-reasoning model", () => {
    const model = makeModel({ reasoning: false, thinkingLevelMap: { off: null } });
    expect(() => validateExplicitThinking("off", model)).toThrow(
      'Thinking level "off" is not supported by model "reasoning-model".',
    );
  });

  it.each(["xhigh", "max"])("requires model support for %s", level => {
    expect(() => validateExplicitThinking(level, makeModel())).toThrow(
      `Thinking level "${level}" is not supported by model "reasoning-model".`,
    );
  });

  it("keeps Pi levels in the snapshot when provider mappings use other values", () => {
    const model = makeModel({ thinkingLevelMap: { high: "enabled", max: "highest" } });
    expect(validateExplicitThinking("high", model)).toBe("high");
    expect(validateExplicitThinking("max", model)).toBe("max");
    expect(validateExplicitThinking("medium", model)).toBe("medium");
  });
});

describe("clampInheritedThinking", () => {
  it("drops inherited thinking for a non-reasoning model", () => {
    expect(clampInheritedThinking("high", makeModel({ reasoning: false }))).toBeUndefined();
  });

  it("clamps an unsupported level to the highest supported level", () => {
    const model = makeModel({ thinkingLevelMap: { high: null, xhigh: null, max: null } });
    expect(clampInheritedThinking("high", model)).toBe("medium");
    expect(clampInheritedThinking("low", model)).toBe("low");
  });

  it("uses the highest supported level across holes in the map", () => {
    const model = makeModel({ thinkingLevelMap: { low: null, max: "max" } });
    expect(clampInheritedThinking("low", model)).toBe("max");
  });

  it("aligns inherited off when the model requires reasoning", () => {
    expect(clampInheritedThinking("off", makeModel({ thinkingLevelMap: { off: null } }))).toBe("high");
  });

  it("uses provider defaults when extended levels are absent", () => {
    expect(clampInheritedThinking("max", makeModel())).toBe("high");
  });

  it("returns undefined when every level is excluded", () => {
    const model = makeModel({
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
    });
    expect(clampInheritedThinking("high", model)).toBeUndefined();
  });
});

describe("resolveThinkingLevel", () => {
  it.each(["", "   ", "\t\n"])("falls through blank values %j", blank => {
    const model = makeModel();
    expect(resolveThinkingLevel({ model, thinking: blank, agentThinking: "High" })).toBe("high");
    expect(resolveThinkingLevel({
      model,
      thinking: blank,
      agentThinking: blank,
      scopedThinking: blank,
      defaultThinking: "LOW",
    })).toBe("low");
    expect(resolveThinkingLevel({ model, thinking: blank })).toBeUndefined();
  });

  it("gives tool parameters precedence over frontmatter and inherited settings", () => {
    expect(resolveThinkingLevel({
      model: makeModel(),
      thinking: "low",
      agentThinking: "ultra",
      scopedThinking: "high",
      defaultThinking: "medium",
      parentThinking: "off",
    })).toBe("low");
  });

  it("gives frontmatter precedence over inherited settings", () => {
    expect(resolveThinkingLevel({
      model: makeModel(),
      agentThinking: "low",
      scopedThinking: "high",
      defaultThinking: "medium",
      parentThinking: "off",
    })).toBe("low");
  });

  it("validates frontmatter instead of hiding invalid intent behind scoped settings", () => {
    expect(() => resolveThinkingLevel({
      model: makeModel(),
      agentThinking: "ultra",
      scopedThinking: "high",
    })).toThrow("Valid levels: off, minimal, low, medium, high, xhigh, max.");
  });

  it("rejects unsupported frontmatter instead of clamping it", () => {
    expect(() => resolveThinkingLevel({
      model: makeModel({ reasoning: false }),
      agentThinking: "low",
    })).toThrow("does not support reasoning");
  });

  it("prefers scoped settings over global and parent settings", () => {
    expect(resolveThinkingLevel({
      model: makeModel(),
      scopedThinking: "low",
      defaultThinking: "medium",
      parentThinking: "high",
    })).toBe("low");
  });

  it("prefers global settings over parent settings", () => {
    expect(resolveThinkingLevel({
      model: makeModel(),
      defaultThinking: "medium",
      parentThinking: "high",
    })).toBe("medium");
  });

  it.each(["scopedThinking", "defaultThinking", "parentThinking"] as const)(
    "adapts %s to the target model",
    source => {
      expect(resolveThinkingLevel({ model: makeModel({ reasoning: false }), [source]: "high" })).toBeUndefined();
      expect(resolveThinkingLevel({
        model: makeModel({ thinkingLevelMap: { high: null, xhigh: null, max: null } }),
        [source]: "high",
      })).toBe("medium");
    },
  );

  it("inherits the parent level when no overrides are set", () => {
    expect(resolveThinkingLevel({ model: makeModel(), parentThinking: "high" })).toBe("high");
  });

  it("leaves thinking undefined when every source is absent", () => {
    expect(resolveThinkingLevel({ model: makeModel() })).toBeUndefined();
  });
});
