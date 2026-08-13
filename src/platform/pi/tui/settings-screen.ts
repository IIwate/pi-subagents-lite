/**
 * settings-screen.ts — Generic Pi host for the settings module.
 *
 * Translates settings snapshots into Pi list components and Pi input back
 * into serializable settings commands. One `ctx.ui.custom` session renders
 * one page visit; page changes re-enter the loop with a fresh component so
 * no widget state leaks between pages (same lifecycle the menus used).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { buildListTheme, SettingsListWrapper } from "./settings-chrome.js";
import { createNumericSubmenu } from "./numeric-input.js";
import type {
  Settings,
  SettingsResult,
  SettingsSnapshot,
} from "../../../modules/settings/public.js";

export interface SettingsScreenHooks {
  /**
   * Transitional seam: run the monolithic Pi menu for a category that has not
   * migrated into a settings page yet. Deleted with the last legacy menu.
   */
  openLegacyCategory(category: string): Promise<void>;
}

export async function runSettingsScreen(
  ctx: ExtensionCommandContext,
  settings: Settings,
  hooks: SettingsScreenHooks,
): Promise<void> {
  let result = settings.execute({ kind: "open" });
  while (true) {
    if (!result.ok) {
      ctx.ui.notify(result.error.message, "error");
      return;
    }
    if (result.effect?.kind === "close") return;
    if (result.effect?.kind === "open-legacy-category") {
      await hooks.openLegacyCategory(result.effect.category);
      result = settings.execute({ kind: "open" });
      continue;
    }
    result = await renderPageVisit(ctx, settings, result.snapshot);
  }
}

function toSettingItems(snapshot: SettingsSnapshot, ctx: ExtensionCommandContext): SettingItem[] {
  return snapshot.rows.map((row) => {
    const base = {
      id: row.id,
      label: row.label,
      currentValue: row.value ?? "",
      description: row.detail ?? "",
    };
    if (row.kind === "numeric") {
      // Numeric rows edit through an input submenu. The submenu only
      // validates; committing stays on the SettingsList done→onChange path,
      // the same seam every other row kind uses (one commit per submit).
      return {
        ...base,
        submenu: createNumericSubmenu(ctx, {
          min: row.min ?? 0,
          ...(row.fallback !== undefined ? { default: row.fallback } : {}),
        }),
      };
    }
    return { ...base, values: row.choices ? [...row.choices] : [] };
  });
}

/** Render one page until the user picks a category or leaves; returns the next settings result. */
function renderPageVisit(
  ctx: ExtensionCommandContext,
  settings: Settings,
  snapshot: SettingsSnapshot,
): Promise<SettingsResult> {
  return ctx.ui.custom<SettingsResult>((_tui, theme, _kb, done) => {
    const listTheme = buildListTheme(theme);

    if (snapshot.presentation === "menu") {
      const items: SelectItem[] = snapshot.rows.map((row) => ({
        value: row.id,
        label: row.label,
        description: row.detail,
      }));
      const list = new SelectList(items, 10, listTheme);
      list.onSelect = (item) => done(settings.execute({ kind: "select", id: item.value }));
      return new SettingsListWrapper(list, {
        title: snapshot.title,
        theme,
        onCancel: () => done(settings.execute({ kind: "back" })),
      });
    }

    // Form page: value changes are applied in place and the rows are rebuilt
    // from the returned snapshot, so a failed save visibly reverts the widget
    // to the value that is actually persisted.
    let rebuild: ((items: SettingItem[]) => void) | undefined;
    const onChange = (id: string, newValue: string): void => {
      const outcome = settings.execute({ kind: "set-value", id, value: newValue });
      if (!outcome.ok) {
        ctx.ui.notify(outcome.error.message, "error");
        return;
      }
      const notice = outcome.snapshot.notice;
      if (notice) ctx.ui.notify(notice.message, notice.severity);
      rebuild?.(toSettingItems(outcome.snapshot, ctx));
    };
    const list = new SettingsList(
      toSettingItems(snapshot, ctx),
      10,
      listTheme,
      onChange,
      () => done(settings.execute({ kind: "back" })),
    );
    return new SettingsListWrapper(list, {
      title: snapshot.title,
      theme,
      onCancel: () => done(settings.execute({ kind: "back" })),
      onRebuild: (fn) => { rebuild = fn; },
    });
  });
}
