import { Check } from "typebox/value";
import {
  ConcurrencyLimitsSchema,
  type ConcurrencyDecision,
} from "../contracts/scheduling.js";
import { createConcurrencyAccounting } from "../core/concurrency-scheduler.js";

export interface ConcurrencyScheduler {
  reserve(concurrencyKey: string): ConcurrencyDecision;
  release(concurrencyKey: string): void;
  replaceLimits(limits: unknown): void;
}

export function createConcurrencyScheduler(limits: unknown): ConcurrencyScheduler {
  if (!Check(ConcurrencyLimitsSchema, limits)) {
    throw new TypeError("Concurrency limits are invalid.");
  }
  const accounting = createConcurrencyAccounting(limits);
  return {
    reserve: accounting.reserve,
    release: accounting.release,
    replaceLimits(next: unknown): void {
      if (!Check(ConcurrencyLimitsSchema, next)) {
        throw new TypeError("Concurrency limits are invalid.");
      }
      accounting.replaceLimits(next);
    },
  };
}
