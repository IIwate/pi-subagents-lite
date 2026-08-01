/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect, vi } from "vitest";

// helpers.ts imports SearchableSelectDialog only for createSearchableSelect;
// these cases never touch it. Mock the dialog so we don't load DynamicBorder/pi.
vi.mock("../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class {},
}));

import { buildListTheme } from "../../../src/ui/menu/helpers.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

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
