/** Concurrency settings with active-inventory filtering and dormant-limit preservation. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAllTypes } from "../../agents/agent-types.js";
import { DEFAULT_CONCURRENCY } from "../../config/config-io.js";
import { effectiveAlternateModelKeys } from "../../models/model-access.js";
import { modelKey, scopedModelKeys } from "../../models/model-scope.js";
import { getManager, getStore } from "../../shell.js";
import {
  buildListTheme,
  buildModelOptions,
  createDelegatingComponent,
  createSearchableSelect,
} from "./helpers.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { SelectOption } from "../searchable-select.js";
import type { Theme } from "../types.js";

type Store = ReturnType<typeof getStore>;
type LimitKind = "provider" | "model";

type LimitRef = {
  kind: LimitKind;
  key: string;
  limit: number;
};

function activeModelKeys(ctx: ExtensionCommandContext, store: Store): string[] {
  const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  const parentKey = ctx.model ? modelKey(ctx.model) : "";
  const keys = new Set<string>();
  if (parentKey) keys.add(parentKey);

  for (const type of getAllTypes()) {
    for (const key of effectiveAlternateModelKeys(
      type,
      store.routing,
      availableKeys,
      scopedKeys,
      parentKey,
    )) keys.add(key);
  }

  // Accepted sessions remain actionable even after routing or scope changes.
  for (const record of getManager()?.listAgents() ?? []) {
    if (record.execution.modelKey) keys.add(record.execution.modelKey);
  }
  return [...keys].sort();
}

function inactiveLimits(store: Store, activeModels: ReadonlySet<string>, activeProviders: ReadonlySet<string>): LimitRef[] {
  return [
    ...Object.entries(store.concurrency.providers)
      .filter(([provider]) => !activeProviders.has(provider))
      .map(([key, limit]) => ({ kind: "provider" as const, key, limit })),
    ...Object.entries(store.concurrency.models)
      .filter(([model]) => !activeModels.has(model))
      .map(([key, limit]) => ({ kind: "model" as const, key, limit })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

function limitLabel(limit: number): string {
  return `${limit} slot${limit === 1 ? "" : "s"}`;
}

function editOrRemoveSubmenu(options: {
  ctx: ExtensionCommandContext;
  theme: Theme;
  limit: number;
  onEdit: (limit: number) => void;
  onRemove: () => void;
  onRebuild: () => void;
}): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => {
    const list = new SelectList(
      [{ value: "edit", label: "Edit limit" }, { value: "remove", label: "Remove limit" }],
      5,
      buildListTheme(options.theme),
    );
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => {
      if (item.value === "edit") {
        delegator.setActive(createNumericSubmenu(options.ctx, { min: 1 }, (limit) => {
          options.onEdit(limit);
          options.onRebuild();
        })(String(options.limit), done));
        return;
      }
      options.onRemove();
      options.onRebuild();
      done();
    };
    list.onCancel = () => done();
    return delegator;
  };
}

function addLimitSubmenu(options: {
  ctx: ExtensionCommandContext;
  theme: Theme;
  items: SelectOption[];
  onAdd: (key: string, limit: number) => void;
  onRebuild: () => void;
}): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => createSearchableSelect(
    options.items,
    {
      onSelect: (key) => createNumericSubmenu(options.ctx, { min: 1 }, (limit) => {
        options.onAdd(key, limit);
        options.onRebuild();
      })("1", done),
      onCancel: () => done(),
    },
    options.theme,
  );
}

function inactiveLimitsSubmenu(options: {
  ctx: ExtensionCommandContext;
  theme: Theme;
  limits: LimitRef[];
  store: Store;
  onRebuild: () => void;
}): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => {
    const list = new SelectList(
      options.limits.map((limit) => ({
        value: `${limit.kind}:${limit.key}`,
        label: `${limit.kind === "provider" ? "Provider" : "Model"} · ${limit.key} · ${limitLabel(limit.limit)}`,
      })),
      12,
      buildListTheme(options.theme),
    );
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => {
      const limit = options.limits.find((candidate) => `${candidate.kind}:${candidate.key}` === item.value);
      if (!limit) return;
      delegator.setActive(editOrRemoveSubmenu({
        ctx: options.ctx,
        theme: options.theme,
        limit: limit.limit,
        onEdit: (value) => {
          if (limit.kind === "provider") options.store.mutate.concurrency.setProvider(limit.key, value);
          else options.store.mutate.concurrency.setModel(limit.key, value);
          options.ctx.ui.notify(`${limit.key} concurrency set to ${value}`, "info");
        },
        onRemove: () => {
          if (limit.kind === "provider") options.store.mutate.concurrency.removeProvider(limit.key);
          else options.store.mutate.concurrency.removeModel(limit.key);
          options.ctx.ui.notify(`Removed concurrency limit for ${limit.key}`, "info");
        },
        onRebuild: options.onRebuild,
      })(String(limit.limit), done));
    };
    list.onCancel = () => done();
    return delegator;
  };
}

export async function showConcurrencySettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const buildItems = (): SettingItem[] => {
      const store = getStore();
      const models = activeModelKeys(ctx, store);
      const activeModels = new Set(models);
      const activeProviders = new Set(models.map((key) => key.split("/")[0]).filter(Boolean));
      const providerLimits = Object.entries(store.concurrency.providers)
        .filter(([provider]) => activeProviders.has(provider))
        .sort(([a], [b]) => a.localeCompare(b));
      const modelLimits = Object.entries(store.concurrency.models)
        .filter(([model]) => activeModels.has(model))
        .sort(([a], [b]) => a.localeCompare(b));
      const inactive = inactiveLimits(store, activeModels, activeProviders);
      // SettingsList restores its submenu cursor after done(); rebuild on the next microtask
      // so removing the selected row cannot restore an out-of-range index.
      const triggerRebuild = () => queueMicrotask(() => rebuild?.(buildItems()));
      const items: SettingItem[] = [{
        id: "defaultConcurrency",
        label: "Fallback model limit",
        currentValue: `${limitLabel(store.concurrency.default)}${store.concurrency.default === DEFAULT_CONCURRENCY.default ? " · Default" : ""}`,
        description: "Per-model ceiling used when no Model override exists.",
        submenu: (_currentValue, subDone) => createNumericSubmenu(ctx, { min: 1 }, (limit) => {
          store.mutate.concurrency.setDefault(limit);
          ctx.ui.notify(`Fallback model limit set to ${limit}`, "info");
          triggerRebuild();
        })(String(store.concurrency.default), subDone),
      }];

      for (const [provider, limit] of providerLimits) {
        items.push({
          id: `provider:${provider}`,
          label: `Provider · ${provider}`,
          currentValue: limitLabel(limit),
          description: "Shared hard ceiling across this Provider.",
          submenu: editOrRemoveSubmenu({
            ctx,
            theme,
            limit,
            onEdit: (value) => {
              store.mutate.concurrency.setProvider(provider, value);
              ctx.ui.notify(`${provider} concurrency set to ${value}`, "info");
            },
            onRemove: () => {
              store.mutate.concurrency.removeProvider(provider);
              ctx.ui.notify(`Removed Provider limit for ${provider}`, "info");
            },
            onRebuild: triggerRebuild,
          }),
        });
      }

      for (const [model, limit] of modelLimits) {
        items.push({
          id: `model:${model}`,
          label: `Model · ${model}`,
          currentValue: limitLabel(limit),
          description: "Per-model hard ceiling, enforced with any Provider ceiling.",
          submenu: editOrRemoveSubmenu({
            ctx,
            theme,
            limit,
            onEdit: (value) => {
              store.mutate.concurrency.setModel(model, value);
              ctx.ui.notify(`${model} concurrency set to ${value}`, "info");
            },
            onRemove: () => {
              store.mutate.concurrency.removeModel(model);
              ctx.ui.notify(`Removed Model limit for ${model}`, "info");
            },
            onRebuild: triggerRebuild,
          }),
        });
      }

      const addProviders = [...activeProviders]
        .filter((provider) => !Object.hasOwn(store.concurrency.providers, provider))
        .sort();
      if (addProviders.length > 0) {
        items.push({
          id: "addProviderLimit",
          label: "Add Provider limit...",
          currentValue: "",
          submenu: addLimitSubmenu({
            ctx,
            theme,
            items: addProviders.map((provider) => ({ value: provider, label: provider })),
            onAdd: (provider, limit) => {
              store.mutate.concurrency.setProvider(provider, limit);
              ctx.ui.notify(`${provider} concurrency set to ${limit}`, "info");
            },
            onRebuild: triggerRebuild,
          }),
        });
      }

      const addModels = models.filter((model) => !Object.hasOwn(store.concurrency.models, model));
      if (addModels.length > 0) {
        items.push({
          id: "addModelLimit",
          label: "Add Model limit...",
          currentValue: "",
          submenu: addLimitSubmenu({
            ctx,
            theme,
            items: buildModelOptions(addModels),
            onAdd: (model, limit) => {
              store.mutate.concurrency.setModel(model, limit);
              ctx.ui.notify(`${model} concurrency set to ${limit}`, "info");
            },
            onRebuild: triggerRebuild,
          }),
        });
      }

      if (inactive.length > 0) {
        items.push({
          id: "inactiveLimits",
          label: "Saved inactive limits",
          currentValue: String(inactive.length),
          submenu: inactiveLimitsSubmenu({ ctx, theme, limits: inactive, store, onRebuild: triggerRebuild }),
        });
      }

      const isDefault = store.concurrency.default === DEFAULT_CONCURRENCY.default
        && Object.keys(store.concurrency.providers).length === 0
        && Object.keys(store.concurrency.models).length === 0;
      if (!isDefault) {
        items.push({
          id: "resetAll",
          label: "Reset concurrency",
          currentValue: "",
          submenu: createConfirmSubmenu({
            message: "Reset all concurrency limits?",
            theme,
            onConfirm: () => {
              store.mutate.concurrency.reset();
              ctx.ui.notify("Concurrency reset", "info");
              triggerRebuild();
            },
          }),
        });
      }
      return items;
    };

    const settings = new SettingsList(buildItems(), 15, buildListTheme(theme), () => {
      queueMicrotask(() => rebuild?.(buildItems()));
    }, () => done(undefined));
    return new SettingsListWrapper(settings, {
      title: "Concurrency",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (callback) => { rebuild = callback; },
    });
  });
}
