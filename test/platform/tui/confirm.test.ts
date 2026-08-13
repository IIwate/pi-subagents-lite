/**
 * Contract tests for the confirm dialogs — yes/no gates for destructive
 * actions. Drives the real pi-tui SelectList; the factory wires
 * onSelect/onCancel, so tests invoke those callbacks directly.
 */

import { describe, it, expect, vi } from "vitest";
import type { SelectList } from "@earendil-works/pi-tui";
import {
  createConfirmSubmenu,
  createMultilineConfirmComponent,
} from "../../../src/platform/pi/tui/confirm.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function open(
  factory: (currentValue: string, done: (selectedValue?: string) => void) => unknown,
  done: (selectedValue?: string) => void,
): SelectList {
  return factory("", done) as SelectList;
}

describe("createConfirmSubmenu", () => {
  it("renders Yes and No options with the message as description", () => {
    const list = open(createConfirmSubmenu({ message: "Are you sure?", theme, onConfirm: vi.fn() }), vi.fn());
    const text = list.render(80).join("\n");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
    expect(text).toContain("Are you sure?");
  });

  it("calls onConfirm and done('Yes') when Yes is selected", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const list = open(createConfirmSubmenu({ message: "Are you sure?", theme, onConfirm }), done);
    list.onSelect!({ value: "Yes", label: "Yes" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("Yes");
  });

  it("closes without confirming when No is selected", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const list = open(createConfirmSubmenu({ message: "Are you sure?", theme, onConfirm }), done);
    list.onSelect!({ value: "No", label: "No" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("closes without confirming on cancel (Escape)", () => {
    const onConfirm = vi.fn();
    const done = vi.fn();
    const list = open(createConfirmSubmenu({ message: "Are you sure?", theme, onConfirm }), done);
    list.onCancel!();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });
});

describe("createMultilineConfirmComponent", () => {
  it("renders multi-line content above Yes/No", () => {
    const component = createMultilineConfirmComponent({
      message: "Remove rules?\n\n- Explore\n  - retired",
      theme,
      onConfirm: vi.fn(),
      done: vi.fn(),
    });
    const text = component.render(80).join("\n");
    expect(text).toContain("  Remove rules?");
    expect(text).toContain("  - Explore");
    expect(text).toContain("    - retired");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });

  it("confirms through Yes and cancels through onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const done = vi.fn();
    const component = createMultilineConfirmComponent({
      message: "Reset?",
      theme,
      onConfirm,
      onCancel,
      done,
    }) as unknown as { handleInput(data: string): void };
    // Yes is preselected; Enter selects it.
    component.handleInput("\r");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("Yes");
  });
});
