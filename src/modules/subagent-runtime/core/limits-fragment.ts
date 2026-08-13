/**
 * limits-fragment.ts — Ownership of the persisted `concurrency` section.
 *
 * The fragment keeps its physical JSON field names (default/providers/models).
 * Parsing is the only tolerance point: values that are not integers >= 1 fall
 * back to capability defaults (invalid entries are dropped, an invalid default
 * becomes DEFAULT_CONCURRENCY_LIMIT) instead of crashing the scheduler at
 * session start. Updates and the derived scheduler shape are strict.
 */

import { DEFAULT_CONCURRENCY_LIMIT } from "../contracts/lifecycle.js";
import type {
  ConcurrencyLimits,
  ConcurrencyLimitsFragment,
  ConcurrencyLimitsUpdate,
} from "../contracts/scheduling.js";

function isValidLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function sanitizeEntries(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidLimit(value)) continue;
    Object.defineProperty(entries, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return entries;
}

function factoryLimitsFragment(): ConcurrencyLimitsFragment {
  return { default: DEFAULT_CONCURRENCY_LIMIT, providers: {}, models: {} };
}

export function parseConcurrencyLimitsFragment(raw: unknown): ConcurrencyLimitsFragment {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return factoryLimitsFragment();
  const source = raw as Record<string, unknown>;
  return {
    default: isValidLimit(source.default) ? source.default : DEFAULT_CONCURRENCY_LIMIT,
    providers: sanitizeEntries(source.providers),
    models: sanitizeEntries(source.models),
  };
}

export function applyConcurrencyLimitsUpdate(
  fragment: ConcurrencyLimitsFragment,
  update: ConcurrencyLimitsUpdate,
): ConcurrencyLimitsFragment {
  switch (update.scope) {
    case "default":
      return { ...fragment, default: update.limit };
    case "reset":
      return factoryLimitsFragment();
    case "provider":
    case "model": {
      const section = update.scope === "provider" ? "providers" : "models";
      const entries = { ...fragment[section] };
      if (update.limit === null) delete entries[update.key];
      else Object.defineProperty(entries, update.key, { value: update.limit, enumerable: true, configurable: true, writable: true });
      return { ...fragment, [section]: entries };
    }
  }
}

export function runtimeLimitsFromFragment(fragment: ConcurrencyLimitsFragment): ConcurrencyLimits {
  return {
    defaultModelLimit: fragment.default,
    providerLimits: { ...fragment.providers },
    modelLimits: { ...fragment.models },
  };
}
