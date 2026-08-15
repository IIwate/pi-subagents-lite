/**
 * Contract tests for the strict fragment -> scheduler derivation kept by the
 * runtime. Layer parsing and update plans are covered by
 * concurrency-layers.test.ts (REQ-RUNTIME-008).
 */

import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ConcurrencyLimitsSchema,
  createConcurrencyScheduler,
  mergeConcurrencyLayers,
  parseConcurrencyLayer,
  runtimeLimitsFromFragment,
} from "../../../src/modules/subagent-runtime/public.js";

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

  // Migrated zero and negative values remain serial rather than restoring the
  // four-slot fallback that local single-GPU configurations were avoiding.
  it("keeps a migrated zero limit serial through the scheduler", () => {
    const merged = mergeConcurrencyLayers(parseConcurrencyLayer({
      default: 0,
      providers: {},
      models: { "llamacpp/local": 0 },
    }));
    const scheduler = createConcurrencyScheduler(runtimeLimitsFromFragment(merged.effective));
    expect(scheduler.reserve("llamacpp/local").accepted).toBe(true);
    expect(scheduler.reserve("llamacpp/local").accepted).toBe(false);
    scheduler.release("llamacpp/local");
    expect(scheduler.reserve("llamacpp/local").accepted).toBe(true);
    // A model without an override inherits the normalized default.
    expect(scheduler.reserve("openai/gpt-5").accepted).toBe(true);
    expect(scheduler.reserve("openai/gpt-5").accepted).toBe(false);
  });
});
