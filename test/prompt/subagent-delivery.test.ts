import { describe, it, expect } from "vitest";
import {
  extractDeliverableMessages,
  extractTextFromContent,
  formatSubagentDelivery,
} from "../../src/prompt/subagent-delivery.js";

describe("extractTextFromContent", () => {
  it("returns raw string directly", () => {
    expect(extractTextFromContent("hello world")).toBe("hello world");
  });

  it("extracts and joins text blocks from content array, ignoring tool calls and thinking", () => {
    const content = [
      { type: "thinking", thinking: "internal thought" },
      { type: "text", text: "First paragraph.\n" },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
      { type: "text", text: "Second paragraph." },
    ];
    expect(extractTextFromContent(content)).toBe("First paragraph.\nSecond paragraph.");
  });

  it("returns empty string for non-string, non-array inputs", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
    expect(extractTextFromContent(42)).toBe("");
  });
});

describe("extractDeliverableMessages", () => {
  it("filters session messages to user and assistant with non-empty text", () => {
    const rawMessages = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Please analyze the code." },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "toolResult", content: "file content" },
      { role: "assistant", content: "Here is the result." },
      { role: "assistant", content: "   " },
    ];

    const deliverable = extractDeliverableMessages(rawMessages);
    expect(deliverable).toEqual([
      { role: "user", content: "Please analyze the code." },
      { role: "assistant", content: "Here is the result." },
    ]);
  });
});

describe("formatSubagentDelivery", () => {
  it("formats assistant-only messages as Delivered Output", () => {
    const formatted = formatSubagentDelivery({
      taskOrigin: "Analyze auth flow",
      type: "Explore",
      messages: [{ role: "assistant", content: "The auth flow uses OAuth PKCE." }],
    });

    expect(formatted).toBe(
      `[Subagent Result: Explore (completed)]\n`
      + `Task Origin: "Analyze auth flow"\n\n`
      + `---\n\n`
      + `### Delivered Output\n\n`
      + `The auth flow uses OAuth PKCE.\n\n`
      + `---`,
    );
  });

  it("formats multiple assistant messages joined by dividers in Delivered Output", () => {
    const formatted = formatSubagentDelivery({
      taskOrigin: "Multi-part response",
      type: "general-purpose",
      messages: [
        { role: "assistant", content: "Part 1 summary." },
        { role: "assistant", content: "Part 2 details." },
      ],
    });

    expect(formatted).toContain("### Delivered Output");
    expect(formatted).toContain("Part 1 summary.\n\n---\n\nPart 2 details.");
    expect(formatted).toMatch(/^\[Subagent Result: general-purpose \(completed\)\]/);
  });

  it("formats mixed user and assistant messages as Delivered Transcript", () => {
    const formatted = formatSubagentDelivery({
      taskOrigin: "Refactor database query",
      type: "general-purpose",
      messages: [
        { role: "user", content: "Can you optimize the join query?" },
        { role: "assistant", content: "Yes, we can add an index on user_id." },
      ],
    });

    expect(formatted).toBe(
      `[Subagent Result: general-purpose (completed)]\n`
      + `Task Origin: "Refactor database query"\n\n`
      + `---\n\n`
      + `### Delivered Transcript\n\n`
      + `**User:**\n`
      + `Can you optimize the join query?\n\n`
      + `**Assistant:**\n`
      + `Yes, we can add an index on user_id.\n\n`
      + `---`,
    );
  });

  it("formats user-only messages as Delivered Transcript", () => {
    const formatted = formatSubagentDelivery({
      taskOrigin: "User instructions only",
      type: "Explore",
      messages: [{ role: "user", content: "Investigate this issue first." }],
    });

    expect(formatted).toContain("### Delivered Transcript");
    expect(formatted).toContain("**User:**\nInvestigate this issue first.");
  });

  it("handles empty messages by falling back to empty Delivered Output", () => {
    const formatted = formatSubagentDelivery({
      taskOrigin: "No messages selected",
      type: "Explore",
      messages: [],
    });

    expect(formatted).toBe(
      `[Subagent Result: Explore (completed)]\n`
      + `Task Origin: "No messages selected"\n\n`
      + `---\n\n`
      + `### Delivered Output\n\n`
      + `(no output)\n\n`
      + `---`,
    );
  });
});
