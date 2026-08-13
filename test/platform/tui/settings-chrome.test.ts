/**
 * settings-chrome.test.ts — Contract tests for the shared settings chrome:
 * the SettingsListWrapper frame, non-selectable-row skipping, and the list
 * theme. Runs the real wrapper against minimal fake list components and real
 * pi-tui lists where cursor behavior matters.
 */

import { describe, it, expect, vi } from "vitest";
import { SelectList } from "@earendil-works/pi-tui";
import {
  buildListTheme,
  SettingsListWrapper,
  skipNonSelectableRows,
} from "../../../src/platform/pi/tui/settings-chrome.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const taggingTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

function makeSettingsList(items: any[]) {
  return {
    items,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    selectedIndex: 0,
    render: () => [] as string[],
    handleInput: () => {},
    invalidate: () => {},
  };
}

function makeSelectList(items: any[]) {
  return {
    items,
    onSelect: undefined as ((item: any) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    selectedIndex: 0,
    render: () => [] as string[],
    handleInput: () => {},
  };
}

describe("SettingsListWrapper — Back button removed", () => {
  it("does not append __back__ or __sep__ to SettingsList items", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("does not append __back__ or __sep__ to SelectList items", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.items.map((i) => i.value)).toEqual(["a"]);
  });

  it("does not wrap SelectList.onSelect (passes through to caller)", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    const onSelect = vi.fn();
    list.onSelect = onSelect;
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.onSelect).toBe(onSelect);
  });
});

describe("SettingsListWrapper — close menu via keyboard", () => {
  it("wires SelectList.onCancel so Escape/back-arrow/Ctrl-C close the menu", () => {
    const list = makeSelectList([{ value: "a", label: "A" }]);
    const closeMenu = vi.fn();
    new SettingsListWrapper(list, { title: "T", theme, onCancel: closeMenu });
    expect(typeof list.onCancel).toBe("function");
    list.onCancel!();
    expect(closeMenu).toHaveBeenCalled();
  });

  it("preserves SettingsList.onCancel when provided", () => {
    const onCancel = vi.fn();
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    list.onCancel = onCancel;
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.onCancel).toBe(onCancel);
  });
});

describe("SettingsListWrapper — __sep__ navigation", () => {
  it("selectedIndex never lands on a __sep__ item when moving down", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    expect(list.selectedIndex).toBe(0);
    // down past the separator
    (list as any).selectedIndex = 1;
    expect((list.items as any[])[list.selectedIndex].id).toBe("b");
  });

  it("selectedIndex never lands on a __sep__ item when moving up", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    (list as any).selectedIndex = 2;
    expect((list.items as any[])[list.selectedIndex].id).toBe("b");
    // up past the separator
    (list as any).selectedIndex = 1;
    expect((list.items as any[])[list.selectedIndex].id).toBe("a");
  });

  it("wraps past a trailing separator to the first selectable item", () => {
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "" },
      { id: "b", label: "B", currentValue: "" },
      { id: "__sep__", label: " ", currentValue: "" },
    ]);
    new SettingsListWrapper(list, { title: "T", theme, onCancel: () => {} });
    (list as any).selectedIndex = 1;
    (list as any).selectedIndex = 2;
    expect((list.items as any[])[list.selectedIndex].id).toBe("a");
  });
});

