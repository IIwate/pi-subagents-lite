/**
 * concurrency-layers.test.ts — Layered concurrency parse/merge/provenance and
 * per-layer update plans (REQ-RUNTIME-008).
 *
 * All functions are pure and double-checked against their contracts; global
 * and project share one tolerance rule (clamp-to-1/ceil, non-numeric drops).
 */

import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ConcurrencyLayerParseResultSchema,
  ConcurrencyLayerUpdatePlanSchema,
  MergedConcurrencyLimitsSchema,
  applyConcurrencyLayerUpdate,
  mergeConcurrencyLayers,
  parseConcurrencyLayer,
} from "../../../src/modules/subagent-runtime/public.js";

describe("REQ-RUNTIME-008 parseConcurrencyLayer", () => {
  it("returns a sparse fragment with presence for physically valid keys only", () => {
    const result = parseConcurrencyLayer({
      default: 0.5,
      providers: { openai: 2, broken: "x" },
      models: {},
      unknownSibling: true,
    });
    expect(result).toEqual({
      fragment: { default: 1, providers: { openai: 2 } },
      presence: { default: true, providers: { openai: true }, models: {} },
      ignoredEntryCount: 2,
    });
    expect(Check(ConcurrencyLayerParseResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  it("treats a non-object section as an empty layer", () => {
    for (const raw of [undefined, null, "junk", [1]]) {
      expect(parseConcurrencyLayer(raw)).toEqual({
        fragment: {},
        presence: { default: false, providers: {}, models: {} },
        ignoredEntryCount: 0,
      });
    }
  });

  it("ceils fractional limits and drops non-numeric values", () => {
    const result = parseConcurrencyLayer({ default: 2.2, models: { m: -3, n: Number.NaN } });
    expect(result.fragment).toEqual({ default: 3, models: { m: 1 } });
    expect(result.ignoredEntryCount).toBe(1);
  });
});

describe("REQ-RUNTIME-008 mergeConcurrencyLayers", () => {
  const parse = parseConcurrencyLayer;

  it("applies defaults <- global <- project precedence for the default limit", () => {
    expect(mergeConcurrencyLayers(parse(undefined), parse(undefined))).toEqual({
      effective: { default: 4, providers: {}, models: {} },
      provenance: { default: "default", providers: {}, models: {} },
    });
    expect(mergeConcurrencyLayers(parse({ default: 6 }), parse(undefined)).effective.default).toBe(6);
    expect(mergeConcurrencyLayers(parse({ default: 6 }), parse(undefined)).provenance.default).toBe("global");
    expect(mergeConcurrencyLayers(parse(undefined), parse({ default: 2 })).provenance.default).toBe("project");
    const both = mergeConcurrencyLayers(parse({ default: 6 }), parse({ default: 2 }));
    expect(both.effective.default).toBe(2);
    expect(both.provenance.default).toBe("project");
  });

  it("overrides providers and models per key with provenance", () => {
    const merged = mergeConcurrencyLayers(
      parse({ providers: { openai: 3 }, models: { "openai/gpt": 5 } }),
      parse({ providers: { openai: 1, local: 2 } }),
    );
    expect(merged).toEqual({
      effective: {
        default: 4,
        providers: { openai: 1, local: 2 },
        models: { "openai/gpt": 5 },
      },
      provenance: {
        default: "default",
        providers: { openai: "project", local: "project" },
        models: { "openai/gpt": "global" },
      },
    });
    expect(Check(MergedConcurrencyLimitsSchema, JSON.parse(JSON.stringify(merged)))).toBe(true);
  });

  it("merges without a project layer at all", () => {
    const merged = mergeConcurrencyLayers(parse({ default: 6 }));
    expect(merged.effective).toEqual({ default: 6, providers: {}, models: {} });
    expect(merged.provenance.default).toBe("global");
  });

  it("rejects an invalid layer parse result", () => {
    expect(() => mergeConcurrencyLayers({ fragment: {}, presence: {}, ignoredEntryCount: 0 } as never))
      .toThrow(TypeError);
  });
});

describe("REQ-RUNTIME-008 applyConcurrencyLayerUpdate", () => {
  it("sets the default limit with a minimal assignment", () => {
    const plan = applyConcurrencyLayerUpdate({ default: 4 }, { scope: "default", limit: 8 }, "project");
    expect(plan).toEqual({ assignments: { default: 8 }, removals: [] });
    expect(Check(ConcurrencyLayerUpdatePlanSchema, JSON.parse(JSON.stringify(plan)))).toBe(true);
  });

  it("preserves unrecognized container entries when rewriting a container", () => {
    const plan = applyConcurrencyLayerUpdate(
      { providers: { openai: 2, junk: "keep-me" } },
      { scope: "provider", key: "local", limit: 3 },
      "global",
    );
    expect(plan).toEqual({
      assignments: { providers: { openai: 2, junk: "keep-me", local: 3 } },
      removals: [],
    });
  });

  it("clears a project override, removing an emptied container key entirely", () => {
    expect(applyConcurrencyLayerUpdate(
      { providers: { openai: 2, local: 1 } },
      { scope: "provider", key: "local", limit: null },
      "project",
    )).toEqual({ assignments: { providers: { openai: 2 } }, removals: [] });

    expect(applyConcurrencyLayerUpdate(
      { providers: { local: 1 } },
      { scope: "provider", key: "local", limit: null },
      "project",
    )).toEqual({ assignments: {}, removals: ["providers"] });
  });

  it("returns an empty plan when clearing a key the project layer never had", () => {
    expect(applyConcurrencyLayerUpdate(
      { default: 2 },
      { scope: "model", key: "openai/gpt", limit: null },
      "project",
    )).toEqual({ assignments: {}, removals: [] });
  });

  it("treats a wholly non-object raw section as empty for both set and clear", () => {
    for (const raw of [null, "junk", [1]]) {
      expect(applyConcurrencyLayerUpdate(
        raw,
        { scope: "provider", key: "openai", limit: 2 },
        "global",
      )).toEqual({ assignments: { providers: { openai: 2 } }, removals: [] });
      expect(applyConcurrencyLayerUpdate(
        raw,
        { scope: "provider", key: "openai", limit: null },
        "project",
      )).toEqual({ assignments: {}, removals: [] });
    }
  });

  it("resets global to the factory fragment and project to full removals", () => {
    expect(applyConcurrencyLayerUpdate({ default: 9 }, { scope: "reset" }, "global"))
      .toEqual({ assignments: { default: 4, providers: {}, models: {} }, removals: [] });
    expect(applyConcurrencyLayerUpdate({ default: 9 }, { scope: "reset" }, "project"))
      .toEqual({ assignments: {}, removals: ["default", "providers", "models"] });
  });

  it("rejects an invalid update or target", () => {
    expect(() => applyConcurrencyLayerUpdate({}, { scope: "default", limit: 0 } as never, "project"))
      .toThrow(TypeError);
    expect(() => applyConcurrencyLayerUpdate({}, { scope: "reset" }, "session" as never))
      .toThrow(TypeError);
  });
});
