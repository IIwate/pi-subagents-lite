/**
 * model-access.ts — Composition seam for the `modelRouting` configuration
 * fragment. The model-access module owns every rule transition and decision
 * table; this seam binds them to the shared configuration document and the
 * live Pi registry inventory. Each settings verb is one pure transition plus
 * one commit, so a failed save leaves the previous policy in force
 * (REQ-CONFIG-001, REQ-MODEL-007).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { JsonValue } from "../modules/configuration/public.js";
import {
  agentTypesForProvider,
  applyAgentProviderAccess,
  applyCleanUnavailableModels,
  applyClearModelAccess,
  applyDeleteProviderRules,
  applyParentModelAccess,
  applyProviderEnabled,
  applyQuickAgentProviderAccess,
  applyResetThinkingAccess,
  applyRoutingEnabled,
  applyThinkingAccess,
  effectiveAlternateModelKeys,
  isParentModelAllowed,
  parseModelAccessFragment,
  replacementThinkingDefault,
  resolveThinkingAccess,
  snapshotVisibleSelectedModels,
  unavailableModelRules,
  type ModelAccessFragment,
  type ThinkingLevel,
} from "../modules/model-access/public.js";
import type {
  ModelAccessAgentDetailView,
  ModelAccessAgentRow,
  ModelAccessModelsView,
  ModelAccessProvidersView,
  ModelAccessRootView,
  ModelAccessSettingsOwner,
  ModelAccessThinkingTarget,
  ModelAccessThinkingView,
  ModelAccessUnavailableRule,
} from "../modules/settings/public.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../models/model-scope.js";
import { configurationSectionIO, type ConfigSectionIO } from "./configuration.js";

type UpdateResult = { ok: true } | { ok: false; message: string };
type ModelRef = { provider: string; id: string };

/** Current persisted fragment, read fresh so no stale copy is ever edited. */
export function readModelAccessFragment(io: ConfigSectionIO = configurationSectionIO): ModelAccessFragment {
  return parseModelAccessFragment(io.read("modelRouting"));
}

/** Routing policy for runtime authorization and guidance assembly. */
export function currentModelAccess(): ModelAccessFragment {
  return readModelAccessFragment();
}

function commitModelAccess(io: ConfigSectionIO, next: ModelAccessFragment): UpdateResult {
  return io.commit(
    "modelRouting",
    JSON.parse(JSON.stringify(next)) as Record<string, JsonValue>,
  );
}

export interface ModelAccessOwnerOverrides {
  io?: ConfigSectionIO;
}

/**
 * Settings owner over the live session: fragment from the shared document,
 * inventory from the Pi registry, parent/scope facts from the command
 * context. The registered types come from the activation's registry rather
 * than a process-wide lookup, so a second runtime cannot see the first one's
 * catalogue.
 */
