/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { SelectList, SettingsList } from "@earendil-works/pi-tui";

// helpers.ts imports SearchableSelectDialog only for createSearchableSelect;
// these cases never touch it. Mock the dialog so we don't load DynamicBorder/pi.
vi.mock("../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class {},
}));

import {
  buildListTheme,
  buildModelOptions,
  enableSpaceSelection,
  skipNonSelectableRows,
} from "../../../src/ui/menu/helpers.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

describe("buildModelOptions", () => {
  it("returns only explicit registry models", () => {
    const options = buildModelOptions([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);
  });
});

describe("deferred submenu close", () => {
  it("closes a real SettingsList submenu after its factory returns", async () => {
    const theme = buildListTheme(mockTheme);
    const list = new SettingsList([{
      id: "clean",
      label: "Clean",
      currentValue: "1",
      submenu: (_value, done) => {
        const child = new SelectList([{ value: "", label: "No rules remain" }], 1, theme);
        queueMicrotask(() => done());
        return child;
      },
    }], 5, theme, () => {}, () => {});

    list.handleInput("\r");
    expect((list as any).submenuComponent).not.toBeNull();
    await Promise.resolve();
    expect((list as any).submenuComponent).toBeNull();
  });
});

describe("enableSpaceSelection", () => {
  it("activates the current real SelectList row with Space", () => {
    const list = new SelectList([
      { value: "openai", label: "openai" },
      { value: "google", label: "google" },
    ], 10, buildListTheme(mockTheme));
    const selected = vi.fn();
    list.onSelect = selected;
    list.selectedIndex = 1;
    enableSpaceSelection(list);

    list.handleInput(" ");
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ value: "google" }));
  });
});

describe("skipNonSelectableRows", () => {
  it("starts on the first selectable row and skips section headers", () => {
    const list = new SelectList([
      { value: "available", label: "Available", nonSelectable: true },
      { value: "anthropic", label: "anthropic" },
      { value: "saved", label: "Saved", nonSelectable: true },
      { value: "__proto__", label: "__proto__" },
    ] as any, 10, buildListTheme(mockTheme));
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
  it("label applies accent when selected", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.label("test", true)).toBe("[accent:test]");
  });

  it("label returns plain text when not selected", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.label("test", false)).toBe("test");
  });

  it("value uses accent when selected", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.value("val", true)).toBe("[accent:val]");
  });

  it("value uses muted when not selected", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.value("val", false)).toBe("[muted:val]");
  });

  it("description uses dim", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.description("desc")).toBe("[dim:desc]");
  });

  it("cursor uses accent", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.cursor).toBe("[accent:→ ]");
  });

  it("hint uses dim", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.hint("hint")).toBe("[dim:hint]");
  });

  it("selectedPrefix uses accent color and cursor arrow", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.selectedPrefix("item")).toBe("[accent:→ ]");
  });

  it("selectedText uses accent color", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.selectedText("text")).toBe("[accent:text]");
  });

  it("scrollInfo and noMatch use dim", () => {
    const theme = buildListTheme(mockTheme);
    expect(theme.scrollInfo("1-5")).toBe("[dim:1-5]");
    expect(theme.noMatch("none")).toBe("[dim:none]");
  });
});
