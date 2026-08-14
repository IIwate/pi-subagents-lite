/** Message content extraction helpers. */

function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text";
}

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join("\n");
}
