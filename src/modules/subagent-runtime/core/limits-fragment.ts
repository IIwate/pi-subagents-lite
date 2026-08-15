/**
 * limits-fragment.ts — Ownership of the persisted `concurrency` section.
 *
 * The fragment keeps its physical JSON field names (default/providers/models).
 * Parsing is the only tolerance point. Finite numbers preserve the old
 * scheduler's effective capacity: values below one clamp to one and positive
 * fractions round up. Dropping a saved serial limit would quietly restore four
 * slots. Missing, non-numeric, NaN, and infinite values carry no such intent;
 * they still fall back or drop. Updates and derived scheduler values are strict.
 */

import { Check } from "typebox/value";
import { DEFAULT_CONCURRENCY_LIMIT } from "../contracts/lifecycle.js";
import {
  ConcurrencyLimitsFragmentSchema,
  ConcurrencyLimitsSchema,
  ConcurrencyLimitsUpdateSchema,
  type ConcurrencyLimits,
  type ConcurrencyLimitsFragment,
  type ConcurrencyLimitsUpdate,
} from "../contracts/scheduling.js";

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.ceil(value));
}

function sanitizeEntries(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const limit = normalizeLimit(value);
    if (limit === undefined) continue;
    Object.defineProperty(entries, key, { value: limit, enumerable: true, configurable: true, writable: true });
  }
  return entries;
}

function factoryLimitsFragment(): ConcurrencyLimitsFragment {
  return { default: DEFAULT_CONCURRENCY_LIMIT, providers: {}, models: {} };
}

export function parseConcurrencyLimitsFragment(raw: unknown): ConcurrencyLimitsFragment {
  if (Check(ConcurrencyLimitsFragmentSchema, raw)) return raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return factoryLimitsFragment();
  const source = raw as Record<string, unknown>;
  const parsed = {
    default: normalizeLimit(source.default) ?? DEFAULT_CONCURRENCY_LIMIT,
    providers: sanitizeEntries(source.providers),
    models: sanitizeEntries(source.models),
  };
  // Hand-sanitizing can still produce a shape the schema refuses (a
  // prototype-only object, a non-integer that slipped the guard). Factory
  // defaults are the only remaining honest fragment.
  return Check(ConcurrencyLimitsFragmentSchema, parsed) ? parsed : factoryLimitsFragment();
}

/**
 * Updates are the last honest moment before persist and `replaceLimits`.
 * A typed-but-false fragment can commit, then throw when the scheduler
 * refuses the derived shape — the saved document would already be the
 * lie. Inbound and outbound Check fail closed here so a bad update never
 * becomes the next written section. Revisit if updates grow a result
 * envelope instead of throw-on-invalid.
 */
export function applyConcurrencyLimitsUpdate(
  fragment: ConcurrencyLimitsFragment,
  update: ConcurrencyLimitsUpdate,
): ConcurrencyLimitsFragment {
  if (!Check(ConcurrencyLimitsFragmentSchema, fragment) || !Check(ConcurrencyLimitsUpdateSchema, update)) {
    throw new TypeError("Concurrency limits update does not match its contract.");
  }
  let next: ConcurrencyLimitsFragment;
  switch (update.scope) {
    case "default":
      next = { ...fragment, default: update.limit };
      break;
    case "reset":
      next = factoryLimitsFragment();
      break;
    case "provider":
    case "model": {
      const section = update.scope === "provider" ? "providers" : "models";
      const entries = { ...fragment[section] };
      if (update.limit === null) delete entries[update.key];
      else Object.defineProperty(entries, update.key, { value: update.limit, enumerable: true, configurable: true, writable: true });
      next = { ...fragment, [section]: entries };
      break;
    }
  }
  if (!Check(ConcurrencyLimitsFragmentSchema, next)) {
    throw new TypeError("Concurrency limits fragment does not match its contract.");
  }
  return next;
}

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
