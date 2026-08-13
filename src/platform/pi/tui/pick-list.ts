/**
 * pick-list.ts — Searchable pick-list plumbing shared by settings pages and
 * the remaining menus: model-option building, a swappable delegating
 * component, and a searchable select submenu factory.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "./theme.js";
import { SearchableSelectDialog, type SelectOption } from "./searchable-select.js";
import { parseModelKey } from "../../../utils.js";

/**
 * Build SelectOption[] from raw "provider/model-id" strings; plain strings
 * without a provider separator become label-only options (provider lists).
 */
export function buildPickOptions(rawOptions: string[]): SelectOption[] {
  return rawOptions.map((option) => {
    const parsed = parseModelKey(option);
    return parsed
      ? { value: option, label: parsed.modelId, provider: parsed.provider }
      : { value: option, label: option };
  });
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
