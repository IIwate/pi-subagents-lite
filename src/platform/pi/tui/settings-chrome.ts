/**
 * settings-chrome.ts — Pi list styling and framing shared by every settings
 * surface: the shared list theme, non-selectable-row skipping, and the framed
 * wrapper that adds the title bar, separators, and key translation.
 *
 * Moved from `ui/menu` so `platform/pi/tui` owns all Pi component styling and
 * input translation. The remaining `ui/menu` files import from here until
 * their categories migrate into settings pages.
 */

import { type Component, isFocusable, type SettingsListTheme, type SelectListTheme } from "@earendil-works/pi-tui";

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

/** Keep a list cursor off explicit headers, separators, and locked rows. */
export function skipNonSelectableRows(
  list: any,
  isNonSelectable: (item: any) => boolean,
): void {
  if (!Array.isArray(list.items) || list.items.length === 0) return;
  const rawIndex = Symbol("rawIndex");
  const initialIndex = list.selectedIndex ?? 0;
  const firstSelectableFrom = (start: number, step: number): number => {
    let next = start;
    for (let count = 0; count < list.items.length; count++) {
      next = (next + step + list.items.length) % list.items.length;
      if (!isNonSelectable(list.items[next])) return next;
    }
    return start;
  };
  Object.defineProperty(list, "selectedIndex", {
    get() { return list[rawIndex] ?? 0; },
    set(index) {
      const current = list[rawIndex] ?? initialIndex;
      const clamped = Math.max(0, Math.min(index, list.items.length - 1));
      if (!isNonSelectable(list.items[clamped])) {
        list[rawIndex] = clamped;
        return;
      }
      const wrappedDown = current === list.items.length - 1 && index === 0;
      const wrappedUp = current === 0 && index === list.items.length - 1;
      const step = index === current || wrappedDown ? 1 : wrappedUp || index < current ? -1 : 1;
      list[rawIndex] = firstSelectableFrom(clamped, step);
    },
    configurable: true,
  });
  list.selectedIndex = initialIndex;
}

export interface SettingsListWrapperTheme {
  bold: (text: string) => string;
  fg: (color: any, text: string) => string;
}

export interface SettingsListWrapperOptions {
  title: string;
  theme: SettingsListWrapperTheme;
  onCancel?: () => void;
  /** Called with a rebuild function; nested pages may preserve the active submenu. */
  onRebuild?: (rebuild: (items: any[], preserveSubmenu?: boolean) => void) => void;
}

export class SettingsListWrapper implements Component {
  private settingsList: Component;
  private title: string;
  private theme: SettingsListWrapperTheme;

  constructor(settingsList: Component, options: SettingsListWrapperOptions) {
    this.settingsList = settingsList;
    this.title = options.title;
    this.theme = options.theme;

    const list = this.settingsList as any;

    // SelectList has no onCancel of its own; wire closeMenu so Escape,
    // back-arrow (converted to Escape below), and Ctrl-C close the menu.
    // SettingsList receives its own onCancel at construction, so leave it be.
    if (options.onCancel && !list.onCancel) {
      const closeMenu = options.onCancel;
      list.onCancel = () => closeMenu();
    }

    // Menus use __sep__ for non-selectable section rows.
    if (options.onCancel) {
      skipNonSelectableRows(list, (item) => item?.value === "__sep__" || item?.id === "__sep__");
    }

    // Expose rebuild callback. Items are set directly without appending any
    // wrapper-controlled items: descriptions are read dynamically at render
    // time, so they remain correct after a rebuild. The cursor stays on the
    // clamped previous index so value corrections (e.g. a failed save) do not
    // teleport the user back to the top of the list.
    if (options.onRebuild) {
      const rebuild = (newItems: any[], preserveSubmenu = false) => {
        const previousIndex = list.selectedIndex ?? 0;
        list.items = newItems;
        list.filteredItems = newItems;
        list.selectedIndex = Math.max(0, Math.min(previousIndex, newItems.length - 1));
        if (!preserveSubmenu) list.submenuComponent = null;
      };
      options.onRebuild(rebuild);
    }
  }

  invalidate(): void {
    this.settingsList.invalidate?.();
  }

  private get hasSubmenu(): boolean {
    const submenu = (this.settingsList as any)?.submenuComponent ?? null;
    return isFocusable(submenu);
  }

  handleInput(data: string): void {
    if (data === "k" || data === "j") {
      if (this.hasSubmenu) {
        // Submenu: pass through as normal letters
        this.settingsList.handleInput?.(data);
      } else {
        // Main list: convert to arrow keys
        this.settingsList.handleInput?.(data === "k" ? "\x1b[A" : "\x1b[B");
      }
    } else if (data === "\x1b[C" || data === "\x1bOC" || data === "\x1b[D" || data === "\x1bOD") {
      if (this.hasSubmenu) {
        // Submenu: pass arrow keys through (Input needs them for cursor)
        this.settingsList.handleInput?.(data);
      } else {
        // Main list: → enters, ← escapes
        this.settingsList.handleInput?.(data.includes("C") ? "\r" : "\x1b");
      }
    } else {
      this.settingsList.handleInput?.(data);
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Top separator
    lines.push("─".repeat(width));
    lines.push("");

    // Header (left-aligned with spacing, bold and colored)
    const styledTitle = this.theme.bold(this.theme.fg("accent", this.title));
    lines.push("  " + styledTitle);
    lines.push("");

    // SettingsList content — strip the hint line that pi-tui always appends
    // (empty line + "Enter/Space to change · Esc to cancel"). Descriptions
    // already explain what each item does, so the hint is redundant.
    const settingsLines = this.settingsList.render(width);
    const hintPattern = /Enter\/Space|Esc to cancel/;
    if (settingsLines.length >= 2 && hintPattern.test(settingsLines[settingsLines.length - 1] ?? "")) {
      lines.push(...settingsLines.slice(0, -2));
    } else {
      lines.push(...settingsLines);
    }

    // Bottom separator
    lines.push("");
    lines.push("─".repeat(width));

    return lines;
  }
}
