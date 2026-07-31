/**
 * model-scope.test.ts — Pi 0.83 resolved Model scope helpers.
 */

import { describe, expect, it, vi } from "vitest";
import {
  automaticModelOverrideError,
  crossProviderModelError,
  isModelInScope,
  listModelOptionsForMenus,
  missingParentModelError,
  missingSubagentModelError,
  modelKey,
  outOfScopeModelError,
  scopedModelKeys,
  scopedThinkingLevel,
} from "../../src/models/model-scope.ts";

const grok = { provider: "cpa-responses", id: "grok-4.5" } as any;
const gemini = { provider: "cpa-gemini", id: "gemini-3.5-flash" } as any;

describe("missing model errors", () => {
  it("distinguishes a missing parent from an unresolved authorized override", () => {
    expect(missingParentModelError()).toContain("parent session has no active model");
    expect(missingSubagentModelError()).toContain("no subagent model could be resolved");
  });
});

describe("automaticModelOverrideError", () => {
  it("explains that queued automatic selection lost authorization", () => {
    const message = automaticModelOverrideError("same-provider/worker");
    expect(message).toContain("same-provider/worker");
    expect(message).toContain("no longer authorized");
    expect(message).toContain("Allow cross-provider");
  });
});

describe("crossProviderModelError", () => {
  it("points users to the cross-provider permission", () => {
    const message = crossProviderModelError("other/model", "parent");
    expect(message).toContain("other/model");
    expect(message).toContain("Allow cross-provider");
  });
});

describe("modelKey", () => {
  it("formats provider/id", () => {
    expect(modelKey(grok)).toBe("cpa-responses/grok-4.5");
  });
});

describe("scopedModelKeys", () => {
  it("treats an empty Pi scope as unrestricted", () => {
    expect(scopedModelKeys([])).toBeNull();
  });

  it("uses Pi's resolved models without re-parsing patterns", () => {
    expect(scopedModelKeys([
      { model: grok, thinkingLevel: "high" },
      { model: gemini },
    ])).toEqual(new Set([
      "cpa-responses/grok-4.5",
      "cpa-gemini/gemini-3.5-flash",
    ]));
  });
});

describe("scopedThinkingLevel", () => {
  it("returns the thinking level pinned to the selected model", () => {
    expect(scopedThinkingLevel([
      { model: grok, thinkingLevel: "high" },
      { model: gemini, thinkingLevel: "low" },
    ], gemini)).toBe("low");
  });
});

describe("isModelInScope", () => {
  it("allows any model when scopedKeys is null", () => {
    expect(isModelInScope({ provider: "x", id: "y" }, null)).toBe(true);
  });

  it("accepts only models present in the scope set", () => {
    const scope = new Set(["cpa-responses/grok-4.5"]);
    expect(isModelInScope(grok, scope)).toBe(true);
    expect(isModelInScope(gemini, scope)).toBe(false);
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

describe("listModelOptionsForMenus", () => {
  it("uses Pi's session scope when present", () => {
    const getAvailable = vi.fn(() => [gemini]);
    const result = listModelOptionsForMenus({
      scopedModels: [{ model: grok, thinkingLevel: "high" }],
      modelRegistry: { getAvailable } as any,
    });

    expect(result).toEqual(["cpa-responses/grok-4.5"]);
    expect(getAvailable).not.toHaveBeenCalled();
  });

  it("falls back to all available models when unrestricted", () => {
    const result = listModelOptionsForMenus({
      scopedModels: [],
      modelRegistry: { getAvailable: () => [grok, gemini] } as any,
    });

    expect(result).toEqual([
      "cpa-responses/grok-4.5",
      "cpa-gemini/gemini-3.5-flash",
    ]);
  });
});
