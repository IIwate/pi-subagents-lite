/**
 * Tests for createConfirmSubmenu — yes/no dialog for destructive actions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let selectListInstances: Array<{
  items: any[];
  onSelect?: (item: any) => void;
  onCancel?: () => void;
  render: (w: number) => string[];
  handleInput: (d: string) => void;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() { return this.items.map((item) => item.label); }
    handleInput() {}
    invalidate() {}
  },
  wrapTextWithAnsi: (text: string) => [text],
}));

// Avoid loading the real menu-helpers (which pulls in searchable-select and its
// full pi-tui dep graph). Only buildListTheme is needed here.
vi.mock("../../../../src/ui/menu/helpers.js", () => ({
  buildListTheme: () => ({ selectedPrefix: () => "" }),
}));

import { createConfirmSubmenu, createMultilineConfirmComponent } from "../../../../src/ui/menu/submenus/confirm.js";

describe("createConfirmSubmenu", () => {
  beforeEach(() => {
    selectListInstances = [];
  });

  const mockTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
  };

  it("returns a function that creates a SelectList with Yes/No options", () => {
    const factory = createConfirmSubmenu({
      message: "Are you sure?",
      theme: mockTheme,
      onConfirm: vi.fn(),
    });
    expect(typeof factory).toBe("function");

    factory("", vi.fn());
    expect(selectListInstances.length).toBe(1);
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].value).toBe("Yes");
    expect(items[1].value).toBe("No");
  });

  it("calls onConfirm and done when Yes is selected", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const factory = createConfirmSubmenu({ message: "Are you sure?", theme: mockTheme, onConfirm });
    factory("", done);
    selectListInstances[0].onSelect!({ value: "Yes" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("Yes");
  });

  it("calls done without onConfirm when No is selected", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const factory = createConfirmSubmenu({ message: "Are you sure?", theme: mockTheme, onConfirm });
    factory("", done);
    selectListInstances[0].onSelect!({ value: "No" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("calls done without onConfirm on cancel (Escape)", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const factory = createConfirmSubmenu({ message: "Are you sure?", theme: mockTheme, onConfirm });
    factory("", done);
    selectListInstances[0].onCancel!();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("renders real multi-line content above Yes/No", () => {
    const component = createMultilineConfirmComponent({
      message: "Remove rules?\n\n- Explore\n  - retired",
      theme: mockTheme,
      onConfirm: vi.fn(),
      done: vi.fn(),
    });
    expect(component.render(80)).toEqual([
      "  Remove rules?",
      "",
      "  - Explore",
      "    - retired",
      "",
      "Yes",
      "No",
    ]);
  });
});
