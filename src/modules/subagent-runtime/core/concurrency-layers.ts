/**
 * concurrency-layers.ts — Layered concurrency parse/merge/provenance/update
 * (REQ-RUNTIME-008).
 *
 * Global and project share one tolerance rule (the limits-fragment lineage):
 * finite numbers clamp to one and ceil, everything else is dropped and
 * counted in `ignoredEntryCount`. Presence records only physically valid
 * keys; merge injects the factory default itself so provenance never guesses
 * from a normalized fragment. Update plans are computed against the raw disk
 * section so unrecognized JSON entries are carried along, not cleaned.
 */

import { Check } from "typebox/value";
import { DEFAULT_CONCURRENCY_LIMIT } from "../contracts/lifecycle.js";
import {
  ConcurrencyLayerParseResultSchema,
  ConcurrencyLayerUpdatePlanSchema,
  ConcurrencyLimitsUpdateSchema,
  ConcurrencyTargetSchema,
  MergedConcurrencyLimitsSchema,
  type ConcurrencyLayerParseResult,
  type ConcurrencyLayerUpdatePlan,
  type ConcurrencyLimitsUpdate,
  type ConcurrencyProvenance,
  type ConcurrencyTarget,
  type MergedConcurrencyLimits,
} from "../contracts/scheduling.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.ceil(value));
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

const CONTAINER_KEYS = ["providers", "models"] as const;

export function parseConcurrencyLayer(raw: unknown): ConcurrencyLayerParseResult {
  const result: ConcurrencyLayerParseResult = {
    fragment: {},
    presence: { default: false, providers: {}, models: {} },
    ignoredEntryCount: 0,
  };
  if (isPlainObject(raw)) {
    for (const key of Object.keys(raw)) {
      if (key !== "default" && !CONTAINER_KEYS.includes(key as typeof CONTAINER_KEYS[number])) {
        result.ignoredEntryCount += 1;
      }
    }
    if (Object.hasOwn(raw, "default")) {
      const limit = normalizeLimit(raw.default);
      if (limit === undefined) result.ignoredEntryCount += 1;
      else {
        result.fragment.default = limit;
        result.presence.default = true;
      }
    }
    for (const container of CONTAINER_KEYS) {
      const source = raw[container];
      if (source === undefined) continue;
      if (!isPlainObject(source)) {
        result.ignoredEntryCount += 1;
        continue;
      }
      const entries: Record<string, number> = {};
      for (const [key, value] of Object.entries(source)) {
        const limit = normalizeLimit(value);
        if (limit === undefined) {
          result.ignoredEntryCount += 1;
          continue;
        }
        setOwn(entries, key, limit);
        setOwn(result.presence[container], key, true);
      }
      if (Object.keys(entries).length > 0) result.fragment[container] = entries;
    }
  }
  if (!Check(ConcurrencyLayerParseResultSchema, result)) {
    throw new TypeError("Concurrency layer parse result does not match its contract.");
  }
  return result;
}

export function mergeConcurrencyLayers(
  globalLayer: ConcurrencyLayerParseResult,
  projectLayer?: ConcurrencyLayerParseResult,
): MergedConcurrencyLimits {
  if (
    !Check(ConcurrencyLayerParseResultSchema, globalLayer)
    || (projectLayer !== undefined && !Check(ConcurrencyLayerParseResultSchema, projectLayer))
  ) {
    throw new TypeError("Concurrency layer parse result does not match its contract.");
  }
  const provenance: ConcurrencyProvenance = {
    default: projectLayer?.presence.default ? "project" : globalLayer.presence.default ? "global" : "default",
    providers: {},
    models: {},
  };
  const effective = {
    default: projectLayer?.fragment.default ?? globalLayer.fragment.default ?? DEFAULT_CONCURRENCY_LIMIT,
    providers: {} as Record<string, number>,
    models: {} as Record<string, number>,
  };
  for (const container of CONTAINER_KEYS) {
    for (const [key, value] of Object.entries(globalLayer.fragment[container] ?? {})) {
      setOwn(effective[container], key, value);
      setOwn(provenance[container], key, "global" as const);
    }
    for (const [key, value] of Object.entries(projectLayer?.fragment[container] ?? {})) {
      setOwn(effective[container], key, value);
      setOwn(provenance[container], key, "project" as const);
    }
  }
  const merged: MergedConcurrencyLimits = { effective, provenance };
  if (!Check(MergedConcurrencyLimitsSchema, merged)) {
    throw new TypeError("Merged concurrency limits do not match their contract.");
  }
  return merged;
}

/** Raw container value with unrecognized entries preserved as JSON. */
function rawContainer(rawSection: unknown, container: "providers" | "models"): Record<string, unknown> {
  if (!isPlainObject(rawSection)) return {};
  const value = rawSection[container];
  return isPlainObject(value) ? structuredClone(value) : {};
}

export function applyConcurrencyLayerUpdate(
  rawSection: unknown,
  update: ConcurrencyLimitsUpdate,
  layer: ConcurrencyTarget,
): ConcurrencyLayerUpdatePlan {
  if (!Check(ConcurrencyLimitsUpdateSchema, update) || !Check(ConcurrencyTargetSchema, layer)) {
    throw new TypeError("Concurrency layer update does not match its contract.");
  }
  const plan: ConcurrencyLayerUpdatePlan = { assignments: {}, removals: [] };
  switch (update.scope) {
    case "default": {
      if (update.limit === null) {
        // Clearing a default the raw section never had is a no-op that
        // creates no file, the same promise keyed clears make.
        if (isPlainObject(rawSection) && Object.hasOwn(rawSection, "default")) {
          plan.removals = ["default"];
        }
      } else {
        plan.assignments.default = update.limit;
      }
      break;
    }
    case "reset":
      if (layer === "global") {
        // Global reset writes the factory fragment (status quo); project
        // reset removes every override so all keys fall back to inheritance.
        plan.assignments = { default: DEFAULT_CONCURRENCY_LIMIT, providers: {}, models: {} };
      } else {
        plan.removals = ["default", "providers", "models"];
      }
      break;
    case "provider":
    case "model": {
      const container = update.scope === "provider" ? "providers" : "models";
      const entries = rawContainer(rawSection, container);
      if (update.limit === null) {
        if (!Object.hasOwn(entries, update.key)) break; // no override to clear: no-op plan
        delete entries[update.key];
        if (layer === "project" && Object.keys(entries).length === 0) {
          // An empty project container would shadow nothing but still exist;
          // removing the key restores pure inheritance.
          plan.removals = [container];
          break;
        }
      } else {
        setOwn(entries, update.key, update.limit);
      }
      setOwn(plan.assignments, container, entries as ConcurrencyLayerUpdatePlan["assignments"][string]);
      break;
    }
  }
  if (!Check(ConcurrencyLayerUpdatePlanSchema, plan)) {
    throw new TypeError("Concurrency layer update plan does not match its contract.");
  }
  return plan;
}
