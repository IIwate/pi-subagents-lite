/**
 * menu-model-routing.ts — Cross-provider routing menu concern.
 *
 * Three concepts, one policy: the routing switch (OFF = strict parent
 * inheritance), the allowed-provider allowlist (parent provider is implicit),
 * and per-agent model assignments (session or permanent). No global default,
 * no per-type override terminology.
 *
 * Exports:
 *   - showModelRoutingMenu: routing switch, allowed providers, assignments
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { Theme } from "../types.js";
import { buildListTheme, createDelegatingComponent, createSearchableSelect } from "./helpers.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";
import { parseModelKey } from "../../utils.js";

/** Unique providers present in the current model options (registry/scope). */
function providersFromModelOptions(modelOptions: string[]): string[] {
  const providers = new Set<string>();
  for (const opt of modelOptions) {
    const parsed = parseModelKey(opt);
    if (parsed) providers.add(parsed.provider);
  }
  return [...providers];
}

/** Agent types with a session or persistent assignment. */
function assignedTypes(store: ReturnType<typeof getStore>): string[] {
  return getAllTypes().filter((type) =>
    store.sessionModelOverride(type) != null || store.routing.agentModels[type] != null,
  );
}

/** Agent types whose assignment (session or persistent) resolves to the given provider. */
function assignmentTypesForProvider(
  store: ReturnType<typeof getStore>,
  provider: string,
): string[] {
  return getAllTypes().filter((type) => {
    const session = store.sessionModelOverride(type);
    const persistent = store.routing.agentModels[type];
    for (const ref of [session, persistent]) {
      if (!ref) continue;
      const parsed = parseModelKey(ref);
      if (parsed?.provider === provider) return true;
    }
    return false;
  });
}

/** Filter model options to the parent provider plus allowed providers. */
function modelsForAssignment(
  modelOptions: string[],
  parentProvider: string,
  allowedProviders: string[],
): string[] {
  return modelOptions.filter((opt) => {
    const parsed = parseModelKey(opt);
    if (!parsed) return false;
    return parsed.provider === parentProvider || allowedProviders.includes(parsed.provider);
  });
}

