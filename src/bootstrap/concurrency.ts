/**
 * concurrency.ts — Composition seam for the concurrency limits fragment.
 *
 * The subagent-runtime module owns the fragment's shape and semantics
 * (parse/update/derive); this seam binds them to the shared configuration
 * document and pushes committed limits into the live scheduler. Persisting
 * happens before republishing, so a failed save leaves the previous limits
 * in force (REQ-CONFIG-001).
 */

import type { JsonValue } from "../modules/configuration/public.js";
import {
  applyConcurrencyLimitsUpdate,
  parseConcurrencyLimitsFragment,
  runtimeLimitsFromFragment,
  type ConcurrencyLimits,
  type ConcurrencyLimitsFragment,
  type ConcurrencyLimitsUpdate,
} from "../modules/subagent-runtime/public.js";
import { configurationSectionIO } from "./configuration.js";
import { getManager } from "../shell.js";

/** Current persisted fragment, read fresh so no stale copy is ever edited. */
export function readConcurrencyFragment(): ConcurrencyLimitsFragment {
  return parseConcurrencyLimitsFragment(configurationSectionIO.read("concurrency"));
}

/** Scheduler-shaped limits derived from the persisted fragment. */
export function concurrencyRuntimeLimits(): ConcurrencyLimits {
  return runtimeLimitsFromFragment(readConcurrencyFragment());
}

/** Commit-first fragment update; republishes into the live runtime only on success. */
export function updateConcurrencyLimits(
  update: ConcurrencyLimitsUpdate,
): { ok: true } | { ok: false; message: string } {
  const next = applyConcurrencyLimitsUpdate(readConcurrencyFragment(), update);
  const result = configurationSectionIO.commit(
    "concurrency",
    JSON.parse(JSON.stringify(next)) as Record<string, JsonValue>,
  );
  if (!result.ok) return result;
  getManager()?.replaceLimits(runtimeLimitsFromFragment(next));
  return { ok: true };
}
