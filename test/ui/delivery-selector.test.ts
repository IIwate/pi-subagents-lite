import { describe, it, expect, vi } from "vitest";
import { DeliverySelectorComponent } from "../../src/ui/delivery-selector.js";
import type { DeliverableMessage } from "../../src/prompt/subagent-delivery.js";

const mockTheme = {
  bold: (t: string) => `*${t}*`,
  fg: (_color: string, t: string) => t,
};

function makeRecord(id = "agent-12345678"): any {
  return {
    id,
    display: {
      type: "Explore",
      description: "Analyze code structure",
    },
    lifecycle: {
      status: "completed",
      startedAt: Date.now(),
      takenOver: true,
    },
    execution: {},
  };
}

describe("DeliverySelectorComponent", () => {
  const sampleMessages: DeliverableMessage[] = [
    { role: "user", content: "Initial instructions\nSecond line" },
    { role: "assistant", content: "First answer\nDetails here" },
    { role: "user", content: "Follow-up question" },
    { role: "assistant", content: "Final answer\nMore details" },
  ];

  it("pre-selects the latest assistant message and positions cursor on it", () => {
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    // Latest assistant is index 3
    expect(component.cursorIndex).toBe(3);
    expect([...component.selectedIndices]).toEqual([3]);
  });

  it("positions cursor at 0 if no assistant messages exist", () => {
    const userOnly: DeliverableMessage[] = [
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ];
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: userOnly,
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(component.cursorIndex).toBe(0);
    expect(component.selectedIndices.size).toBe(0);
  });

  it("navigates with Up and Down arrows", () => {
    const mockTui = { requestRender: vi.fn() } as any;
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      tui: mockTui,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    // Starts at index 3
    expect(component.cursorIndex).toBe(3);

    // Up -> 2
    component.handleInput("\x1b[A");
    expect(component.cursorIndex).toBe(2);
    expect(mockTui.requestRender).toHaveBeenCalled();

    // Up -> 1
    component.handleInput("\x1b[A");
    expect(component.cursorIndex).toBe(1);

    // Down -> 2
    component.handleInput("\x1b[B");
    expect(component.cursorIndex).toBe(2);
  });

  it("toggles item selection with Space", () => {
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    // Index 3 is initially selected
    expect(component.selectedIndices.has(3)).toBe(true);

    // Space toggles index 3 off
    component.handleInput(" ");
    expect(component.selectedIndices.has(3)).toBe(false);

    // Space toggles index 3 on
    component.handleInput(" ");
    expect(component.selectedIndices.has(3)).toBe(true);

    // Move to index 2 and toggle on
    component.handleInput("\x1b[A");
    component.handleInput(" ");
    expect(component.selectedIndices.has(2)).toBe(true);
    expect(component.selectedIndices.has(3)).toBe(true);
  });

  it("calls onConfirm with sorted selected indices on Enter", () => {
    const onConfirm = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm,
      onCancel: vi.fn(),
    });

    // Also select index 0
    component.handleInput("\x1b[A"); // 2
    component.handleInput("\x1b[A"); // 1
    component.handleInput("\x1b[A"); // 0
    component.handleInput(" "); // toggle 0 on

    component.handleInput("\r");
    expect(onConfirm).toHaveBeenCalledWith([0, 3]);
  });

  it("does not call onConfirm on Enter if nothing is selected", () => {
    const onConfirm = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm,
      onCancel: vi.fn(),
    });

    // Toggle off the pre-selected item
    component.handleInput(" ");
    expect(component.selectedIndices.size).toBe(0);

    component.handleInput("\r");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape", () => {
    const onCancel = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel,
    });

    component.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders two columns with header, divider, and command bar", () => {
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: sampleMessages,
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Deliver to Parent Session");
    expect(rendered).toContain("Explore");
    expect(rendered).toContain("[User #1]");
    expect(rendered).toContain("[Assistant #1]");
    expect(rendered).toContain("[User #2]");
    expect(rendered).toContain("[Assistant #2]");
    expect(rendered).toContain("│");
    expect(rendered).toContain("Preview: [Assistant #2]");
    expect(rendered).toContain("Final answer");
    expect(rendered).toContain("↑↓ Move · Space Toggle · Enter Deliver");
    expect(rendered).toContain("╭");
    expect(rendered).toContain("╯");
  });

  it("maintains a constant rendered line count when navigating between long and short messages", () => {
    const mixedMessages: DeliverableMessage[] = [
      { role: "user", content: "Short question" },
      {
        role: "assistant",
        content: Array.from({ length: 40 }, (_, i) => `Long analysis line ${i + 1}`).join("\n"),
      },
      { role: "user", content: "Another short query" },
    ];

    const mockTui = {
      terminal: { rows: 24, columns: 80 },
      requestRender: vi.fn(),
    };

    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: mixedMessages,
      theme: mockTheme as any,
      tui: mockTui as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    // Starts on assistant (long message)
    expect(component.cursorIndex).toBe(1);
    const longLinesCount = component.render(80).length;

    // Navigate to short user message
    component.handleInput("\x1b[A"); // Up to index 0
    expect(component.cursorIndex).toBe(0);
    const shortLinesCount = component.render(80).length;

    // Line count must remain stable to prevent differential shrink and scrollback clearing
    expect(shortLinesCount).toBe(longLinesCount);
  });
});
