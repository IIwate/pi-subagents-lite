/**
 * limits-fragment.ts — Scheduler projection of the concurrency fragment.
 *
 * Layer parsing and updates moved to concurrency-layers.ts (REQ-RUNTIME-008,
 * unified value-preserving write path); this file keeps only the strict
 * fragment -> scheduler shape derivation.
 */

import { Check } from "typebox/value";
import {
  ConcurrencyLimitsFragmentSchema,
  ConcurrencyLimitsSchema,
  type ConcurrencyLimits,
  type ConcurrencyLimitsFragment,
} from "../contracts/scheduling.js";

export function runtimeLimitsFromFragment(fragment: ConcurrencyLimitsFragment): ConcurrencyLimits {
  if (!Check(ConcurrencyLimitsFragmentSchema, fragment)) {
    throw new TypeError("Concurrency limits fragment does not match its contract.");
  }
  const limits = {
    defaultModelLimit: fragment.default,
    providerLimits: { ...fragment.providers },
    modelLimits: { ...fragment.models },
  };
  if (!Check(ConcurrencyLimitsSchema, limits)) {
    throw new TypeError("Concurrency limits do not match their contract.");
  }
  return limits;
}
