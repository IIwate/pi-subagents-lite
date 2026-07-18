import { describe, expect, it } from "vitest";
import { extractText } from "../../src/prompt/context.js";

describe("extractText", () => {
  it("extracts text from a simple content array", () => {
    expect(extractText([{ type: "text", text: "Hello world" }])).toBe("Hello world");
  });

  it("joins multiple text blocks with newlines", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];
    expect(extractText(content)).toBe("First line\nSecond line");
  });

  it("filters out non-text blocks", () => {
    const content = [
      { type: "text", text: "Visible" },
      { type: "image", data: "base64...", mimeType: "image/png" },
      { type: "toolCall", id: "tc1", name: "read", arguments: {} },
    ];
    expect(extractText(content)).toBe("Visible");
  });

  it("returns an empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("handles null text fields consistently", () => {
    const content = [
      { type: "text", text: null },
      { type: "text", text: "Valid" },
    ];
    expect(extractText(content)).toBe("\nValid");
  });
});
