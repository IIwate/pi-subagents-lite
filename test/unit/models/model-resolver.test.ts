import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, it, expect } from "vitest";
import {
  parseModelKey,
  resolveExactModel,
  unknownModelError,
} from "../../../src/models/model-resolver.js";

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

describe("resolveExactModel", () => {
  const parent = fauxProvider({ provider: "test", models: [{ id: "parent-model" }] }).getModel();
  const grok = fauxProvider({ provider: "cpa-responses", models: [{ id: "grok-4.5" }] }).getModel();

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
