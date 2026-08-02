/**
 * Tests for createModelSelectSubmenu — 2-step model → override mode selection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let selectListInstances: Array<{
  items: any[];
  onSelect?: (item: any) => void;
  onCancel?: () => void;
  render: (w: number) => string[];
  handleInput: (d: string) => void;
}> = [];

let selectDialogInstances: Array<{
  onSelect?: (value: string) => void;
  onCancel?: () => void;
  render: (w: number) => string[];
  handleInput: (d: string) => void;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList { constructor() {} },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() { return []; }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
  },
  Container: class MockContainer { addChild() {} clear() {} render() { return []; } invalidate() {} },
  Spacer: class MockSpacer { constructor() {} },
  Text: class MockText { constructor() {} },
  fuzzyFilter: vi.fn((_items, _query, _accessor) => []),
  getKeybindings: vi.fn(() => ({ matches: () => false })),
}));

vi.mock("../../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    onSelect?: (v: string) => void;
    onCancel?: () => void;
    constructor(_items: any, _current: any, callbacks: any, _theme: any) {
      this.onSelect = callbacks.onSelect;
      this.onCancel = callbacks.onCancel;
      selectDialogInstances.push(this as any);
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

vi.mock("../../../../src/utils.js", () => ({
  parseModelKey: vi.fn((key: string) => {
    const parts = key.split("/");
    if (parts.length === 2) return { provider: parts[0], modelId: parts[1] };
    return null;
  }),
}));

import { createModelSelectSubmenu } from "../../../../src/ui/menu/submenus/model-select.js";

describe("createModelSelectSubmenu", () => {
  beforeEach(() => {
    selectListInstances = [];
    selectDialogInstances = [];
    vi.clearAllMocks();
  });

  const mockTheme = {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
  };

  it("starts on model selection and creates mode list with override options", () => {
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"],
      showClear: false,
      theme: mockTheme,
      onSelect: vi.fn(),
    });
    expect(typeof factory).toBe("function");

    factory("(inherits parent)", vi.fn());
    expect(selectDialogInstances.length).toBe(1);
    expect(selectListInstances.length).toBe(1);
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(2);
    expect(items[0].value).toBe("session");
    expect(items[0].label).toContain("session");
    expect(items[1].value).toBe("permanent");
    expect(items[1].label).toContain("permanent");
  });

  it("shows Clear option when showClear is true", () => {
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: true,
      theme: mockTheme,
      onSelect: vi.fn(),
    });
    factory("openai/gpt-4o", vi.fn());
    const items = selectListInstances[0].items;
    expect(items).toHaveLength(3);
    expect(items[2].value).toBe("clear");
  });

  it("calls onSelect with mode and picked model after model → mode flow", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    factory("(inherits parent)", done);

    // Step 1: pick a model
    selectDialogInstances[0].onSelect!("anthropic/claude-sonnet-4-20250514");
    // onSelect not called yet (mode step pending)
    expect(onSelect).not.toHaveBeenCalled();

    // Step 2: pick permanent
    selectListInstances[0].onSelect!({ value: "permanent" });
    expect(onSelect).toHaveBeenCalledWith("permanent", "anthropic/claude-sonnet-4-20250514");
    expect(done).toHaveBeenCalledWith("anthropic/claude-sonnet-4-20250514");
  });

  it("calls onSelect with mode='clear' and done when clear is selected", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: true,
      theme: mockTheme,
      onSelect,
    });
    factory("openai/gpt-4o", done);

    selectDialogInstances[0].onSelect!("openai/gpt-4o");
    selectListInstances[0].onSelect!({ value: "clear" });
    expect(onSelect).toHaveBeenCalledWith("clear", null);
    expect(done).toHaveBeenCalledWith("clear");
  });

  it("calls done without onSelect on cancel from model selection", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    factory("(inherits parent)", done);
    selectDialogInstances[0].onCancel!();
    expect(onSelect).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("calls done without onSelect on cancel from mode selection", () => {
    const onSelect = vi.fn();
    const done = vi.fn();
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect,
    });
    factory("(inherits parent)", done);
    selectDialogInstances[0].onSelect!("anthropic/claude-sonnet-4-20250514");
    selectListInstances[0].onCancel!();
    expect(onSelect).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("component invalidate and render do not throw", () => {
    const factory = createModelSelectSubmenu({
      modelOptions: ["anthropic/claude-sonnet-4-20250514"],
      showClear: false,
      theme: mockTheme,
      onSelect: vi.fn(),
    });
    const component = factory("(inherits parent)", vi.fn());
    expect(() => component.render(80)).not.toThrow();
    expect(() => component.invalidate()).not.toThrow();
  });
});
