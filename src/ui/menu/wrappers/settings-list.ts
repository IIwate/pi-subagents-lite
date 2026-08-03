/**
 * settings-list-wrapper.ts — Frames a list component with a title bar and separators.
 *
 * Wraps a SettingsList or SelectList with:
 * - Top separator line
 * - Header with title
 * - List content (SettingsList renders the highlighted item's description and a
 *   hint line below the items itself; SelectList renders inline descriptions)
 * - Bottom separator line
 *
 * The Back button has been removed. Menus still close via Escape, the
 * back-arrow key, and Ctrl-C — the underlying list components call their
 * `onCancel` on those keys, and the wrapper wires that to `closeMenu` for
 * SelectList (SettingsList receives its own `onCancel` at construction).
 */

import { type Component, isFocusable } from "@earendil-works/pi-tui";
import { skipNonSelectableRows } from "../helpers.js";

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
    // time, so they remain correct after a rebuild.
    if (options.onRebuild) {
      const rebuild = (newItems: any[], preserveSubmenu = false) => {
        list.items = newItems;
        list.filteredItems = newItems;
        list.selectedIndex = 0;
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
