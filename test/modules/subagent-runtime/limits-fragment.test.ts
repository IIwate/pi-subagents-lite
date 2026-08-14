/**
 * Contract tests for the concurrency limits fragment owned by the runtime:
 * tolerant parsing of the persisted section, strict updates, and derivation
 * of the effective scheduler limits.
 */

import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  applyConcurrencyLimitsUpdate,
  ConcurrencyLimitsFragmentSchema,
  ConcurrencyLimitsSchema,
  ConcurrencyLimitsUpdateSchema,
  parseConcurrencyLimitsFragment,
  runtimeLimitsFromFragment,
} from "../../../src/modules/subagent-runtime/public.js";

describe("parseConcurrencyLimitsFragment", () => {
  it("returns capability defaults for a missing or non-object section", () => {
    for (const raw of [undefined, null, "x", 4, ["a"]]) {
      expect(parseConcurrencyLimitsFragment(raw)).toEqual({ default: 4, providers: {}, models: {} });
    }
  });

  it("keeps valid entries and drops hand-edited junk instead of crashing the scheduler", () => {
    const parsed = parseConcurrencyLimitsFragment({
      default: 0,
      providers: { openai: 2, google: "three", broken: 1.5 },
      models: { "openai/gpt-5": 1, "openai/o3": -2 },
      unknownField: true,
    });
    expect(parsed).toEqual({
      default: 4,
      providers: { openai: 2 },
      models: { "openai/gpt-5": 1 },
    });
    expect(Check(ConcurrencyLimitsFragmentSchema, parsed)).toBe(true);
  });

  it("stores prototype-like keys as own properties", () => {
    const parsed = parseConcurrencyLimitsFragment({
      default: 4,
      providers: JSON.parse('{"__proto__": 2}'),
      models: {},
    });
    expect(Object.hasOwn(parsed.providers, "__proto__")).toBe(true);
    expect(parsed.providers["__proto__"]).toBe(2);
    expect(Object.hasOwn({}, "__proto__")).toBe(false);
  });
});

describe("applyConcurrencyLimitsUpdate", () => {
  const base = { default: 4, providers: { openai: 2 }, models: { "openai/gpt-5": 3 } };

  it("sets the fallback default without touching overrides", () => {
    const next = applyConcurrencyLimitsUpdate(base, { scope: "default", limit: 8 });
    expect(next).toEqual({ ...base, default: 8 });
    expect(base.default).toBe(4);
  });

  it("sets and removes provider and model overrides", () => {
    const withProvider = applyConcurrencyLimitsUpdate(base, { scope: "provider", key: "google", limit: 1 });
    expect(withProvider.providers).toEqual({ openai: 2, google: 1 });

    const withoutModel = applyConcurrencyLimitsUpdate(base, { scope: "model", key: "openai/gpt-5", limit: null });
    expect(withoutModel.models).toEqual({});
  });

  it("resets to the factory fragment", () => {
    expect(applyConcurrencyLimitsUpdate(base, { scope: "reset" })).toEqual({
      default: 4,
      providers: {},
      models: {},
    });
  });

  it("rejects an invalid update or fragment instead of returning a committable shape", () => {
    expect(() => applyConcurrencyLimitsUpdate(base, { scope: "default", limit: 0 } as never)).toThrow(TypeError);
    expect(() => applyConcurrencyLimitsUpdate({ default: 0, providers: {}, models: {} } as never, { scope: "reset" })).toThrow(TypeError);
    expect(base).toEqual({ default: 4, providers: { openai: 2 }, models: { "openai/gpt-5": 3 } });
  });

  it("round-trips a valid update and fragment through JSON", () => {
    const update = { scope: "provider" as const, key: "google", limit: 1 };
    expect(Check(ConcurrencyLimitsUpdateSchema, JSON.parse(JSON.stringify(update)))).toBe(true);
    const next = applyConcurrencyLimitsUpdate(base, update);
    const roundTripped = JSON.parse(JSON.stringify(next));
    expect(Check(ConcurrencyLimitsFragmentSchema, roundTripped)).toBe(true);
    expect(roundTripped).toEqual(next);
  });
});

describe("runtimeLimitsFromFragment", () => {
  it("maps physical field names onto the scheduler shape with copies", () => {
    const fragment = { default: 2, providers: { openai: 1 }, models: { "openai/gpt-5": 3 } };
    const limits = runtimeLimitsFromFragment(fragment);
    expect(limits).toEqual({
      defaultModelLimit: 2,
      providerLimits: { openai: 1 },
      modelLimits: { "openai/gpt-5": 3 },
    });
    limits.providerLimits.openai = 99;
    expect(fragment.providers.openai).toBe(1);
    expect(Check(ConcurrencyLimitsSchema, JSON.parse(JSON.stringify(limits)))).toBe(true);
  });

  it("rejects an off-contract fragment instead of deriving scheduler limits", () => {
    expect(() => runtimeLimitsFromFragment({ default: 0, providers: {}, models: {} } as never)).toThrow(TypeError);
  });
});
