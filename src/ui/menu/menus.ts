/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 * No nested ctx.ui.custom calls.
 *
 * Module structure:
 *   - helpers.ts: shared helpers (buildListTheme, buildModelOptions, createSearchableSelect)
 *   - menu-model-settings.ts: showModelSettingsMenu
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
import { showModelSettingsMenu } from "./menu-model-settings.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showDebugMenu } from "./menu-debug.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";

/**
 * Render `items` as a titled SelectList and dispatch the chosen value.
 * Re-loops after each dispatch until the user cancels (Esc or Back).
 * Each iteration builds a fresh list so state never leaks between visits.
 */
async function runSelectMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  dispatch: (choice: string) => Promise<void>,
): Promise<void> {
  while (true) {
    const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const list = new SelectList([...items], 10, buildListTheme(theme));
      list.onSelect = (item) => done(item.value);
      return new SettingsListWrapper(list, { title, theme, onCancel: () => done(undefined) });
    });
    if (choice === undefined) return;
    await dispatch(choice);
  }
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SelectItem[] = [
    { value: "model", label: "Model settings", description: "Parent inheritance, cross-provider, and model overrides" },
    { value: "concurrency", label: "Concurrency settings", description: "Set per-model slot limits" },
    { value: "spawnoptions", label: "Spawn options", description: "Default thinking, background, and grace turns" },
    { value: "systemprompt", label: "System prompt", description: "Prompt mode, custom prompt file, AGENTS.md" },
    { value: "display", label: "Display settings", description: "Stats visibility and log display options" },
  ];

  await runSelectMenu(ctx, "Settings", items, async (choice) => {
    switch (choice) {
      case "model": await showModelSettingsMenu(ctx, modelOptions); break;
      case "concurrency": await showConcurrencySettingsMenu(ctx, modelOptions); break;
      case "spawnoptions": await showSpawnOptionsMenu(ctx); break;
      case "systemprompt": await showSystemPromptMenu(ctx); break;
      // Keep the widget-settings function/file name to avoid a history-only rename; the menu now means display settings.
      case "display": await showWidgetSettingsMenu(ctx); break;
    }
  });
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SelectItem[] = [
    { value: "settings", label: "Settings", description: "Model, concurrency, and display settings" },
    { value: "debug", label: "Debug", description: "Agent types, briefing, diagnostics" },
  ];

  await runSelectMenu(ctx, "Agents", items, async (choice) => {
    switch (choice) {
      case "settings": await showSettingsMenu(ctx, modelOptions); break;
      case "debug": await showDebugMenu(ctx); break;
    }
  });
}
