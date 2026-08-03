/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 * No nested ctx.ui.custom calls.
 *
 * Module structure:
 *   - helpers.ts: shared helpers (buildListTheme, buildModelOptions, createSearchableSelect)
 *   - menu-model-routing.ts: showModelRoutingMenu
 *   - menu-concurrency.ts: showConcurrencySettingsMenu
 *   - menu-widget-settings.ts: showWidgetSettingsMenu
 *   - menu-debug.ts: showDebugMenu
 *   - menu-spawn-options.ts: showSpawnOptionsMenu
 *   - menu-system-prompt.ts: showSystemPromptMenu
 *   - menus.ts (this file): dispatcher — main menu and settings menu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { buildListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { showModelRoutingMenu } from "./menu-model-routing.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showDebugMenu } from "./menu-debug.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";
import { getStore } from "../../shell.js";

/**
 * Render `items` as a titled SelectList and dispatch the chosen value.
 * Re-loops after each dispatch until the user cancels (Esc or Back).
 * Each iteration builds a fresh list so state never leaks between visits.
 */
async function runSelectMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[] | (() => SelectItem[]),
  dispatch: (choice: string) => Promise<void>,
): Promise<void> {
  while (true) {
    const listItems = typeof items === "function" ? items() : items;
    const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const list = new SelectList([...listItems], 10, buildListTheme(theme));
      list.onSelect = (item) => done(item.value);
      return new SettingsListWrapper(list, { title, theme, onCancel: () => done(undefined) });
    });
    if (choice === undefined) return;
    await dispatch(choice);
  }
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Items refresh per iteration so the routing row reflects live state.
  const buildItems = (): SelectItem[] => {
    const routing = getStore().routing;
    return [
      { value: "routing", label: "Model routing", description: routing.enabled ? "ON · provider and Agent model access" : "OFF · exact parent only" },
      { value: "concurrency", label: "Concurrency settings", description: `${getStore().concurrency.default} slots per model` },
      { value: "spawnoptions", label: "Spawn options", description: "Default thinking, background, and grace turns" },
      { value: "systemprompt", label: "System prompt", description: "Prompt mode, custom prompt file, AGENTS.md" },
      { value: "display", label: "Display settings", description: "Stats visibility and log display options" },
    ];
  };

  await runSelectMenu(ctx, "Settings", buildItems, async (choice) => {
    switch (choice) {
      case "routing": await showModelRoutingMenu(ctx); break;
      case "concurrency": await showConcurrencySettingsMenu(ctx); break;
      case "spawnoptions": await showSpawnOptionsMenu(ctx); break;
      case "systemprompt": await showSystemPromptMenu(ctx); break;
      // Keep the widget-settings function/file name to avoid a history-only rename; the menu now means display settings.
      case "display": await showWidgetSettingsMenu(ctx); break;
    }
  });
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const items: SelectItem[] = [
    { value: "settings", label: "Settings", description: "Model, concurrency, and display settings" },
    { value: "debug", label: "Debug", description: "Agent types, diagnostics, and recovery tests" },
  ];

  await runSelectMenu(ctx, "Agents", items, async (choice) => {
    switch (choice) {
      case "settings": await showSettingsMenu(ctx); break;
      case "debug": await showDebugMenu(ctx); break;
    }
  });
}