export async function showModelRoutingMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Build menu items from current store state.
  const buildItems = (
    store: ReturnType<typeof getStore>,
    theme: Theme,
    onRebuild: () => void,
  ): SettingItem[] => {
    const parentProvider = ctx.model?.provider ?? "";
    const items: SettingItem[] = [];

    items.push({
      id: "enabled",
      label: "Enabled",
      currentValue: store.routing.enabled ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "OFF: subagents use the exact parent model; assignments, frontmatter models, and explicit model arguments are rejected.",
    });

    if (!store.routing.enabled) {
      // OFF: nothing to configure — strict parent inheritance.
      items.push({ id: "__sep__", label: " ", currentValue: "" });
      items.push({ id: "__sep__", label: "Subagents use the exact parent model.", currentValue: "" });
      return items;
    }

    // ON: provider allowlist summary
    const allowed = [...store.routing.allowedProviders].sort();
    items.push({
      id: "allowedProviders",
      label: "Allowed providers",
      currentValue: allowed.length > 0 ? allowed.join(", ") : "(parent only)",
      description: "Extra providers subagents may use. The parent provider is always available.",
      submenu: allowedProvidersSubmenu(store, theme, parentProvider, modelOptions, onRebuild),
    });

    // ON: assignments summary
    const count = assignedTypes(store).length;
    items.push({
      id: "agentModels",
      label: "Agent model assignments",
      currentValue: count > 0 ? `${count} configured` : "None",
      description: "Per-agent model choices. Unassigned agents inherit the parent model.",
      submenu: assignmentsSubmenu(store, ctx, theme, modelOptions, onRebuild),
    });

    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({
      id: "clearAll",
      label: "Clear routing settings",
      currentValue: "",
      description: "Clear the provider allowlist and all assignments, and disable routing.",
      submenu: createConfirmSubmenu({
        message: "Clear all routing settings?",
        theme,
        onConfirm: () => {
          store.mutate.routing.clearAll();
          ctx.ui.notify("Routing settings cleared", "info");
          onRebuild();
        },
      }),
    });

    return items;
  };

  /**
   * Provider allowlist submenu. The parent provider row is informational and
   * cannot be toggled. Removing an allowed provider that has assignments asks
   * for confirmation and clears session + persistent assignments on confirm.
   */
  const allowedProvidersSubmenu = (
    store: ReturnType<typeof getStore>,
    theme: Theme,
    parentProvider: string,
    modelOptions: string[],
    onRebuild: () => void,
  ): SettingItem["submenu"] => (_currentValue, subDone) => {
    const available = providersFromModelOptions(modelOptions);
    // Saved providers absent from the current registry/scope are marked unavailable.
    const unavailable = store.routing.allowedProviders.filter((p) => !available.includes(p));

    const rows: Array<{ value: string; label: string; description: string }> = [];
    if (parentProvider) {
      rows.push({
        value: parentProvider,
        label: parentProvider,
        description: "Parent provider · always available",
      });
    }
    for (const provider of available) {
      if (provider === parentProvider) continue;
      const isAllowed = store.routing.allowedProviders.includes(provider);
      rows.push({
        value: provider,
        label: `${provider}  [${isAllowed ? "x" : " "}]`,
        description: isAllowed ? "Allowed · select to remove" : "Not allowed · select to add",
      });
    }
    for (const provider of unavailable) {
      rows.push({
        value: provider,
        label: `${provider}  [x]`,
        description: "Not available in the current model scope · select to remove",
      });
    }

    const list = new SelectList(rows, 10, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);

    const confirmRemoval = (provider: string, types: string[]): Component => {
      const message = `Removing ${provider} will clear assignments for: ${types.join(", ")}. Continue?`;
      const confirmList = new SelectList(
        [
          { value: "Yes", label: "Yes", description: message },
          { value: "No", label: "No", description: message },
        ],
        5,
        buildListTheme(theme),
      );
      confirmList.onSelect = (item) => {
        if (item.value === "Yes") {
          store.mutate.routing.removeProvider(provider);
          for (const type of types) store.mutate.session.clearOverride(type);
          ctx.ui.notify(`Removed ${provider} and cleared its assignments`, "info");
        } else {
          ctx.ui.notify(`${provider} unchanged`, "info");
        }
        subDone();
        onRebuild();
      };
      confirmList.onCancel = () => subDone();
      return confirmList;
    };

    list.onSelect = (item) => {
      const provider = item.value;
      if (provider === parentProvider) {
        ctx.ui.notify(`The parent provider ${parentProvider} is always available`, "info");
        return;
      }
      const isAllowed = store.routing.allowedProviders.includes(provider);
      if (isAllowed) {
        const types = assignmentTypesForProvider(store, provider);
        if (types.length > 0) {
          delegator.setActive(confirmRemoval(provider, types));
          return;
        }
        store.mutate.routing.setProviderAllowed(provider, false);
        ctx.ui.notify(`${provider} removed from allowed providers`, "info");
      } else {
        store.mutate.routing.setProviderAllowed(provider, true);
        ctx.ui.notify(`${provider} added to allowed providers`, "info");
      }
      subDone();
      onRebuild();
    };
    list.onCancel = () => subDone();
    return delegator;
  };

  /**
   * Assignments submenu: one row per agent type plus "Assign another agent..."
   * for unassigned types. Row selection opens the 2-step model flow
   * (model → session/permanent); "(inherits parent)" clears the assignment.
   */
  const assignmentsSubmenu = (
    store: ReturnType<typeof getStore>,
    ctx: ExtensionCommandContext,
    theme: Theme,
    modelOptions: string[],
    onRebuild: () => void,
  ): SettingItem["submenu"] => (_currentValue, subDone) => {
    const parentProvider = ctx.model?.provider ?? "";
    const filteredModels = modelsForAssignment(modelOptions, parentProvider, store.routing.allowedProviders);

    const assignmentOnSelect = (typeName: string) => (mode: "session" | "permanent" | "clear", model: string | null) => {
      if (mode === "clear") {
        store.mutate.routing.setAgentModel(typeName, null);
        store.mutate.session.clearOverride(typeName);
        ctx.ui.notify(`${typeName} assignment cleared`, "info");
        onRebuild();
        return;
      }
      const effective = model === "(inherits parent)" ? null : model;
      if (mode === "session") {
        if (effective === null) {
          // "(inherits parent)" in session mode means restore parent inheritance.
          // A session null cannot shadow a persistent assignment, so both are cleared.
          store.mutate.routing.setAgentModel(typeName, null);
          store.mutate.session.clearOverride(typeName);
        } else {
          store.mutate.session.setOverride(typeName, effective);
        }
      } else {
        store.mutate.routing.setAgentModel(typeName, effective);
      }
      ctx.ui.notify(
        effective === null
          ? `${typeName} inherits parent model`
          : `${typeName} model set to ${effective}`,
        "info",
      );
      onRebuild();
    };

    const typeEntries = getAllTypes().map((typeName) => {
      const cfg = getAgentConfig(typeName);
      const session = store.sessionModelOverride(typeName);
      const persistent = store.routing.agentModels[typeName];
      const effective = store.modelSelectionFor(typeName, "(inherits parent)", cfg).model;
      return { typeName, cfg, session, persistent, effective };
    });

    const rows: Array<{ value: string; label: string; description: string }> = [];
    for (const entry of typeEntries) {
      rows.push({
        value: entry.typeName,
        label: entry.typeName,
        description: entry.session
          ? `${entry.session} [session]`
          : entry.persistent ?? entry.effective,
      });
    }

    const unassigned = typeEntries.filter((e) => e.session == null && e.persistent == null);
    if (unassigned.length > 0) {
      rows.push({
        value: "__assign__",
        label: "Assign another agent...",
        description: "Assign a model to an agent that currently inherits the parent model",
      });
    }

    const list = new SelectList(rows, 10, buildListTheme(theme));
    const delegator = createDelegatingComponent(list);

    list.onSelect = (item) => {
      if (item.value === "__assign__") {
        delegator.setActive(createSearchableSelect(
          unassigned.map((e) => ({ value: e.typeName, label: e.typeName })),
          {
            onSelect: (typeName) => {
              const entry = unassigned.find((e) => e.typeName === typeName)!;
              return createModelSelectSubmenu({
                modelOptions: filteredModels,
                showClear: false,
                theme,
                onSelect: assignmentOnSelect(entry.typeName),
              })(entry.effective, subDone);
            },
            onCancel: () => subDone(),
          },
          theme,
        ));
        return;
      }
      const entry = typeEntries.find((e) => e.typeName === item.value)!;
      delegator.setActive(createModelSelectSubmenu({
        modelOptions: filteredModels,
        showClear: entry.persistent != null,
        theme,
        onSelect: assignmentOnSelect(entry.typeName),
      })(entry.effective, subDone));
    };
    list.onCancel = () => subDone();
    return delegator;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const triggerRebuild = () => rebuild?.(buildItems(getStore(), theme, triggerRebuild));
    const store = getStore();
    const items = buildItems(store, theme, triggerRebuild);

    const settingsList = new SettingsList(items, 15, buildListTheme(theme), (id, newValue) => {
      if (id === "enabled") {
        const enabled = newValue === "ON";
        store.mutate.routing.setEnabled(enabled);
        ctx.ui.notify(`Cross-provider routing ${enabled ? "enabled" : "disabled"}`, "info");
      }
      triggerRebuild();
    }, () => done(undefined));
    return new SettingsListWrapper(settingsList, {
      title: "Cross-provider Routing",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => { rebuild = r; },
    });
  });
}
