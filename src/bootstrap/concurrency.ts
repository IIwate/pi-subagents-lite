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
  mergeConcurrencyLayers,
  parseConcurrencyLayer,
  parseConcurrencyLimitsFragment,
  runtimeLimitsFromFragment,
  type ConcurrencyLimits,
  type ConcurrencyLimitsFragment,
  type ConcurrencyLimitsUpdate,
  type SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import type { SettingsUpdateResult } from "../modules/settings/public.js";
import { configurationSectionIO, type ProjectConfigurationBinding } from "./configuration.js";

/** Current persisted fragment, read fresh so no stale copy is ever edited. */
export function readConcurrencyFragment(): ConcurrencyLimitsFragment {
  return parseConcurrencyLimitsFragment(configurationSectionIO.read("concurrency"));
}

/** Scheduler-shaped limits derived from the persisted fragment. */
export function concurrencyRuntimeLimits(): ConcurrencyLimits {
  return runtimeLimitsFromFragment(readConcurrencyFragment());
}

/**
 * Effective limits merged as capability defaults <- global <- trusted
 * project (REQ-RUNTIME-008). An untrusted or absent project layer simply
 * contributes nothing.
 */
export function concurrencyMergedLimits(binding: ProjectConfigurationBinding | null): ConcurrencyLimits {
  const globalLayer = parseConcurrencyLayer(configurationSectionIO.read("concurrency"));
  const projectLayer = binding?.sectionIO
    ? parseConcurrencyLayer(binding.sectionIO.read("concurrency"))
    : undefined;
  return runtimeLimitsFromFragment(mergeConcurrencyLayers(globalLayer, projectLayer).effective);
}

/** Commit-first fragment update; republishes into the live scheduler only on success. */
export function updateConcurrencyLimits(
  update: ConcurrencyLimitsUpdate,
  manager: SubagentRuntime | null,
): SettingsUpdateResult {
  const next = applyConcurrencyLimitsUpdate(readConcurrencyFragment(), update);
  const result = configurationSectionIO.commit(
    "concurrency",
    JSON.parse(JSON.stringify(next)) as Record<string, JsonValue>,
  );
  if (!result.ok) return result;
  manager?.replaceLimits(runtimeLimitsFromFragment(next));
  return { ok: true };
}
