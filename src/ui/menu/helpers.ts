/**
 * helpers.ts — Shared helpers for the remaining menu modules: section rows
 * and Space-key selection. List theming, framing, and pick-list plumbing
 * live in `platform/pi/tui`.
 */
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

/** Let Space activate the currently selected SelectList row. */
export function enableSpaceSelection(list: any): void {
  const handleInput = list.handleInput.bind(list);
  list.handleInput = (data: string) => {
    if (data === " ") {
      const item = list.items?.[list.selectedIndex ?? 0];
      if (item) list.onSelect?.(item);
      return;
    }
    handleInput(data);
  };
}