describe("SettingsListWrapper — onRebuild sets items directly", () => {
  it("rebuild replaces items without appending wrapper (__sep__/__back__) items", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]);
    let rebuild: ((items: any[], preserveSubmenu?: boolean) => void) | undefined;
    new SettingsListWrapper(list, {
      title: "T",
      theme,
      onCancel: () => {},
      onRebuild: (r) => { rebuild = r; },
    });
    expect(rebuild).toBeDefined();
    rebuild!([{ id: "x", label: "X", currentValue: "x" }]);
    expect(list.items.map((i) => i.id)).toEqual(["x"]);
    expect(list.filteredItems).toEqual(list.items);
    expect(list.selectedIndex).toBe(0);
  });

  it("keeps the cursor on the previous row when a value correction rebuilds the same rows", () => {
    // A failed save rebuilds the form to revert the widget's value; the user
    // must not be teleported back to the first row while doing so.
    const list = makeSettingsList([
      { id: "a", label: "A", currentValue: "ON" },
      { id: "b", label: "B", currentValue: "ON" },
      { id: "c", label: "C", currentValue: "ON" },
    ]);
    let rebuild: ((items: any[], preserveSubmenu?: boolean) => void) | undefined;
    new SettingsListWrapper(list, {
      title: "T",
      theme,
      onCancel: () => {},
      onRebuild: (r) => { rebuild = r; },
    });
    (list as any).selectedIndex = 2;
    rebuild!([
      { id: "a", label: "A", currentValue: "ON" },
      { id: "b", label: "B", currentValue: "ON" },
      { id: "c", label: "C", currentValue: "OFF" },
    ]);
    expect(list.selectedIndex).toBe(2);
  });

  it("can refresh parent items without detaching an active nested page", () => {
    const list = makeSettingsList([{ id: "a", label: "A", currentValue: "" }]) as any;
    const submenu = { render: () => ["nested"], handleInput: () => {} };
    list.submenuComponent = submenu;
    let rebuild: ((items: any[], preserveSubmenu?: boolean) => void) | undefined;
    new SettingsListWrapper(list, {
      title: "T",
      theme,
      onCancel: () => {},
      onRebuild: (r) => { rebuild = r; },
    });

    rebuild!([{ id: "x", label: "X", currentValue: "" }], true);
    expect(list.submenuComponent).toBe(submenu);
    rebuild!([{ id: "y", label: "Y", currentValue: "" }]);
    expect(list.submenuComponent).toBeNull();
  });
});

describe("SettingsListWrapper — render frame", () => {
  it("renders the list content between top/bottom separators with a header", () => {
    const list = {
      items: [{ id: "a", label: "A", currentValue: "" }] as any[],
      selectedIndex: 0,
      render: () => ["  → A     value"],
      handleInput: () => {},
      invalidate: () => {},
    };
    const wrapper = new SettingsListWrapper(list, { title: "My Title", theme });
    const lines = wrapper.render(40);
    // top separator, blank, header, blank, list content, blank, bottom separator
    expect(lines[0]).toBe("─".repeat(40));
    expect(lines[2]).toBe("  My Title");
    expect(lines[4]).toBe("  → A     value");
    expect(lines[lines.length - 1]).toBe("─".repeat(40));
  });
});

describe("skipNonSelectableRows", () => {
  it("starts on the first selectable row and skips section headers", () => {
    const list = new SelectList([
      { value: "available", label: "Available", nonSelectable: true },
      { value: "anthropic", label: "anthropic" },
      { value: "saved", label: "Saved", nonSelectable: true },
      { value: "__proto__", label: "__proto__" },
    ] as any, 10, buildListTheme(taggingTheme));
    skipNonSelectableRows(list, (item) => item?.nonSelectable === true);

    expect(list.selectedIndex).toBe(1);
    list.handleInput("\x1b[B");
    expect(list.selectedIndex).toBe(3);
    list.handleInput("\x1b[A");
    expect(list.selectedIndex).toBe(1);
    list.handleInput("\x1b[A");
    expect(list.selectedIndex).toBe(3);
    list.handleInput("\x1b[B");
    expect(list.selectedIndex).toBe(1);
  });
});

describe("buildListTheme", () => {
  it("styles selection, values, and hints with the shared accent/muted/dim roles", () => {
    const listTheme = buildListTheme(taggingTheme);
    expect(listTheme.label("test", true)).toBe("[accent:test]");
    expect(listTheme.label("test", false)).toBe("test");
    expect(listTheme.value("val", true)).toBe("[accent:val]");
    expect(listTheme.value("val", false)).toBe("[muted:val]");
    expect(listTheme.description("desc")).toBe("[dim:desc]");
    expect(listTheme.cursor).toBe("[accent:→ ]");
    expect(listTheme.hint("hint")).toBe("[dim:hint]");
    expect(listTheme.selectedPrefix("item")).toBe("[accent:→ ]");
    expect(listTheme.selectedText("text")).toBe("[accent:text]");
    expect(listTheme.scrollInfo("1-5")).toBe("[dim:1-5]");
    expect(listTheme.noMatch("none")).toBe("[dim:none]");
  });
});
