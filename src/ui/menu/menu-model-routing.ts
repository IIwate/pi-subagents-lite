/** Model routing access-policy menus. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { getAllTypes } from "../../agents/agent-types.js";
import type { ProviderModelAccess } from "../../config/types.js";
import { accessSummary, unavailableModelRules } from "../../models/model-access.js";
import { modelKey, scopedModelKeys } from "../../models/model-scope.js";
import { getStore } from "../../shell.js";
import type { Theme } from "../types.js";
import { buildListTheme, createDelegatingComponent, sectionRow } from "./helpers.js";
import { createConfirmSubmenu, createMultilineConfirmComponent } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

type Store = ReturnType<typeof getStore>;
type ModelRef = { provider: string; id: string };
type RebuildMenu = (preserveSubmenu?: boolean) => void;

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function defaultModelRow(ctx: ExtensionCommandContext, theme: Theme) {
  return ctx.model
    ? {
        value: "__default__",
        label: theme.fg("dim", `[✓] Default · ${modelKey(ctx.model)}`),
        description: "",
      }
    : {
        value: "__default__",
        label: theme.fg("dim", "[ ] Default · No active parent model"),
        description: "Unavailable until a parent model is selected",
      };
}

interface RegistrySnapshot {
  models: ModelRef[];
  /** Providers shown in the UI, including saved dormant configuration. */
  providers: Set<string>;
  /** Providers actually present in the loaded registry. */
  presentProviders: Set<string>;
  reliable: boolean;
}

function registrySnapshot(ctx: ExtensionCommandContext, store: Store): RegistrySnapshot {
  const models = ctx.modelRegistry.getAll();
  const presentProviders = new Set(models.map((model) => model.provider));
  for (const provider of ctx.modelRegistry.getRegisteredProviderIds()) presentProviders.add(provider);
  const providers = new Set(presentProviders);
  for (const provider of store.routing.enabledProviders) providers.add(provider);
  for (const access of Object.values(store.routing.agentAccess)) {
    for (const provider of Object.keys(access.providers)) providers.add(provider);
  }
  return { models, providers, presentProviders, reliable: ctx.modelRegistry.getError() === undefined };
}

