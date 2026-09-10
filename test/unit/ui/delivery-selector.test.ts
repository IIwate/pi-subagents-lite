import { describe, it, expect, vi } from "vitest";
import { DeliverySelectorComponent } from "../../../src/ui/delivery-selector.js";
import type { DeliverableMessage } from "../../../src/prompt/subagent-delivery.js";
import { visibleWidth } from "@earendil-works/pi-tui";

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

describe("DeliverySelectorComponent boundaries", () => {
  it.each([20, 30, 50, 80])("bounds every line and preserves body height at %s columns", width => {
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: [
        { role: "user", content: "Short query" },
        { role: "assistant", content: "Long reply with wide symbols 🧪\n".repeat(40) },
      ],
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = component.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines.join("\n")).toContain("Esc");
    component.handleInput("\x1b[A");
    const short = component.render(width);
    expect(short).toHaveLength(lines.length);
    expect(short.every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it("sanitizes source controls before styling without changing the message payload", () => {
    const content = "Safe\x07\x1b]0;source-title\x07\x1b[31m text\r\nNext line";
    const record = makeRecord();
    record.display.type = "Explore\x07\x1b]0;source-type\x07\r\nAgent";
    const messages: DeliverableMessage[] = [{ role: "assistant", content }];
    const component = new DeliverySelectorComponent({
      record, messages,
      theme: { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`, bold: (text: string) => text } as any,
      onConfirm: vi.fn(), onCancel: vi.fn(),
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).not.toMatch(/[\x07\r]/);
    expect(rendered).not.toContain("\x1b]0;");
    expect(rendered).not.toContain("\x1b[31m");
    expect(rendered).toContain("\x1b[32m");
    expect(messages[0].content).toBe(content);
  });

  it("handles large message collections (50+ items) with proper window scrolling", () => {
    const manyMessages = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message turn ${i + 1}\nMore content on line 2.`,
    }));

    const mockTui = {
      terminal: { rows: 20, columns: 100 },
      requestRender: vi.fn(),
    };

    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: manyMessages,
      theme: mockTheme as any,
      tui: mockTui as any,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    // Default should preselect latest assistant (index 59)
    expect(component.cursorIndex).toBe(59);
    expect(component.selectedIndices.has(59)).toBe(true);

    // Render should show a bounded window around the end
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("[Assistant #30]"); // 60 messages -> 30 users, 30 assistants
    expect(rendered).toContain("Preview: [Assistant #30]");

    // Test cursor top boundary
    for (let k = 0; k < 70; k++) {
      component.handleInput("\x1b[A"); // Up arrow
    }
    expect(component.cursorIndex).toBe(0);

    // Press Up again at boundary -> stays at 0
    component.handleInput("\x1b[A");
    expect(component.cursorIndex).toBe(0);

    // Test cursor bottom boundary
    for (let k = 0; k < 70; k++) {
      component.handleInput("\x1b[B"); // Down arrow
    }
    expect(component.cursorIndex).toBe(59);

    // Press Down again at boundary -> stays at 59
    component.handleInput("\x1b[B");
    expect(component.cursorIndex).toBe(59);
  });

  it("guarantees chronological message delivery even when user selects items out-of-order", () => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "Message 0" },
      { role: "assistant", content: "Message 1" },
      { role: "user", content: "Message 2" },
      { role: "assistant", content: "Message 3" },
    ];

    const onConfirm = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages,
      theme: mockTheme as any,
      onConfirm,
      onCancel: vi.fn(),
    });

    // Initially index 3 is selected. Toggle it off.
    component.handleInput(" ");
    expect(component.selectedIndices.size).toBe(0);

    // Select in reverse order: select 2, then select 0
    component.handleInput("\x1b[A"); // cursor at 2
    component.handleInput(" ");      // select 2
    component.handleInput("\x1b[A"); // cursor at 1
    component.handleInput("\x1b[A"); // cursor at 0
    component.handleInput(" ");      // select 0

    // Press Enter to confirm
    component.handleInput("\r");
    expect(onConfirm).toHaveBeenCalledWith([0, 2]); // strictly sorted ascending
  });

  it("prevents confirmation when no items are selected", () => {
    const onConfirm = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: [{ role: "assistant", content: "Only item" }],
      theme: mockTheme as any,
      onConfirm,
      onCancel: vi.fn(),
    });

    // Toggle off the default selected item
    component.handleInput(" ");
    expect(component.selectedIndices.size).toBe(0);

    component.handleInput("\r");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders empty state gracefully when there are no deliverable messages", () => {
    const onCancel = vi.fn();
    const component = new DeliverySelectorComponent({
      record: makeRecord(),
      messages: [],
      theme: mockTheme as any,
      onConfirm: vi.fn(),
      onCancel,
    });

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("(no deliverable messages in child session)");
    expect(rendered).toContain("Esc Cancel");

    // Any navigation or Space does nothing
    component.handleInput("\x1b[A");
    component.handleInput(" ");
    component.handleInput("\r");

    // Esc cancels cleanly
    component.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
