/**
 * helpers.test.ts — Tests for ui/menu/helpers.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { SelectList, SettingsList } from "@earendil-works/pi-tui";
import { enableSpaceSelection } from "../../../src/ui/menu/helpers.js";
import { buildListTheme } from "../../../src/platform/pi/tui/settings-chrome.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

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
