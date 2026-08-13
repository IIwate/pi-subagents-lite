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