export function createModelAccessSettingsOwner(
  ctx: ExtensionCommandContext,
  registeredTypes: () => string[],
  overrides: ModelAccessOwnerOverrides = {},
): ModelAccessSettingsOwner {
  const io = overrides.io ?? configurationSectionIO;

  const parentKey = (): string => (ctx.model ? modelKey(ctx.model) : "");

  interface Inventory {
    catalogueModels: ModelRef[];
    availableModels: ModelRef[];
    availableProviders: Set<string>;
    catalogueProviders: Set<string>;
    catalogueReliable: boolean;
  }

  const inventory = (): Inventory => {
    const catalogueModels = ctx.modelRegistry.getAll();
    const availableModels = ctx.modelRegistry.getAvailable();
    return {
      catalogueModels,
      availableModels,
      availableProviders: new Set(availableModels.map((model: ModelRef) => model.provider)),
      catalogueProviders: new Set(catalogueModels.map((model: ModelRef) => model.provider)),
      catalogueReliable: ctx.modelRegistry.getError() === undefined,
    };
  };

  /** Providers globally enabled and currently available — the routable set. */
  const effectiveProviders = (fragment: ModelAccessFragment, snapshot: Inventory): string[] =>
    fragment.enabledProviders
      .filter((provider) => snapshot.availableProviders.has(provider))
      .sort();

  const agentSummary = (fragment: ModelAccessFragment, snapshot: Inventory, type: string): string => {
    const keys = effectiveAlternateModelKeys(
      type,
      fragment,
      snapshot.availableModels.map(modelKey),
      scopedModelKeys(ctx.scopedModels) ? [...scopedModelKeys(ctx.scopedModels)!] : null,
      parentKey(),
    );
    const summaries = effectiveProviders(fragment, snapshot).flatMap((provider) => {
      const prefix = `${provider}/`;
      const ids = keys.filter((key) => key.startsWith(prefix));
      if (ids.length === 0) return [];
      const rule = Object.hasOwn(fragment.agentAccess, type)
        ? fragment.agentAccess[type]!.providers[provider]
        : undefined;
      const access = rule?.models ? `${ids.length} model${ids.length === 1 ? "" : "s"}` : "All models";
      return [`${provider} (${access})`];
    });
    return summaries.length > 0 ? summaries.join(" · ") : "Parent only";
  };

  const agentRows = (types: readonly string[], registered: ReadonlySet<string>): ModelAccessAgentRow[] => {
    const fragment = readModelAccessFragment(io);
    const snapshot = inventory();
    return [...types].sort().map((type) => ({
      type,
      registered: registered.has(type),
      summary: agentSummary(fragment, snapshot, type),
    }));
  };

  const unavailableRules = (fragment: ModelAccessFragment, snapshot: Inventory): ModelAccessUnavailableRule[] => {
    if (!snapshot.catalogueReliable) return [];
    const providers = new Set<string>();
    for (const access of Object.values(fragment.agentAccess)) {
      for (const provider of Object.keys(access.providers)) providers.add(provider);
    }
    return [...providers].sort().flatMap((provider) => {
      const catalogueIds = snapshot.catalogueModels
        .filter((model) => model.provider === provider)
        .map((model) => model.id);
      const stale = unavailableModelRules(
        fragment,
        provider,
        catalogueIds,
        snapshot.catalogueProviders.has(provider),
        snapshot.catalogueReliable,
      );
      return Object.entries(stale).flatMap(([agentType, models]) =>
        models.map((modelId) => ({ provider, agentType, modelId })),
      );
    });
  };

  /** Model IDs visible in the editor: available, in scope, parent excluded. */
  const visibleModelIds = (provider: string): string[] => {
    const scopedKeys = scopedModelKeys(ctx.scopedModels);
    const parentId = ctx.model?.provider === provider ? ctx.model.id : undefined;
    return inventory().availableModels
      .filter((model) => model.provider === provider)
      .filter((model) => !scopedKeys || scopedKeys.has(modelKey(model)))
      .map((model) => model.id)
      .filter((modelId) => modelId !== parentId)
      .sort();
  };

  const findModel = (key: string): ModelRef => {
    const snapshot = inventory();
    const match = [...snapshot.availableModels, ...snapshot.catalogueModels]
      .find((model) => modelKey(model) === key);
    if (match) return match;
    // Saved overrides can outlive availability; a bare ref still lets pi-ai
    // compat answer with its default level set.
    const separator = key.indexOf("/");
    return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
  };

  /** Effective allowed/default for the editor: saved override else baseline. */
  const thinkingState = (
    fragment: ModelAccessFragment,
    type: string,
    key: string,
  ): { supported: ThinkingLevel[]; allowed: Set<ThinkingLevel>; defaultLevel: ThinkingLevel } => {
    const model = findModel(key);
    const supported = getSupportedThinkingLevels(model as any) as ThinkingLevel[];
    const fallbackLevel = clampThinkingLevel(model as any, "high") as ThinkingLevel;
    const baseline = resolveThinkingAccess({
      routing: fragment,
      agentType: type,
      modelKey: key,
      parentModelKey: parentKey(),
      parentThinkingLevel: ctx.thinkingLevel,
      scopedThinkingLevel: ctx.model && key === parentKey()
        ? scopedThinkingLevel(ctx.scopedModels, ctx.model)
        : scopedThinkingLevel(ctx.scopedModels, model),
      supportedLevels: supported,
      fallbackLevel,
    });
    const saved = fragment.agentAccess[type]?.thinking?.[key];
    const allowed = new Set<ThinkingLevel>(
      saved?.allowed.filter((level) => supported.includes(level)) ?? baseline?.allowed ?? supported,
    );
    const defaultLevel = saved?.default && allowed.has(saved.default)
      ? saved.default
      : baseline?.default ?? replacementThinkingDefault([...allowed], fallbackLevel);
    return { supported, allowed, defaultLevel };
  };

  const thinkingTargets = (type: string): ModelAccessThinkingTarget[] => {
    const fragment = readModelAccessFragment(io);
    const parent = parentKey();
    const alternates = effectiveAlternateModelKeys(
      type,
      fragment,
      inventory().availableModels.map(modelKey),
      scopedModelKeys(ctx.scopedModels) ? [...scopedModelKeys(ctx.scopedModels)!] : null,
      parent,
    );
    return [
      ...(parent === "" ? [] : [{ key: parent, parent: true }]),
      ...alternates.sort().map((key) => ({ key, parent: false })),
    ];
  };

  const root = (): ModelAccessRootView => {
    const fragment = readModelAccessFragment(io);
    const snapshot = inventory();
    const savedProviders = new Set<string>(fragment.enabledProviders);
    for (const access of Object.values(fragment.agentAccess)) {
      for (const provider of Object.keys(access.providers)) savedProviders.add(provider);
    }
    const unavailableProviders = [...savedProviders]
      .filter((provider) => !snapshot.availableProviders.has(provider))
      .sort()
      .map((provider) => ({
        provider,
        routingEnabled: fragment.enabledProviders.includes(provider),
        ruleTypes: agentTypesForProvider(fragment, provider),
      }));
    return {
      enabled: fragment.enabled,
      parentModelKey: parentKey(),
      enabledProviderCount: effectiveProviders(fragment, snapshot).length,
      configuredAgentCount: Object.keys(fragment.agentAccess).length,
      unavailableProviders,
      unavailableRules: unavailableRules(fragment, snapshot),
    };
  };

  return {
    root,
    agents() {
      const fragment = readModelAccessFragment(io);
      const registered = new Set(registeredTypes());
      const types = [...new Set([...registered, ...Object.keys(fragment.agentAccess)])];
      return agentRows(types, registered);
    },
    quickAgents() {
      const registered = new Set(registeredTypes());
      return agentRows([...registered], registered);
    },
    agentDetail(type): ModelAccessAgentDetailView {
      const fragment = readModelAccessFragment(io);
      const snapshot = inventory();
      const parent = parentKey();
      const state = parent === "" ? undefined : thinkingState(fragment, type, parent);
      return {
        parentModelKey: parent,
        parentAllowed: isParentModelAllowed(fragment, type),
        parentDefaultLevel: state?.defaultLevel ?? "",
        providers: fragment.enabled ? effectiveProviders(fragment, snapshot) : [],
        thinkingTargetCount: thinkingTargets(type).length,
      };
    },
    providers(): ModelAccessProvidersView {
      const fragment = readModelAccessFragment(io);
      const snapshot = inventory();
      return {
        parentModelKey: parentKey(),
        providers: [...snapshot.availableProviders].sort().map((provider) => ({
          provider,
          enabled: fragment.enabledProviders.includes(provider),
        })),
      };
    },
    models(type, provider): ModelAccessModelsView {
      const fragment = readModelAccessFragment(io);
      const rule = Object.hasOwn(fragment.agentAccess, type)
        ? fragment.agentAccess[type]!.providers[provider]
        : undefined;
      const allModels = rule !== undefined && rule.models === undefined;
      const granted = new Set(rule?.models ?? []);
      return {
        parentModelKey: parentKey(),
        allModels,
        models: visibleModelIds(provider).map((id) => ({ id, granted: granted.has(id) })),
      };
    },
    thinkingTargets,
    thinking(type, key): ModelAccessThinkingView {
      const fragment = readModelAccessFragment(io);
      const state = thinkingState(fragment, type, key);
      return {
        levels: state.supported.map((level) => ({
          level,
          allowed: state.allowed.has(level),
          isDefault: level === state.defaultLevel,
        })),
      };
    },

    setEnabled(enabled) {
      return commitModelAccess(io, applyRoutingEnabled(readModelAccessFragment(io), enabled));
    },
    setProviderEnabled(provider, enabled) {
      return commitModelAccess(io, applyProviderEnabled(readModelAccessFragment(io), provider, enabled));
    },
    setParentAccess(type, allowed) {
      return commitModelAccess(io, applyParentModelAccess(readModelAccessFragment(io), type, allowed));
    },
    toggleAllModels(type, provider, quick) {
      const fragment = readModelAccessFragment(io);
      const rule = Object.hasOwn(fragment.agentAccess, type)
        ? fragment.agentAccess[type]!.providers[provider]
        : undefined;
      const allModels = rule !== undefined && rule.models === undefined;
      // Leaving All models restores the previously saved exact list (possibly
      // empty, which deletes the rule) — the same transition the menu used.
      const models = allModels ? rule?.models ?? [] : undefined;
      const next = quick && models === undefined
        ? applyQuickAgentProviderAccess(fragment, type, provider, models)
        : applyAgentProviderAccess(fragment, type, provider, models);
      return commitModelAccess(io, next);
    },
    toggleModel(type, provider, modelId, quick) {
      const fragment = readModelAccessFragment(io);
      const rule = Object.hasOwn(fragment.agentAccess, type)
        ? fragment.agentAccess[type]!.providers[provider]
        : undefined;
      const allModels = rule !== undefined && rule.models === undefined;
      // Unchecking one model under All models first snapshots the visible
      // set, so the remaining grants stay explicit (REQ-MODEL-003).
      const selected = new Set(allModels
        ? snapshotVisibleSelectedModels(visibleModelIds(provider))
        : rule?.models ?? []);
      if (selected.has(modelId)) selected.delete(modelId);
      else selected.add(modelId);
      const models = [...selected].sort();
      const next = quick && models.length > 0
        ? applyQuickAgentProviderAccess(fragment, type, provider, models)
        : applyAgentProviderAccess(fragment, type, provider, models);
      return commitModelAccess(io, next);
    },
    toggleThinkingLevel(type, key, level) {
      const fragment = readModelAccessFragment(io);
      const state = thinkingState(fragment, type, key);
      const target = level as ThinkingLevel;
      if (!state.supported.includes(target)) {
        return { ok: false, message: `${key} does not support thinking level ${level}.` };
      }
      const allowed = new Set(state.allowed);
      let defaultLevel = state.defaultLevel;
      if (allowed.has(target)) {
        if (allowed.size === 1) return { ok: true };
        allowed.delete(target);
        if (defaultLevel === target) {
          defaultLevel = replacementThinkingDefault(
            [...allowed],
            clampThinkingLevel(findModel(key) as any, "high") as ThinkingLevel,
          );
        }
      } else {
        allowed.add(target);
      }
      return commitModelAccess(
        io,
        applyThinkingAccess(fragment, type, key, [...allowed], defaultLevel),
      );
    },
    setThinkingDefault(type, key, level) {
      const fragment = readModelAccessFragment(io);
      const state = thinkingState(fragment, type, key);
      const target = level as ThinkingLevel;
      if (!state.supported.includes(target)) {
        return { ok: false, message: `${key} does not support thinking level ${level}.` };
      }
      const allowed = new Set(state.allowed);
      allowed.add(target);
      return commitModelAccess(io, applyThinkingAccess(fragment, type, key, [...allowed], target));
    },
    resetThinking(type, key) {
      return commitModelAccess(io, applyResetThinkingAccess(readModelAccessFragment(io), type, key));
    },
    deleteProviderRules(provider) {
      return commitModelAccess(io, applyDeleteProviderRules(readModelAccessFragment(io), provider));
    },
    cleanUnavailableRules() {
      // Candidates are recomputed here, not taken from the confirming view,
      // so IDs that became available between gesture and confirmation are
      // never deleted. All providers commit as one fragment (REQ-MODEL-007).
      let fragment = readModelAccessFragment(io);
      const stale = unavailableRules(fragment, inventory());
      const idsByProvider = new Map<string, Set<string>>();
      for (const { provider, modelId } of stale) {
        const ids = idsByProvider.get(provider) ?? new Set<string>();
        ids.add(modelId);
        idsByProvider.set(provider, ids);
      }
      for (const [provider, ids] of idsByProvider) {
        fragment = applyCleanUnavailableModels(fragment, provider, [...ids]);
      }
      return commitModelAccess(io, fragment);
    },
    clearAll() {
      return commitModelAccess(io, applyClearModelAccess());
    },
  };
}
