/**
 * Contract tests for createNumericSubmenu — the shared numeric input submenu.
 * Drives the real pi-tui Input component: the factory wires onSubmit/onEscape,
 * so tests invoke those callbacks directly instead of mocking the package.
 */

import { describe, it, expect, vi } from "vitest";
import type { Input } from "@earendil-works/pi-tui";
import { createNumericSubmenu } from "../../../src/platform/pi/tui/numeric-input.js";

function mockCtx() {
  return { ui: { notify: vi.fn() } } as any;
}

function open(
  factory: (initialValue: string, done: (selectedValue?: string) => void) => unknown,
  initialValue: string,
  done: (selectedValue?: string) => void,
): Input {
  return factory(initialValue, done) as Input;
}

describe("createNumericSubmenu", () => {
  it("creates an Input pre-filled with the current value", () => {
    const factory = createNumericSubmenu(mockCtx(), vi.fn());
    const input = open(factory, "5", vi.fn());
    expect(input.getValue()).toBe("5");
  });

  it("treats the '(not set)' placeholder as an empty initial value", () => {
    const input = open(createNumericSubmenu(mockCtx(), vi.fn()), "(not set)", vi.fn());
    expect(input.getValue()).toBe("");
  });

  it("calls onValid and done with parsed value on valid submit", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx(), onValid), "5", done);
    input.onSubmit!("10");
    expect(onValid).toHaveBeenCalledWith(10);
    expect(done).toHaveBeenCalledWith("10");
  });

  it("reports an error and keeps the submenu open on below-minimum submit", () => {
    const ctx = mockCtx();
    const onValid = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(ctx, { onValid }), "5", done);
    input.onSubmit!("0");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(onValid).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input", () => {
    const ctx = mockCtx();
    const done = vi.fn();
    const input = open(createNumericSubmenu(ctx, { min: 0 }), "5", done);
    input.onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("accepts value at exact minimum", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx(), { min: 5, onValid }), "5", done);
    input.onSubmit!("5");
    expect(onValid).toHaveBeenCalledWith(5);
    expect(done).toHaveBeenCalledWith("5");
  });

  it("calls done() without argument on escape", () => {
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx()), "5", done);
    input.onEscape!();
    expect(done).toHaveBeenCalledWith();
  });

  it("calls onEmpty and done('(not set)') on empty input", () => {
    const onEmpty = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx(), {}, vi.fn(), onEmpty), "5", done);
    input.onSubmit!("");
    expect(onEmpty).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("(not set)");
  });

  it("calls onEmpty and done('(not set)') when input is 'unlimited'", () => {
    const onEmpty = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx(), {}, vi.fn(), onEmpty), "5", done);
    input.onSubmit!("unlimited");
    expect(onEmpty).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("(not set)");
  });

  it("submits the configured default when empty input has a default", () => {
    const onValid = vi.fn();
    const done = vi.fn();
    const input = open(createNumericSubmenu(mockCtx(), { min: 0, default: 6, onValid }), "5", done);
    input.onSubmit!("");
    expect(onValid).toHaveBeenCalledWith(6);
    expect(done).toHaveBeenCalledWith("6");
  });

  it("errors on empty input when required", () => {
    const ctx = mockCtx();
    const done = vi.fn();
    const input = open(createNumericSubmenu(ctx, { min: 1, required: true }), "5", done);
    input.onSubmit!("");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
