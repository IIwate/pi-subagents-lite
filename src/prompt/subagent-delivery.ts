// Note: see .agents/notes/implemented/feature/2026-09-10-human-takeover-and-selective-delivery.md
export interface DeliverableMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FormatSubagentDeliveryParams {
  taskOrigin: string;
  type: string;
  messages: readonly DeliverableMessage[];
}

/**
 * Extract plain text from message content across string, parts array, and tool results.
 * Ignores tool calls, tool results, and thinking blocks per Pi's no-tools specification.
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object"
      && item !== null
      && (item as { type?: string }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    )
    .map(item => item.text)
    .join("");
}

/**
 * Filter session messages to user and assistant messages with non-empty text content.
 */
export function extractDeliverableMessages(messages: readonly unknown[]): DeliverableMessage[] {
  const result: DeliverableMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as { role?: unknown; content?: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextFromContent(msg.content).trim();
    if (!text) continue;
    result.push({ role: msg.role, content: text });
  }
  return result;
}

/**
 * Format selected subagent transcript or output into a fenced delivery block
 * suitable for appending to the parent session inbox.
 */
export function formatSubagentDelivery(params: FormatSubagentDeliveryParams): string {
  const { taskOrigin, type, messages } = params;
  const header = `[Subagent Result: ${type} (completed)]\nTask Origin: "${taskOrigin}"\n\n---`;

  if (messages.length === 0) {
    return `${header}\n\n### Delivered Output\n\n(no output)\n\n---`;
  }

  const hasUser = messages.some(m => m.role === "user");

  if (!hasUser) {
    const output = messages.map(m => m.content.trim()).filter(Boolean).join("\n\n---\n\n");
    return `${header}\n\n### Delivered Output\n\n${output || "(no output)"}\n\n---`;
  }

  const transcript = messages.map(m => {
    const roleLabel = m.role === "user" ? "User" : "Assistant";
    return `**${roleLabel}:**\n${m.content.trim()}`;
  }).join("\n\n");

  return `${header}\n\n### Delivered Transcript\n\n${transcript}\n\n---`;
}
