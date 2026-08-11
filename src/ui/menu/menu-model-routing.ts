/** Model routing access-policy menus. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { getAllTypes } from "../../agents/agent-types.js";
import type { ModelRoutingConfig } from "../../config/types.js";
import { CANONICAL_THINKING_LEVELS } from "../../config/types.js";
import { unavailableModelRules } from "../../models/model-access.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../../models/model-scope.js";
import { resolveThinkingAccess } from "../../models/thinking-access.js";
import { getSupportedThinkingLevels, clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "../../types.js";
import { getStore } from "../../shell.js";
import type { Theme } from "../types.js";
import {
  buildListTheme,
  createDelegatingComponent,
  enableSpaceSelection,
  sectionRow,
  skipNonSelectableRows,
} from "./helpers.js";
import { createConfirmSubmenu, createMultilineConfirmComponent } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

type Store = ReturnType<typeof getStore>;
type ModelRef = { provider: string; id: string };
type RebuildMenu = (preserveSubmenu?: boolean) => void;

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function closingPlaceholder(
  message: string,
  theme: Theme,
  done: (selectedValue?: string) => void,
  onClose: () => void,
): SelectList {
  const list = new SelectList([{ value: "", label: theme.fg("dim", message) }], 1, buildListTheme(theme));
  list.onCancel = () => done();
  queueMicrotask(() => {
    onClose();
    done();
  });
  return list;
}

function defaultModelRow(ctx: ExtensionCommandContext, theme: Theme) {
  return ctx.model
    ? {
        value: "__default__",
        label: theme.fg("dim", `Parent default · ${modelKey(ctx.model)}`),
        description: "",
        nonSelectable: true,
      }
    : {
        value: "__default__",
        label: theme.fg("dim", "Parent default · No active parent model"),
        description: "Unavailable until a parent model is selected",
        nonSelectable: true,
      };
}

interface RegistrySnapshot {
  catalogueModels: ModelRef[];
  availableModels: ModelRef[];
  providers: Set<string>;
  availableProviders: Set<string>;
  catalogueProviders: Set<string>;
  catalogueReliable: boolean;
}

function registrySnapshot(ctx: ExtensionCommandContext, store: Store): RegistrySnapshot {
  const catalogueModels = ctx.modelRegistry.getAll();
  const availableModels = ctx.modelRegistry.getAvailable();
  const availableProviders = new Set(availableModels.map((model) => model.provider));
  const providers = new Set(availableProviders);
  for (const provider of store.routing.enabledProviders) providers.add(provider);
  for (const access of Object.values(store.routing.agentAccess)) {
    for (const provider of Object.keys(access.providers)) providers.add(provider);
  }
  return {
    catalogueModels,
    availableModels,
    providers,
    availableProviders,
    catalogueProviders: new Set(catalogueModels.map((model) => model.provider)),
    catalogueReliable: ctx.modelRegistry.getError() === undefined,
  };
}

function providerModels(models: readonly ModelRef[], provider: string): ModelRef[] {
  return models
    .filter((model) => model.provider === provider)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function providerModelIds(models: readonly ModelRef[], provider: string): Set<string> {
  return new Set(providerModels(models, provider).map((model) => model.id));
}

function configuredAgentCount(store: Store): number {
  return Object.keys(store.routing.agentAccess).length;
}

function providerRuleCount(store: Store, provider: string): number {
  return store.accessTypesForProvider(provider).length;
}

function availableAlternateProviders(
  snapshot: RegistrySnapshot,
  _ctx: ExtensionCommandContext,
): string[] {
  return [...snapshot.availableProviders].sort();
}

function savedUnavailableProviders(
  snapshot: RegistrySnapshot,
  _ctx: ExtensionCommandContext,
): string[] {
  return [...snapshot.providers]
    .filter((provider) => !snapshot.availableProviders.has(provider))
    .sort();
}

interface UnavailableRuleRef {
  provider: string;
  type: string;
  modelId: string;
}

function unavailableRuleRefs(
  routing: Readonly<ModelRoutingConfig>,
  snapshot: RegistrySnapshot,
): UnavailableRuleRef[] {
  if (!snapshot.catalogueReliable) return [];
  const providers = new Set<string>();
  for (const access of Object.values(routing.agentAccess)) {
    for (const provider of Object.keys(access.providers)) providers.add(provider);
  }
  return [...providers].sort().flatMap((provider) => {
    const stale = unavailableModelRules(
      routing,
      provider,
      providerModelIds(snapshot.catalogueModels, provider),
      snapshot.catalogueProviders.has(provider),
      snapshot.catalogueReliable,
    );
    return Object.entries(stale).flatMap(([type, models]) =>
      models.map((modelId) => ({ provider, type, modelId })),
    );
  });
}

function effectiveProviderSet(
  store: Store,
  snapshot: RegistrySnapshot,
  _ctx: ExtensionCommandContext,
): Set<string> {
  return new Set(
    store.routing.enabledProviders.filter((provider) => snapshot.availableProviders.has(provider)),
  );
}

function agentSummary(
  store: Store,
  type: string,
  effectiveProviders: ReadonlySet<string>,
  snapshot: RegistrySnapshot,
  ctx: ExtensionCommandContext,
): string {
  const providers = ownValue(store.routing.agentAccess, type)?.providers;
  if (!providers) return "Parent only";
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  const parentKey = ctx.model ? modelKey(ctx.model) : undefined;
  const summaries = Object.keys(providers)
    .filter((provider) => effectiveProviders.has(provider))
    .sort()
    .flatMap((provider) => {
      const rule = providers[provider];
      const availableIds = providerModelIds(snapshot.availableModels, provider);
      const effectiveIds = (rule.models ?? [...availableIds]).filter((modelId) => {
        const key = `${provider}/${modelId}`;
        return key !== parentKey && availableIds.has(modelId) && (!scopedKeys || scopedKeys.has(key));
      });
      if (effectiveIds.length === 0) return [];
      const access = rule.models
        ? `${effectiveIds.length} model${effectiveIds.length === 1 ? "" : "s"}`
        : "All models";
      return [`${provider} (${access})`];
    });
  return summaries.length > 0 ? summaries.join(" · ") : "Parent only";
}

function enableSpaceAction(list: any, action: (item: any) => void): void {
  const handleInput = list.handleInput.bind(list);
  list.handleInput = (data: string) => {
    if (data === " ") {
      const item = list.items?.[list.selectedIndex ?? 0];
      if (item) action(item);
      return;
    }
    handleInput(data);
  };
}

function enableEnterAction(list: any, action: (item: any) => void): void {
  const handleInput = list.handleInput.bind(list);
  list.handleInput = (data: string) => {
    if (data === "\r" || data === "\n") {
      const item = list.items?.[list.selectedIndex ?? 0];
      if (item) action(item);
      return;
    }
    handleInput(data);
  };
}

function replacementDefault(model: ModelRef, allowed: readonly ThinkingLevel[]): ThinkingLevel {
  const preferred = clampThinkingLevel(model as any, "high") as ThinkingLevel;
  const preferredIndex = CANONICAL_THINKING_LEVELS.indexOf(preferred);
  for (let index = preferredIndex; index < CANONICAL_THINKING_LEVELS.length; index++) {
    const candidate = CANONICAL_THINKING_LEVELS[index];
    if (allowed.includes(candidate)) return candidate;
  }
  for (let index = preferredIndex - 1; index >= 0; index--) {
    const candidate = CANONICAL_THINKING_LEVELS[index];
    if (allowed.includes(candidate)) return candidate;
  }
  return allowed[0]!;
}

function buildThinkingEditor(options: {
  store: Store;
  ctx: ExtensionCommandContext;
  theme: Theme;
  type: string;
  model: ModelRef;
  done: (selectedValue?: string) => void;
  onApplied: RebuildMenu;
}): Component {
  const { store, ctx, theme, type, model, done, onApplied } = options;
  const key = modelKey(model);
  let delegator: ReturnType<typeof createDelegatingComponent>;

  const build = (selectedValue?: string): SelectList => {
    const access = ownValue(store.routing.agentAccess, type);
    const supported = getSupportedThinkingLevels(model as any) as ThinkingLevel[];
    const baseline = resolveThinkingAccess({
      agentAccess: access,
      model: model as any,
      modelKey: key,
      parentModelKey: ctx.model ? modelKey(ctx.model) : "",
      parentThinkingLevel: ctx.thinkingLevel,
      scopedThinkingLevel: scopedThinkingLevel(ctx.scopedModels, model),
    });
    const saved = access?.thinking?.[key];
    const allowed = new Set(saved?.allowed.filter((level) => supported.includes(level)) ?? baseline?.allowed ?? supported);
    let defaultLevel = saved?.default && allowed.has(saved.default)
      ? saved.default
      : baseline?.default ?? replacementDefault(model, [...allowed]);
    const rows: any[] = [
      ...supported.map((level) => {
        const label = `[${allowed.has(level) ? "x" : " "}] ${level}${level === defaultLevel ? " · default" : ""}`;
        return {
          kind: "level",
          value: level,
          label: level === defaultLevel ? theme.bold(theme.fg("accent", label)) : label,
          description: "",
        };
      }),
      { kind: "reset", value: "__reset__", label: "Reset baseline", description: "" },
    ];
    const list = new SelectList(rows, 12, buildListTheme(theme));
    if (selectedValue) {
      const index = rows.findIndex((row) => row.value === selectedValue);
      if (index >= 0) (list as any).selectedIndex = index;
    }
    const persist = (): void => {
      store.mutate.routing.setThinkingAccess(type, key, [...allowed], defaultLevel);
      onApplied(true);
    };
    list.onSelect = (item) => {
      if ((item as any).kind === "reset") {
        store.mutate.routing.resetThinkingAccess(type, key);
        onApplied(true);
        delegator.setActive(build("__reset__"));
        return;
      }
      const level = item.value as ThinkingLevel;
      allowed.add(level);
      defaultLevel = level;
      persist();
      delegator.setActive(build(level));
    };
    enableSpaceAction(list, (item) => {
      if ((item as any).kind !== "level") return;
      const level = item.value as ThinkingLevel;
      if (allowed.has(level)) {
        if (allowed.size === 1) return;
        allowed.delete(level);
        if (defaultLevel === level) defaultLevel = replacementDefault(model, [...allowed]);
      } else {
        allowed.add(level);
      }
      persist();
      delegator.setActive(build(level));
    });
    list.onCancel = () => done();
    return list;
  };

  delegator = createDelegatingComponent(build());
  return delegator;
}

function buildModelEditor(options: {
  store: Store;
  ctx: ExtensionCommandContext;
  theme: Theme;
  snapshot: RegistrySnapshot;
  type: string;
  provider: string;
  quick: boolean;
  done: (selectedValue?: string) => void;
  onApplied: RebuildMenu;
}): Component {
  const { store, ctx, theme, snapshot, type, provider, quick, done, onApplied } = options;
  const agentAccess = ownValue(store.routing.agentAccess, type);
  const existing = agentAccess ? ownValue(agentAccess.providers, provider) : undefined;
  let allModels = existing !== undefined && existing.models === undefined;
  const selected = new Set(existing?.models ?? []);
  const parentId = ctx.model?.provider === provider ? ctx.model.id : undefined;
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  let delegator: ReturnType<typeof createDelegatingComponent>;

  const persist = (): void => {
    const models = [...selected].sort();
    if (quick && (allModels || models.length > 0)) {
      store.mutate.routing.configureAgentProviderAccess(type, provider, allModels ? undefined : models);
    } else {
      store.mutate.routing.setAgentProviderAccess(type, provider, allModels ? undefined : models);
    }
    ctx.ui.notify(quick ? "Quick model setup updated" : `${type} model access updated for ${provider}`, "info");
    onApplied(true);
  };

  const buildList = (selectedRow?: { kind: string; value: string }): SelectList => {
    const modelIds = providerModels(snapshot.availableModels, provider)
      .filter((model) => !scopedKeys || scopedKeys.has(modelKey(model)))
      .map((model) => model.id)
      .filter((modelId) => modelId !== parentId)
      .sort();
    const modelRows = modelIds.length > 0
      ? [
          {
            kind: "all",
            value: "__all__",
            label: `[${allModels ? "x" : " "}] All models`,
            description: "",
          },
          ...modelIds.map((modelId) => ({
            kind: "model",
            value: modelId,
            label: `[${!allModels && selected.has(modelId) ? "x" : " "}] ${modelId}`,
            description: "",
          })),
        ]
      : [{
          kind: "empty",
          value: "",
          label: theme.fg("dim", "No alternate models available"),
          description: "",
        }];
    const rows = [
      defaultModelRow(ctx, theme),
      { value: "__separator__", label: theme.fg("dim", "─".repeat(40)), description: "", nonSelectable: true },
      ...modelRows,
    ];
    const list = new SelectList(rows, 14, buildListTheme(theme));
    skipNonSelectableRows(list, (item) => item?.nonSelectable === true);
    if (selectedRow) {
      const index = rows.findIndex((row) =>
        (row as any).kind === selectedRow.kind && row.value === selectedRow.value,
      );
      if (index >= 0) (list as any).selectedIndex = index;
    }
    list.onSelect = (item) => {
      const kind = (item as any).kind;
      if ((item as any).nonSelectable === true || kind === "empty") return;
      if (kind === "all") {
        allModels = !allModels;
        if (allModels) selected.clear();
        persist();
        delegator.setActive(buildList({ kind, value: item.value }));
        return;
      }
      if (kind === "model") {
        if (allModels) {
          selected.clear();
          for (const modelId of modelIds) selected.add(modelId);
          allModels = false;
        }
        if (selected.has(item.value)) selected.delete(item.value); else selected.add(item.value);
        persist();
        delegator.setActive(buildList({ kind, value: item.value }));
      }
    };
    enableSpaceAction(list, (item) => {
      const kind = (item as any).kind;
      if (kind === "all") {
        allModels = !allModels;
        if (allModels) selected.clear();
        persist();
        delegator.setActive(buildList({ kind, value: item.value }));
        return;
      }
      if (kind !== "model") return;
      if (allModels) {
        selected.clear();
        for (const modelId of modelIds) selected.add(modelId);
        allModels = false;
      }
      if (selected.has(item.value)) selected.delete(item.value); else selected.add(item.value);
      persist();
      delegator.setActive(buildList({ kind, value: item.value }));
    });
    if (!quick) {
      enableEnterAction(list, (item) => {
        if ((item as any).kind !== "model" || (!allModels && !selected.has(item.value))) {
          list.onSelect?.(item);
          return;
        }
        const selectedModel = providerModels(snapshot.availableModels, provider)
          .find((model) => model.id === item.value);
        if (selectedModel) {
          delegator.setActive(buildThinkingEditor({
            store,
            ctx,
            theme,
            type,
            model: selectedModel,
            done,
            onApplied,
          }));
        }
      });
    }
    list.onCancel = () => done();
    return list;
  };

  delegator = createDelegatingComponent(buildList());
  return delegator;
}

function quickSetupSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    if (!ctx.model) {
      ctx.ui.notify("Select a parent model before using Quick model setup", "warning");
      return closingPlaceholder("Parent model unavailable", theme, done, () => {});
    }
    const snapshot = registrySnapshot(ctx, store);
    const effectiveProviders = effectiveProviderSet(store, snapshot, ctx);
    const agents = getAllTypes().sort().map((type) => ({
      value: type,
      label: type,
      description: agentSummary(store, type, effectiveProviders, snapshot, ctx),
    }));
    const list = new SelectList(agents, 10, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => delegator.setActive(buildModelEditor({
      store,
      ctx,
      theme,
      snapshot: registrySnapshot(ctx, store),
      type: item.value,
      provider: ctx.model!.provider,
      quick: true,
      done,
      onApplied: onRebuild,
    }));
    list.onCancel = () => done();
    return delegator;
  };
}

function providerAccessSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    let delegator: ReturnType<typeof createDelegatingComponent>;
    const build = (selectedProvider?: string): SelectList => {
      const providers = availableAlternateProviders(registrySnapshot(ctx, store), ctx);
      const rows: any[] = [
        { ...defaultModelRow(ctx, theme), kind: "default" },
        {
          kind: "separator",
          value: "",
          label: theme.fg("dim", "─".repeat(40)),
          description: "",
          nonSelectable: true,
        },
        ...(providers.length > 0
          ? providers.map((provider) => ({
              kind: "provider",
              provider,
              value: provider,
              label: `[${store.routing.enabledProviders.includes(provider) ? "x" : " "}] ${provider}`,
              description: "",
            }))
          : [{
              kind: "empty",
              value: "",
              label: theme.fg("dim", "No alternate providers available"),
              description: "",
            }]),
      ];
      const list = new SelectList(rows, 12, buildListTheme(theme));
      skipNonSelectableRows(list, (item) => item?.kind === "default" || item?.kind === "separator");
      if (selectedProvider) {
        const index = rows.findIndex((row) => row.kind === "provider" && row.provider === selectedProvider);
        if (index >= 0) (list as any).selectedIndex = index;
      }
      list.onSelect = (rawItem) => {
        const item = rawItem as any;
        if (item.kind !== "provider") return;
        const freshProviders = availableAlternateProviders(registrySnapshot(ctx, store), ctx);
        if (!freshProviders.includes(item.provider)) {
          onRebuild(true);
          delegator.setActive(build());
          return;
        }
        const enabled = store.routing.enabledProviders.includes(item.provider);
        store.mutate.routing.setProviderEnabled(item.provider, !enabled);
        ctx.ui.notify(`${item.provider} ${enabled ? "disabled" : "enabled"} for routed models`, "info");
        onRebuild(true);
        delegator.setActive(build(item.provider));
      };
      enableSpaceSelection(list);
      list.onCancel = () => done();
      return list;
    };
    delegator = createDelegatingComponent(build());
    return delegator;
  };
}

function unavailableProvidersSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    let delegator: ReturnType<typeof createDelegatingComponent>;

    const buildProviders = (selectedProvider?: string): SelectList => {
      const providers = savedUnavailableProviders(registrySnapshot(ctx, store), ctx);
      const rows: any[] = providers.length > 0
        ? providers.map((provider) => {
            const ruleCount = providerRuleCount(store, provider);
            return {
              kind: "provider",
              provider,
              value: provider,
              label: provider,
              description: [
                `Routing ${store.routing.enabledProviders.includes(provider) ? "ON" : "OFF"}`,
                ...(ruleCount > 0
                  ? [`${ruleCount} saved Agent rule${ruleCount === 1 ? "" : "s"}`]
                  : []),
              ].join(" · "),
            };
          })
        : [{
            kind: "empty",
            value: "",
            label: theme.fg("dim", "No saved unavailable providers"),
            description: "",
          }];
      const list = new SelectList(rows, 12, buildListTheme(theme));
      skipNonSelectableRows(list, (item) => item?.kind !== "provider" && item?.kind !== "empty");
      if (selectedProvider) {
        const index = rows.findIndex((row) => row.kind === "provider" && row.provider === selectedProvider);
        if (index >= 0) (list as any).selectedIndex = index;
      }
      list.onSelect = (rawItem) => {
        const item = rawItem as any;
        if (item.kind !== "provider") return;
        const fresh = savedUnavailableProviders(registrySnapshot(ctx, store), ctx);
        if (!fresh.includes(item.provider)) {
          onRebuild(true);
          delegator.setActive(buildProviders());
          return;
        }
        delegator.setActive(buildActions(item.provider));
      };
      list.onCancel = () => done();
      return list;
    };

    const buildActions = (provider: string): Component => {
      const snapshot = registrySnapshot(ctx, store);
      if (!savedUnavailableProviders(snapshot, ctx).includes(provider)) {
        return buildProviders();
      }
      const ruleCount = providerRuleCount(store, provider);
      const items: SettingItem[] = [{
        id: "routing",
        label: provider,
        currentValue: store.routing.enabledProviders.includes(provider) ? "ON" : "OFF",
        values: ["ON", "OFF"],
      }];
      if (ruleCount > 0) {
        items.push({
          id: "deleteRules",
          label: "Delete saved access rules...",
          currentValue: `${ruleCount}`,
          submenu: (_value, subDone) => {
            const freshSnapshot = registrySnapshot(ctx, store);
            const types = store.accessTypesForProvider(provider);
            if (
              !savedUnavailableProviders(freshSnapshot, ctx).includes(provider)
              || types.length === 0
            ) {
              return closingPlaceholder("No saved access rules remain", theme, subDone, () => {
                onRebuild(true);
                delegator.setActive(buildProviders(provider));
              });
            }
            return createMultilineConfirmComponent({
              message: [
                `Delete all saved access rules for ${provider}?`,
                "",
                ...types.map((type) => `- Agent: ${type}`),
              ].join("\n"),
              theme,
              done: subDone,
              onConfirm: () => {
                store.mutate.routing.deleteProviderRules(provider);
                ctx.ui.notify(`Deleted saved ${provider} access rules`, "info");
                onRebuild(true);
                delegator.setActive(buildActions(provider));
              },
            });
          },
        });
      }
      return new SettingsList(items, 12, buildListTheme(theme), (id, value) => {
        if (id !== "routing") return;
        const fresh = savedUnavailableProviders(registrySnapshot(ctx, store), ctx);
        if (!fresh.includes(provider)) {
          onRebuild(true);
          delegator.setActive(buildProviders());
          return;
        }
        store.mutate.routing.setProviderEnabled(provider, value === "ON");
        ctx.ui.notify(`${provider} ${value === "ON" ? "enabled" : "disabled"} for routed models`, "info");
        onRebuild(true);
        delegator.setActive(buildActions(provider));
      }, () => done());
    };

    delegator = createDelegatingComponent(buildProviders());
    return delegator;
  };
}

function cleanUnavailableSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    const candidates = unavailableRuleRefs(store.routing, registrySnapshot(ctx, store));
    if (candidates.length === 0) {
      ctx.ui.notify("No unavailable model rules remain", "info");
      return closingPlaceholder("No unavailable model rules remain", theme, done, onRebuild);
    }
    return createMultilineConfirmComponent({
      message: [
        `Remove ${candidates.length} unavailable model access rule${candidates.length === 1 ? "" : "s"}?`,
        "",
        ...candidates.flatMap(({ provider, type, modelId }) => [
          `- Provider: ${provider}`,
          `  - Agent: ${type}`,
          `    - Model: ${modelId}`,
        ]),
      ].join("\n"),
      theme,
      done,
      onConfirm: () => {
        const stillUnavailable = unavailableRuleRefs(store.routing, registrySnapshot(ctx, store));
        const modelIdsByProvider = new Map<string, Set<string>>();
        for (const { provider, modelId } of stillUnavailable) {
          const ids = modelIdsByProvider.get(provider) ?? new Set<string>();
          ids.add(modelId);
          modelIdsByProvider.set(provider, ids);
        }
        for (const [provider, ids] of modelIdsByProvider) {
          store.mutate.routing.cleanUnavailableModels(provider, [...ids]);
        }
        ctx.ui.notify(`Removed ${stillUnavailable.length} unavailable model access rules`, "info");
        onRebuild();
      },
    });
  };
}

function agentAccessSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    const registered = new Set(getAllTypes());
    const types = [...new Set([...registered, ...Object.keys(store.routing.agentAccess)])].sort();
    const entrySnapshot = registrySnapshot(ctx, store);
    const entryProviders = effectiveProviderSet(store, entrySnapshot, ctx);
    const rows = types.map((type) => ({
      value: type,
      label: registered.has(type) ? type : `${type} (agent unavailable)`,
      description: agentSummary(store, type, entryProviders, entrySnapshot, ctx),
    }));
    const list = new SelectList(rows, 12, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => {
      const type = item.value;
      const snapshot = registrySnapshot(ctx, store);
      const effectiveProviders = effectiveProviderSet(store, snapshot, ctx);
      const access = ownValue(store.routing.agentAccess, type);
      const parentAllowed = access?.parentModelAccess !== false;
      const parentPolicy = ctx.model ? resolveThinkingAccess({
        agentAccess: access,
        model: ctx.model,
        modelKey: modelKey(ctx.model),
        parentModelKey: modelKey(ctx.model),
        parentThinkingLevel: ctx.thinkingLevel,
        scopedThinkingLevel: scopedThinkingLevel(ctx.scopedModels, ctx.model),
      }) : null;
      const providers = store.routing.enabled ? [...effectiveProviders].sort() : [];
      const parentRow = ctx.model
        ? {
            kind: "parent",
            value: "__parent__",
            label: `[${parentAllowed ? "x" : " "}] Use parent model · ${modelKey(ctx.model)} · ${parentPolicy?.default ?? "unavailable"}`,
            description: "",
          }
        : {
            kind: "parent",
            value: "__parent__",
            label: "[ ] Use parent model · No active parent model",
            description: "Unavailable until a parent model is selected",
          };
      const providerRows = [
        parentRow,
        { value: "__separator__", label: theme.fg("dim", "─".repeat(40)), description: "", nonSelectable: true },
        ...providers.map((provider) => ({
          kind: "provider",
          value: provider,
          label: provider,
          description: "",
        })),
      ];
      const providerList = new SelectList(providerRows, 14, buildListTheme(theme));
      skipNonSelectableRows(providerList, (row) => row?.nonSelectable === true);
      providerList.onSelect = (providerItem) => {
        if ((providerItem as any).kind === "parent") {
          if (!ctx.model) return;
          delegator.setActive(buildThinkingEditor({
            store,
            ctx,
            theme,
            type,
            model: ctx.model,
            done,
            onApplied: onRebuild,
          }));
          return;
        }
        if ((providerItem as any).kind !== "provider") return;
        delegator.setActive(buildModelEditor({
          store,
          ctx,
          theme,
          snapshot: registrySnapshot(ctx, store),
          type,
          provider: providerItem.value,
          quick: false,
          done,
          onApplied: onRebuild,
        }));
      };
      enableSpaceAction(providerList, (providerItem) => {
        if ((providerItem as any).kind !== "parent" || !ctx.model) return;
        store.mutate.routing.setParentModelAccess(type, !parentAllowed);
        onRebuild(true);
        list.onSelect?.(item);
      });
      providerList.onCancel = () => done();
      delegator.setActive(providerList);
    };
    list.onCancel = () => done();
    return delegator;
  };
}

export async function showModelRoutingMenu(ctx: ExtensionCommandContext): Promise<void> {
  let rebuild: ((items: SettingItem[], preserveSubmenu?: boolean) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const buildItems = (): SettingItem[] => {
      const store = getStore();
      const routing = store.routing;
      const triggerRebuild: RebuildMenu = (preserveSubmenu = false) => rebuild?.(buildItems(), preserveSubmenu);
      const items: SettingItem[] = [{
        id: "alternateModels",
        label: "Alternate models",
        currentValue: routing.enabled ? "ON" : "OFF",
        values: ["ON", "OFF"],
      }];

      items.push({
        id: "quickSetup",
        label: "Quick model setup",
        currentValue: "",
        submenu: quickSetupSubmenu(store, ctx, theme, triggerRebuild),
      });
      const snapshot = registrySnapshot(ctx, store);
      const mutableProviders = availableAlternateProviders(snapshot, ctx);
      const enabledProviderCount = mutableProviders
        .filter((provider) => routing.enabledProviders.includes(provider))
        .length;
      if (routing.enabled) {
        items.push({
          id: "providerAccess",
          label: "Provider access",
          currentValue: `${enabledProviderCount} enabled`,
          submenu: providerAccessSubmenu(store, ctx, theme, triggerRebuild),
        });
      }
      items.push({
        id: "agentAccess",
        label: "Agent access",
        currentValue: `${configuredAgentCount(store)} configured`,
        submenu: agentAccessSubmenu(store, ctx, theme, triggerRebuild),
      });
      const unavailableProviders = savedUnavailableProviders(snapshot, ctx);
      if (routing.enabled && unavailableProviders.length > 0) {
        items.push({
          id: "savedUnavailableProviders",
          label: "Saved unavailable providers",
          currentValue: String(unavailableProviders.length),
          submenu: unavailableProvidersSubmenu(store, ctx, theme, triggerRebuild),
        });
      }
      const unavailableRules = unavailableRuleRefs(routing, snapshot);
      if (routing.enabled && unavailableRules.length > 0) {
        items.push({
          id: "cleanUnavailableRules",
          label: "Clean unavailable rules",
          currentValue: String(unavailableRules.length),
          submenu: cleanUnavailableSubmenu(store, ctx, theme, triggerRebuild),
        });
      }
      items.push({ id: "__sep__", ...sectionRow() });
      items.push({
        id: "resetAll",
        label: "Reset Model access",
        currentValue: "",
        submenu: createConfirmSubmenu({
          message: "Reset all Model access settings?",
          theme,
          onConfirm: () => {
            store.mutate.routing.clearAll();
            ctx.ui.notify("Model access reset", "info");
            triggerRebuild();
          },
        }),
      });
      return items;
    };

    const settings = new SettingsList(buildItems(), 15, buildListTheme(theme), (id, value) => {
      if (id === "alternateModels") {
        getStore().mutate.routing.setEnabled(value === "ON");
        ctx.ui.notify(`Alternate models ${value === "ON" ? "enabled" : "disabled"}`, "info");
      }
      rebuild?.(buildItems());
    }, () => done(undefined));
    return new SettingsListWrapper(settings, {
      title: "Model Access",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (callback) => { rebuild = callback; },
    });
  });
}
