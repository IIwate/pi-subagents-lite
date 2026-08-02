/**
 * confirm-submenu.ts — Yes/no confirm dialog for destructive actions.
 *
 * Creates a submenu factory for SettingsList items that need a confirmation
 * dialog (clear overrides, reset concurrency, etc.).
 */

import { SelectList, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { buildListTheme } from "../helpers.js";

export interface MultilineConfirmOptions {
  message: string;
  theme: Theme;
  onConfirm: () => void;
  onCancel?: () => void;
  done: (selectedValue?: string) => void;
}

/** Real multi-line confirmation; message lines render above the choices. */
export function createMultilineConfirmComponent(options: MultilineConfirmOptions): Component {
  const list = new SelectList(
    [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }],
    5,
    buildListTheme(options.theme),
  );
  list.onSelect = (item) => {
    if (item.value === "Yes") options.onConfirm(); else options.onCancel?.();
    options.done(item.value === "Yes" ? "Yes" : undefined);
  };
  list.onCancel = () => {
    options.onCancel?.();
    options.done();
  };
  return {
    render: (width) => [
      ...options.message.split("\n").flatMap((line) =>
        line
          ? wrapTextWithAnsi(line, Math.max(1, width - 2)).map((part) => options.theme.fg("dim", `  ${part}`))
          : [""],
      ),
      "",
      ...list.render(width),
    ],
    handleInput: (data) => list.handleInput(data),
    invalidate: () => list.invalidate(),
  };
}

export interface ConfirmSubmenuOptions {
  /** Message shown to the user */
  message: string;
  /** Theme from pi-coding-agent (fg, bold) */
  theme: Theme;
  /** Called when user confirms (selects Yes) */
  onConfirm: () => void;
}

/**
 * Creates a submenu factory function compatible with SettingsList's submenu callback.
 * Shows a Yes/No SelectList. Calls onConfirm on Yes, done() to close.
 */
export function createConfirmSubmenu(
  options: ConfirmSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    const items = [
      { value: "Yes", label: "Yes", description: options.message },
      { value: "No", label: "No", description: options.message },
    ];

    const list = new SelectList(items, 5, buildListTheme(options.theme));

    list.onSelect = (item) => {
      if (item.value === "Yes") {
        options.onConfirm();
        done("Yes");
      } else {
        done();
      }
    };
    list.onCancel = () => done();

    return list;
  };
}
