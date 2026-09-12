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
 *   - menu-spawn-options.ts: showSpawnOptionsMenu
 *   - menu-system-prompt.ts: showSystemPromptMenu
 *   - menus.ts (this file): /agents dispatcher and settings entries
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { buildListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { showModelRoutingMenu } from "./menu-model-routing.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";
import type { MenuRuntime } from "./helpers.js";

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

// Note: see .agents/notes/implemented/architecture/2026-09-10-menu-modal-lifecycle.md
export async function showAgentsMenu(
  ctx: ExtensionCommandContext,
  runtime: MenuRuntime,
): Promise<void> {
  // Items refresh per iteration so the routing row reflects live state.
  const buildItems = (): SelectItem[] => {
    if (!runtime.active) return [];
    const routing = runtime.store.routing;
    return [
      { value: "routing", label: "Model routing", description: routing.enabled ? "ON · provider and Agent model access" : "OFF · exact parent only" },
      { value: "concurrency", label: "Concurrency settings", description: `${runtime.store.concurrency.default} slots per model` },
      { value: "spawnoptions", label: "Spawn options", description: "Default thinking, background, and grace turns" },
      { value: "systemprompt", label: "System prompt", description: "Prompt mode, custom prompt file, AGENTS.md" },
      { value: "display", label: "Display settings", description: "List defaults and stats visibility" },
    ];
  };

  await runSelectMenu(ctx, "Agents", buildItems, async (choice) => {
    if (!runtime.active) return;
    switch (choice) {
      case "routing": await showModelRoutingMenu(ctx, runtime); break;
      case "concurrency": await showConcurrencySettingsMenu(ctx, runtime); break;
      case "spawnoptions": await showSpawnOptionsMenu(ctx, runtime); break;
      case "systemprompt": await showSystemPromptMenu(ctx, runtime); break;
      case "display": await showWidgetSettingsMenu(ctx, runtime); break;
    }
  });
}