function providerModels(snapshot: RegistrySnapshot, provider: string): ModelRef[] {
  return snapshot.models
    .filter((model) => model.provider === provider)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function providerRegistryIds(snapshot: RegistrySnapshot, provider: string): Set<string> {
  return new Set(providerModels(snapshot, provider).map((model) => model.id));
}

function configuredAgentCount(store: Store): number {
  return Object.keys(store.routing.agentAccess).length;
}

function providerRuleCount(store: Store, provider: string): number {
  return store.accessTypesForProvider(provider).length;
}

function agentSummary(store: Store, type: string): string {
  const providers = ownValue(store.routing.agentAccess, type)?.providers;
  if (!providers || Object.keys(providers).length === 0) return "Parent only";
  return Object.keys(providers).sort().map((provider) => {
    const rule = providers[provider];
    const value = rule.models ? String(rule.models.length) : "all";
    return `${provider}/${value}`;
  }).join(" · ");
}

function savedProviderSummary(store: Store, provider: string, rule: ProviderModelAccess | undefined): string {
  if (!rule) return "Not configured";
  const summary = accessSummary(rule);
  return store.routing.enabledProviders.includes(provider)
    ? summary
    : `Disabled globally · ${summary === "All models" ? "All models saved" : summary.replace(" model", " saved model")}`;
}

function modelStatus(
  store: Store,
  snapshot: RegistrySnapshot,
  scopedKeys: ReadonlySet<string> | null,
  provider: string,
  modelId: string,
  authorized: boolean,
): string {
  if (!store.routing.enabledProviders.includes(provider)) return "Provider disabled";
  const key = `${provider}/${modelId}`;
  if (!providerRegistryIds(snapshot, provider).has(modelId)) {
    return snapshot.reliable && snapshot.presentProviders.has(provider) ? "Unavailable" : "Saved rule";
  }
  if (scopedKeys && !scopedKeys.has(key)) return "Out of current scope";
  return authorized ? "Active" : "Available";
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
  onApplied: () => void;
}): Component {
  const { store, ctx, theme, snapshot, type, provider, quick, done, onApplied } = options;
  const agentAccess = ownValue(store.routing.agentAccess, type);
  const existing = agentAccess ? ownValue(agentAccess.providers, provider) : undefined;
  let allModels = existing !== undefined && existing.models === undefined;
  const selected = new Set(existing?.models ?? []);
  const parentId = ctx.model?.provider === provider ? ctx.model.id : undefined;
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  let delegator: ReturnType<typeof createDelegatingComponent>;

  const buildList = (): SelectList => {
    const known = new Set(providerModels(snapshot, provider).map((model) => model.id));
    for (const modelId of selected) known.add(modelId);
    if (parentId) known.delete(parentId);

    const rows = [
      defaultModelRow(ctx, theme),
      { value: "__separator__", label: theme.fg("dim", "─".repeat(40)), description: "" },
      {
        value: "__all__",
        label: `[${allModels ? "x" : " "}] All alternate models`,
        description: allModels ? "Includes future registry models" : "Use exact model rules",
      },
      ...[...known].sort().map((modelId) => ({
        value: modelId,
        label: `[${!allModels && selected.has(modelId) ? "x" : " "}] ${modelId}`,
        description: modelStatus(store, snapshot, scopedKeys, provider, modelId, allModels || selected.has(modelId)),
      })),
      { value: "__apply__", label: quick ? "Apply quick setup" : "Apply model access", description: "Save this provider rule" },
    ];
    const list = new SelectList(rows, 14, buildListTheme(theme));
    list.onSelect = (item) => {
      if (item.value === "__default__" || item.value === "__separator__") return;
      if (item.value === "__all__") {
        allModels = !allModels;
        if (allModels) selected.clear();
        delegator.setActive(buildList());
        return;
      }
      if (item.value !== "__apply__") {
        allModels = false;
        if (selected.has(item.value)) selected.delete(item.value); else selected.add(item.value);
        delegator.setActive(buildList());
        return;
      }

      const models = [...selected].sort();
      if (!quick) {
        store.mutate.routing.setAgentProviderAccess(type, provider, allModels ? undefined : models);
        ctx.ui.notify(`${type} model access updated for ${provider}`, "info");
        onApplied();
        done("applied");
        return;
      }

      const lines = ["Apply model access?", ""];
      if (allModels || models.length > 0) {
        lines.push("- Enable Model routing", `- Enable ${provider} for routed models`, `- ${type} may use:`);
        lines.push(...(allModels ? [`  - ${provider}/*`] : models.map((modelId) => `  - ${provider}/${modelId}`)));
      } else {
        lines.push(`- Remove ${type}/${provider} alternate access`);
      }
      delegator.setActive(createMultilineConfirmComponent({
        message: lines.join("\n"),
        theme,
        done,
        onConfirm: () => {
          if (allModels || models.length > 0) {
            store.mutate.routing.configureAgentProviderAccess(type, provider, allModels ? undefined : models);
          } else {
            store.mutate.routing.setAgentProviderAccess(type, provider, []);
          }
          ctx.ui.notify("Quick model setup applied", "info");
          onApplied();
        },
      }));
    };
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
  snapshot: RegistrySnapshot,
  onRebuild: () => void,
): SettingItem["submenu"] {
  return (_value, done) => {
    if (!ctx.model) {
      ctx.ui.notify("Select a parent model before using Quick model setup", "warning");
      done();
      return new SelectList([], 1, buildListTheme(theme));
    }
    const agents = getAllTypes().sort().map((type) => ({ value: type, label: type, description: agentSummary(store, type) }));
    const list = new SelectList(agents, 10, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => delegator.setActive(buildModelEditor({
      store,
      ctx,
      theme,
      snapshot,
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

function providerMaintenance(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  provider: string,
  done: (selectedValue?: string) => void,
  onRebuild: RebuildMenu,
): Component {
  let delegator: ReturnType<typeof createDelegatingComponent>;
  const build = (): SettingsList => {
    const routing = store.routing;
    const snapshot = registrySnapshot(ctx, store);
    const stale = unavailableModelRules(
      routing,
      provider,
      providerRegistryIds(snapshot, provider),
      snapshot.presentProviders.has(provider),
      snapshot.reliable,
    );
    const staleCount = Object.values(stale).reduce((sum, models) => sum + models.length, 0);
    const types = store.accessTypesForProvider(provider);
    const items: SettingItem[] = [
      {
        id: "enabled",
        label: "Enabled",
        currentValue: routing.enabledProviders.includes(provider) ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      { id: "agentAccess", label: "Agent access", currentValue: `${types.length} configured` },
      { id: "unavailable", label: "Unavailable model rules", currentValue: String(staleCount) },
    ];
    if (staleCount > 0) {
      items.push({
        id: "cleanUnavailable",
        label: "Clean unavailable rules...",
        currentValue: "",
        submenu: (_value, subDone) => createMultilineConfirmComponent({
          message: [
            `Remove ${staleCount} unavailable ${provider} model rules?`,
            "",
            ...Object.entries(stale).flatMap(([type, models]) => [
              `- ${type}`,
              ...models.map((modelId) => `  - ${modelId}`),
              "",
            ]),
          ].join("\n").trimEnd(),
          theme,
          done: subDone,
          onConfirm: () => {
            const fresh = registrySnapshot(ctx, store);
            const stillStale = unavailableModelRules(
              store.routing,
              provider,
              providerRegistryIds(fresh, provider),
              fresh.presentProviders.has(provider),
              fresh.reliable,
            );
            const staleRules = Object.values(stillStale).flat();
            store.mutate.routing.cleanUnavailableModels(provider, [...new Set(staleRules)]);
            ctx.ui.notify(`Removed ${staleRules.length} unavailable model rules`, "info");
            onRebuild(true);
            delegator.setActive(build());
          },
        }),
      });
    }
    if (types.length > 0) {
      items.push({
        id: "deleteRules",
        label: "Delete saved access rules...",
        currentValue: "",
        submenu: (_value, subDone) => createMultilineConfirmComponent({
          message: [
            `Delete all saved ${provider} access rules for:`,
            ...types.map((type) => `- ${type}`),
            "",
            "Continue?",
          ].join("\n"),
          theme,
          done: subDone,
          onConfirm: () => {
            store.mutate.routing.deleteProviderRules(provider);
            ctx.ui.notify(`Deleted saved ${provider} access rules`, "info");
            onRebuild(true);
            delegator.setActive(build());
          },
        }),
      });
    }
    return new SettingsList(items, 12, buildListTheme(theme), (id, value) => {
      if (id !== "enabled") return;
      store.mutate.routing.setProviderEnabled(provider, value === "ON");
      ctx.ui.notify(`${provider} ${value === "ON" ? "enabled" : "disabled"} for routed models`, "info");
      onRebuild(true);
      delegator.setActive(build());
    }, () => done());
  };
  delegator = createDelegatingComponent(build());
  return delegator;
}

function enabledProvidersSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  snapshot: RegistrySnapshot,
  onRebuild: RebuildMenu,
): SettingItem["submenu"] {
  return (_value, done) => {
    const rows = [...snapshot.providers].sort().map((provider) => ({
      value: provider,
      label: `${provider}  [${store.routing.enabledProviders.includes(provider) ? "x" : " "}]`,
      description: `${providerRuleCount(store, provider)} saved Agent rules`,
    }));
    const list = new SelectList(rows, 12, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => delegator.setActive(providerMaintenance(
      store, ctx, theme, item.value, done, onRebuild,
    ));
    list.onCancel = () => done();
    return delegator;
  };
}

function agentAccessSubmenu(
  store: Store,
  ctx: ExtensionCommandContext,
  theme: Theme,
  snapshot: RegistrySnapshot,
  onRebuild: () => void,
): SettingItem["submenu"] {
  return (_value, done) => {
    const registered = new Set(getAllTypes());
    const types = [...new Set([...registered, ...Object.keys(store.routing.agentAccess)])].sort();
    const rows = types.map((type) => ({
      value: type,
      label: registered.has(type) ? type : `${type} (agent unavailable)`,
      description: agentSummary(store, type),
    }));
    const list = new SelectList(rows, 12, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => {
      const type = item.value;
      const rules = ownValue(store.routing.agentAccess, type)?.providers ?? {};
      const providerRows = [
        defaultModelRow(ctx, theme),
        { value: "__separator__", label: theme.fg("dim", "─".repeat(40)), description: "" },
        ...[...new Set([...snapshot.providers, ...Object.keys(rules)])].sort().map((provider) => ({
          value: provider,
          label: provider,
          description: savedProviderSummary(store, provider, rules[provider]),
        })),
      ];
      const providerList = new SelectList(providerRows, 14, buildListTheme(theme));
      providerList.onSelect = (providerItem) => {
        if (providerItem.value === "__default__" || providerItem.value === "__separator__") return;
        delegator.setActive(buildModelEditor({
          store,
          ctx,
          theme,
          snapshot,
          type,
          provider: providerItem.value,
          quick: false,
          done,
          onApplied: onRebuild,
        }));
      };
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
      const snapshot = registrySnapshot(ctx, store);
      const triggerRebuild: RebuildMenu = (preserveSubmenu = false) => rebuild?.(buildItems(), preserveSubmenu);
      const items: SettingItem[] = [{
        id: "enabled",
        label: "Enabled",
        currentValue: routing.enabled ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "OFF permits only the exact parent model.",
      }];

      if (!routing.enabled) {
        items.push({ id: "__space__", label: " ", currentValue: "" });
        items.push({ id: "__parent__", label: "Subagents use the exact parent model.", currentValue: "" });
        return items;
      }

      items.push({
        id: "quickSetup",
        label: "Quick model setup",
        currentValue: "",
        description: "Grant one Agent access to alternate models from the current parent provider.",
        submenu: quickSetupSubmenu(store, ctx, theme, snapshot, triggerRebuild),
      });
      const providers = [...routing.enabledProviders].sort();
      items.push({
        id: "enabledProviders",
        label: "Enabled providers",
        currentValue: providers.length ? providers.join(", ") : "None",
        submenu: enabledProvidersSubmenu(store, ctx, theme, snapshot, triggerRebuild),
      });
      items.push({
        id: "agentAccess",
        label: "Agent model access",
        currentValue: `${configuredAgentCount(store)} configured`,
        submenu: agentAccessSubmenu(store, ctx, theme, snapshot, triggerRebuild),
      });
      items.push({ id: "__sep__", ...sectionRow() });
      items.push({
        id: "clearAll",
        label: "Clear routing settings",
        currentValue: "",
        submenu: createConfirmSubmenu({
          message: "Clear all Model routing settings?",
          theme,
          onConfirm: () => {
            store.mutate.routing.clearAll();
            ctx.ui.notify("Routing settings cleared", "info");
            triggerRebuild();
          },
        }),
      });
      return items;
    };

    const settings = new SettingsList(buildItems(), 15, buildListTheme(theme), (id, value) => {
      if (id === "enabled") {
        getStore().mutate.routing.setEnabled(value === "ON");
        ctx.ui.notify(`Model routing ${value === "ON" ? "enabled" : "disabled"}`, "info");
      }
      rebuild?.(buildItems());
    }, () => done(undefined));
    return new SettingsListWrapper(settings, {
      title: "Model Routing",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (callback) => { rebuild = callback; },
    });
  });
}
