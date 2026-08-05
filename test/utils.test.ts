import { describe, it, expect } from "vitest";
import {
  isUnsafeName,
  parseModelKey,
  parseModelSpec,
  parseThinkingLevel,
  resolveExactModel,
  unknownModelError,
} from "../src/utils.ts";

/* ------------------------------------------------------------------ */
/*  isUnsafeName                                                      */
/* ------------------------------------------------------------------ */

describe("isUnsafeName", () => {
  it("allows simple alphanumeric names", () => {
    expect(isUnsafeName("general-purpose")).toBe(false);
    expect(isUnsafeName("Explore")).toBe(false);
    expect(isUnsafeName("myAgent42")).toBe(false);
  });

  it("allows names with dots, hyphens, underscores", () => {
    expect(isUnsafeName("my.agent")).toBe(false);
    expect(isUnsafeName("code_review-v2")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(isUnsafeName(".hidden")).toBe(true);
  });

  it("rejects path traversal (../)", () => {
    expect(isUnsafeName("../etc")).toBe(true);
  });

  it("rejects path traversal (..\\\\)", () => {
    expect(isUnsafeName("..\\etc")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isUnsafeName("")).toBe(true);
  });

  it("rejects names longer than 128 characters", () => {
    expect(isUnsafeName("a".repeat(129))).toBe(true);
  });

  it("allows exactly 128 characters", () => {
    expect(isUnsafeName("a".repeat(128))).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isUnsafeName("my agent")).toBe(true);
  });

  it("rejects names with slashes", () => {
    expect(isUnsafeName("a/b")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  parseModelKey / resolveExactModel                                 */
/* ------------------------------------------------------------------ */

describe("parseModelKey", () => {
  it("parses provider/model-id", () => {
    expect(parseModelKey("cpa-responses/grok-4.5")).toEqual({
      provider: "cpa-responses",
      modelId: "grok-4.5",
    });
  });

  it("returns null for bare model id", () => {
    expect(parseModelKey("grok-4.5")).toBeNull();
  });
});

describe("parseModelSpec", () => {
  it("parses bare model id", () => {
    expect(parseModelSpec("grok-4.5")).toEqual({ modelRef: "grok-4.5" });
  });

  it("parses provider/model-id", () => {
    expect(parseModelSpec("cpa-responses/grok-4.5")).toEqual({
      modelRef: "cpa-responses/grok-4.5",
    });
  });

  it("parses model:thinking shorthand", () => {
    expect(parseModelSpec("grok-4.5:low")).toEqual({
      modelRef: "grok-4.5",
      thinkingFromModel: "low",
    });
  });

  it("parses provider/model:thinking shorthand", () => {
    expect(parseModelSpec("cpa-responses/grok-4.5:high")).toEqual({
      modelRef: "cpa-responses/grok-4.5",
      thinkingFromModel: "high",
    });
  });

  it("accepts free-form thinking suffix not in the known list", () => {
    expect(parseModelSpec("grok-4.5:custom-level")).toEqual({
      modelRef: "grok-4.5",
      thinkingFromModel: "custom-level",
    });
  });

  it("does not split when thinking suffix is empty", () => {
    expect(parseModelSpec("grok-4.5:")).toEqual({ modelRef: "grok-4.5:" });
  });

  it("returns undefined modelRef for empty input", () => {
    expect(parseModelSpec(undefined)).toEqual({ modelRef: undefined });
    expect(parseModelSpec("  ")).toEqual({ modelRef: undefined });
  });
});

describe("parseThinkingLevel", () => {
  it("accepts known levels", () => {
    expect(parseThinkingLevel("low")).toBe("low");
    expect(parseThinkingLevel("xhigh")).toBe("xhigh");
    expect(parseThinkingLevel("max")).toBe("max");
  });

  it("accepts free-form levels", () => {
    expect(parseThinkingLevel("custom-level")).toBe("custom-level");
  });

  it("rejects empty / whitespace", () => {
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel("   ")).toBeUndefined();
  });
});

describe("resolveExactModel", () => {
  const parent = { provider: "test", id: "parent-model" };
  const grok = { provider: "cpa-responses", id: "grok-4.5" };

  const registry = {
    find: (provider: string, modelId: string) => {
      if (provider === "cpa-responses" && modelId === "grok-4.5") return grok;
      if (provider === "test" && modelId === "parent-model") return parent;
      return undefined;
    },
    getAvailable: () => [grok, parent],
  };

  it("resolves provider/model-id via find", () => {
    expect(resolveExactModel("cpa-responses/grok-4.5", registry)).toBe(grok);
  });

  it("resolves bare model id with exact id match only", () => {
    expect(resolveExactModel("grok-4.5", registry)).toBe(grok);
  });

  it("returns undefined for unknown bare id (no silent fallback)", () => {
    expect(resolveExactModel("unknown-model", registry)).toBeUndefined();
  });

  it("returns undefined for unknown provider/id", () => {
    expect(resolveExactModel("cpa-responses/nope", registry)).toBeUndefined();
  });
});


describe("unknownModelError", () => {
  it("mentions the unknown id and list-models guidance", () => {
    const msg = unknownModelError("nope");
    expect(msg).toContain("nope");
    expect(msg).toContain("list-models");
  });
});
