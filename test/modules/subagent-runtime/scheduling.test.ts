import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ConcurrencyDecisionSchema,
  createConcurrencyScheduler,
} from "../../../src/modules/subagent-runtime/public.js";

describe("REQ-RUNTIME-001 hierarchical concurrency public seam", () => {
  it("reserves when both ceilings have room and queues when either is full", () => {
    const scheduler = createConcurrencyScheduler({
      defaultModelLimit: 1,
      modelLimits: { "openai/gpt-5": 1 },
      providerLimits: { openai: 1 },
    });

    const first = scheduler.reserve("openai/gpt-5");
    const blocked = scheduler.reserve("openai/o3");
    scheduler.release("openai/gpt-5");
    const afterRelease = scheduler.reserve("openai/o3");

    expect({
      firstValid: Check(ConcurrencyDecisionSchema, first),
      blockedValid: Check(ConcurrencyDecisionSchema, blocked),
      afterReleaseValid: Check(ConcurrencyDecisionSchema, afterRelease),
      first,
      blocked,
      afterRelease,
    }).toEqual({
      firstValid: true,
      blockedValid: true,
      afterReleaseValid: true,
      first: { accepted: true, concurrencyKey: "openai/gpt-5" },
      blocked: { accepted: false, reason: "concurrency", concurrencyKey: "openai/o3" },
      afterRelease: { accepted: true, concurrencyKey: "openai/o3" },
    });
  });
});

describe("REQ-RUNTIME-008 live limit replacement", () => {
  it("applies replaced limits to the very next reserve without evicting current reservations", () => {
    const scheduler = createConcurrencyScheduler({
      defaultModelLimit: 1,
      modelLimits: {},
      providerLimits: {},
    });

    const first = scheduler.reserve("openai/gpt-5");
    const blockedBefore = scheduler.reserve("openai/gpt-5");
    scheduler.replaceLimits({ defaultModelLimit: 2, modelLimits: {}, providerLimits: {} });
    const admittedAfterRaise = scheduler.reserve("openai/gpt-5");
    scheduler.replaceLimits({ defaultModelLimit: 1, modelLimits: {}, providerLimits: {} });
    const blockedAfterLower = scheduler.reserve("openai/gpt-5");
    scheduler.release("openai/gpt-5");
    scheduler.release("openai/gpt-5");
    const admittedAfterDrain = scheduler.reserve("openai/gpt-5");

    // Replacement changes admission for subsequent reserves only: the raise
    // admits without any release, the lowering blocks immediately, and the
    // two reservations taken under older limits stay held until released.
    expect({ first, blockedBefore, admittedAfterRaise, blockedAfterLower, admittedAfterDrain }).toEqual({
      first: { accepted: true, concurrencyKey: "openai/gpt-5" },
      blockedBefore: { accepted: false, reason: "concurrency", concurrencyKey: "openai/gpt-5" },
      admittedAfterRaise: { accepted: true, concurrencyKey: "openai/gpt-5" },
      blockedAfterLower: { accepted: false, reason: "concurrency", concurrencyKey: "openai/gpt-5" },
      admittedAfterDrain: { accepted: true, concurrencyKey: "openai/gpt-5" },
    });
  });
});
