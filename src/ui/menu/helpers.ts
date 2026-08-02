/**
 * helpers.ts — Shared helpers for menu modules:
 * theme builders for SettingsList/SelectList, numeric validation,
 * model-option building, a swappable delegating component, and a
 * searchable pick-list submenu factory.
 */
import type { Component, SettingsListTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { Theme } from "../types.js";
import { SearchableSelectDialog, type SelectOption } from "../searchable-select.js";
import { parseModelKey } from "../../utils.js";
/**
 * Section separator row for SettingsList: a single full-width line with an
 * optional centered title, drawn entirely in the label column so the line
 * stays continuous (the value column is left empty).
 */
export function sectionRow(title?: string): { label: string; currentValue: string } {
  const total = 40;
  const body = title ? ` ${title} ` : "";
  const side = Math.max(0, Math.floor((total - body.length) / 2));
  return {
    label: "─".repeat(side) + body + "─".repeat(Math.max(0, total - side - body.length)),
    currentValue: "",
  };
}

/**
 * Build SelectOption[] from raw "provider/model-id" strings.
 * "(inherits parent)" is appended last — the explicit models come first.
 */
export function buildModelOptions(rawOptions: string[]): SelectOption[] {
  const items: SelectOption[] = [];

  for (const opt of rawOptions) {
    const parsed = parseModelKey(opt);
    if (!parsed) continue;
    items.push({ value: opt, label: parsed.modelId, provider: parsed.provider });
  }
  items.push({ value: "(inherits parent)", label: "(inherits parent)", provider: "" });
  return items;
}

/**
 * Build the shared list theme (SettingsList + SelectList use the same
 * accent/muted/dim visual style; each takes the keys it needs).
 */
export function buildListTheme(theme: { fg(color: string, text: string): string; bold(text: string): string }): SettingsListTheme & SelectListTheme {
  return {
    label: (text, selected) => selected ? theme.fg("accent", text) : text,
    value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text) => theme.fg("dim", text),
    // Use "→ " (2 chars) to match non-selected prefix "  " (2 spaces)
    // This prevents menu items from shifting left/right when cursor moves
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
    selectedPrefix: () => theme.fg("accent", "→ "),
    selectedText: (text) => theme.fg("accent", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("dim", text),
  };
}

/**
 * Create a Component that delegates to a swappable inner component.
 * Use in submenus that switch between SelectList → Input (or similar).
 */
export function createDelegatingComponent(initial: Component): Component & { setActive(c: Component): void; focused?: boolean; items?: any; onSelect?: any; onCancel?: any } {
  let active = initial;
  return {
    invalidate() { active.invalidate?.(); },
    render(width: number) { return active.render(width); },
    handleInput(data: string) { active.handleInput?.(data); },
    setActive(c: Component) { active = c; },
    // Propagate focused to the active child so isFocusable() returns true,
    // which tells SettingsListWrapper to passthrough keys instead of converting them.
    get focused() { return (active as any)?.focused ?? false; },
    set focused(value: boolean) { if ((active as any)?.focused != null) (active as any).focused = value; },
    // Proxy SelectList properties so SettingsListWrapper can add "Back" button.
    get items() { return (active as any)?.items; },
    set items(v: any) { (active as any).items = v; },
    get onSelect() { return (active as any)?.onSelect; },
    set onSelect(v: any) { (active as any).onSelect = v; },
    get onCancel() { return (active as any)?.onCancel; },
    set onCancel(v: any) { (active as any).onCancel = v; },
  };
}

/**
 * Build a searchable pick-list submenu backed by SearchableSelectDialog.
 *
 * Hides the delegator-forward-declaration dance shared by every menu that
 * needs "type to filter, Enter to pick" over a flat option list
 * (provider/model/type/worktree selection). onSelect may return a Component
 * to chain into next (e.g. a numeric-input submenu); returning void leaves
 * the submenu as-is so the caller can close it via done().
 */
export function createSearchableSelect(
  items: SelectOption[],
  callbacks: { onSelect: (value: string) => Component | void; onCancel: () => void },
  theme: Theme,
): Component {
  let delegator: ReturnType<typeof createDelegatingComponent>;
  const selector = new SearchableSelectDialog(
    items,
    null,
    {
      onSelect: (value) => {
        const next = callbacks.onSelect(value);
        if (next) delegator.setActive(next);
      },
      onCancel: callbacks.onCancel,
    },
    theme,
  );
  delegator = createDelegatingComponent(selector);
  return delegator;
}
