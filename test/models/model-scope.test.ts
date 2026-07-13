/**
 * model-scope.test.ts — Active Model scope helpers for subagent model constraints.
 */

import { describe, it, expect, vi } from "vitest";
import {
  modelKey,
  parseCliModelPatterns,
  isModelInScope,
  outOfScopeModelError,
  resolveScopedModelKeysFromPatterns,
  patternMatchesModel,
  stripThinkingSuffix,
} from "../../src/models/model-scope.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/agent-dir",
  SettingsManager: {
    create: () => ({
      getEnabledModels: () => undefined,
    }),
  },
}));

describe("modelKey", () => {
  it("formats provider/id", () => {
    expect(modelKey({ provider: "cpa-responses", id: "grok-4.5" })).toBe(
      "cpa-responses/grok-4.5",
    );
  });
});

describe("parseCliModelPatterns", () => {
  it("returns undefined when --models is absent", () => {
    expect(parseCliModelPatterns(["node", "pi"])).toBeUndefined();
  });

  it("parses comma-separated patterns after --models", () => {
    expect(
      parseCliModelPatterns(["node", "pi", "--models", "a/b, c/d ,e/f"]),
    ).toEqual(["a/b", "c/d", "e/f"]);
  });

  it("returns undefined for empty --models value", () => {
    expect(parseCliModelPatterns(["node", "pi", "--models", "  ,  "])).toBeUndefined();
  });

  it("returns undefined when --models has no following arg", () => {
    expect(parseCliModelPatterns(["node", "pi", "--models"])).toBeUndefined();
  });
});

describe("stripThinkingSuffix", () => {
  it("strips known thinking levels", () => {
    expect(stripThinkingSuffix("cpa-responses/grok-4.5:high")).toBe(
      "cpa-responses/grok-4.5",
    );
  });

  it("keeps colons that are not thinking suffixes", () => {
    expect(stripThinkingSuffix("openrouter/model:exacto")).toBe(
      "openrouter/model:exacto",
    );
  });
});

describe("patternMatchesModel", () => {
  const grok = { provider: "cpa-responses", id: "grok-4.5" };

  it("matches exact provider/id", () => {
    expect(patternMatchesModel("cpa-responses/grok-4.5", grok)).toBe(true);
  });

  it("matches bare model id", () => {
    expect(patternMatchesModel("grok-4.5", grok)).toBe(true);
  });

  it("matches glob patterns", () => {
    expect(patternMatchesModel("cpa-responses/*", grok)).toBe(true);
    expect(patternMatchesModel("*grok*", grok)).toBe(true);
    expect(patternMatchesModel("cpa-gemini/*", grok)).toBe(false);
  });

  it("ignores thinking suffix on patterns", () => {
    expect(patternMatchesModel("cpa-responses/grok-4.5:high", grok)).toBe(true);
  });
});

describe("isModelInScope", () => {
  it("allows any model when scopedKeys is null", () => {
    expect(isModelInScope({ provider: "x", id: "y" }, null)).toBe(true);
  });

  it("allows models present in the scope set", () => {
    const scope = new Set(["cpa-responses/grok-4.5"]);
    expect(isModelInScope({ provider: "cpa-responses", id: "grok-4.5" }, scope)).toBe(true);
  });

  it("rejects models outside the scope set", () => {
    const scope = new Set(["cpa-responses/grok-4.5"]);
    expect(isModelInScope({ provider: "other", id: "model" }, scope)).toBe(false);
  });
});

describe("outOfScopeModelError", () => {
  it("includes the rejected model and allowed list", () => {
    const msg = outOfScopeModelError(
      "other/model",
      new Set(["a/one", "b/two"]),
    );
    expect(msg).toContain("other/model");
    expect(msg).toContain("a/one");
    expect(msg).toContain("b/two");
    expect(msg).toContain("/scoped-models");
  });

  it("truncates long allowed lists", () => {
    const keys = new Set(
      Array.from({ length: 12 }, (_, i) => `p/m${i}`),
    );
    const msg = outOfScopeModelError("x/y", keys);
    expect(msg).toContain("12 total");
    expect(msg).toContain("...");
  });
});

describe("resolveScopedModelKeysFromPatterns", () => {
  const available = [
    { provider: "cpa-responses", id: "grok-4.5" },
    { provider: "cpa-gemini", id: "gemini-3.5-flash" },
    { provider: "test", id: "parent-model" },
  ];

  it("returns null when patterns are empty/undefined", () => {
    expect(resolveScopedModelKeysFromPatterns(undefined, available)).toBeNull();
    expect(resolveScopedModelKeysFromPatterns([], available)).toBeNull();
  });

  it("returns null when patterns match no models", () => {
    expect(resolveScopedModelKeysFromPatterns(["nope"], available)).toBeNull();
  });

  it("returns a set of provider/id keys for matched models", () => {
    const keys = resolveScopedModelKeysFromPatterns(
      ["cpa-responses/grok-4.5", "cpa-gemini/*"],
      available,
    );
    expect(keys).toEqual(
      new Set([
        "cpa-responses/grok-4.5",
        "cpa-gemini/gemini-3.5-flash",
      ]),
    );
  });
});
