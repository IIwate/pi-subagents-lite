/**
 * concurrency.ts — Composition seam for the layered concurrency limits.
 *
 * The subagent-runtime module owns parse/merge/provenance/update-plan
 * semantics; this seam binds them to the global document and the session's
 * project binding, routes each write to exactly one layer, and pushes the
 * re-merged limits into the live scheduler only after a successful commit
 * (REQ-CONFIG-001, REQ-RUNTIME-008). An empty update plan is a no-op
 * success: no commit, no file creation, no scheduler replace.
 */

import type { JsonValue } from "../modules/configuration/public.js";
import {
  applyConcurrencyLayerUpdate,
  mergeConcurrencyLayers,
  parseConcurrencyLayer,
  runtimeLimitsFromFragment,
  type ConcurrencyLayerParseResult,
  type ConcurrencyLimits,
  type MergedConcurrencyLimits,
  type SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import type { ConcurrencyLimitUpdate, SettingsUpdateResult } from "../modules/settings/public.js";
import { configurationSectionIO, type ProjectConfigurationBinding } from "./configuration.js";

/** Both layers parsed fresh so no stale copy is ever edited. */
export function readConcurrencyLayers(binding: ProjectConfigurationBinding | null): {
  globalLayer: ConcurrencyLayerParseResult;
  projectLayer?: ConcurrencyLayerParseResult;
} {
  const globalLayer = parseConcurrencyLayer(configurationSectionIO.read("concurrency"));
  const projectLayer = binding?.sectionIO
    ? parseConcurrencyLayer(binding.sectionIO.read("concurrency"))
    : undefined;
  return { globalLayer, ...(projectLayer ? { projectLayer } : {}) };
}

/** Effective fragment plus provenance, merged defaults <- global <- project. */
export function mergedConcurrency(binding: ProjectConfigurationBinding | null): MergedConcurrencyLimits {
  const { globalLayer, projectLayer } = readConcurrencyLayers(binding);
  return mergeConcurrencyLayers(globalLayer, projectLayer);
}

/**
 * Scheduler-shaped limits merged as capability defaults <- global <- trusted
 * project (REQ-RUNTIME-008). An untrusted or absent project layer simply
 * contributes nothing.
 */
export function concurrencyMergedLimits(binding: ProjectConfigurationBinding | null): ConcurrencyLimits {
  return runtimeLimitsFromFragment(mergedConcurrency(binding).effective);
}

/**
 * Commit-first update routed to exactly one layer; republishes the freshly
 * merged limits into the live scheduler only on success. Running and queued
 * work keeps its Accepted run policy — replace affects later reserve/drain.
 */
export function updateConcurrencyLimits(
  { target, update }: ConcurrencyLimitUpdate,
  manager: SubagentRuntime | null,
  binding: ProjectConfigurationBinding | null,
): SettingsUpdateResult {
  const io = target === "global" ? configurationSectionIO : binding?.sectionIO;
  if (!io) {
    return { ok: false, message: "Project configuration is not writable in this session." };
  }
  const raw = io.read("concurrency");
  const plan = applyConcurrencyLayerUpdate(raw, update, target);
  const planIsEmpty = Object.keys(plan.assignments).length === 0 && plan.removals.length === 0;
  if (planIsEmpty) {
    // Clearing an override the layer never had: nothing to persist, and an
    // absent project file must not be created by a no-op.
    return { ok: true };
  }
  const result = io.commit(
    "concurrency",
    JSON.parse(JSON.stringify(plan.assignments)) as Record<string, JsonValue>,
    plan.removals,
  );
  if (!result.ok) return result;
  manager?.replaceLimits(concurrencyMergedLimits(binding));
  return { ok: true };
}
