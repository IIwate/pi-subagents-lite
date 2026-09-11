import type { ExecutionMessage } from "../engine/contracts.js";

/** Project host message data once; raw text stays intact until the terminal rendering boundary. */
export function projectMessage(entryId: string, message: {
  role: string; content?: unknown; toolName?: string; isError?: boolean; command?: string; output?: string; summary?: string;
}): ExecutionMessage {
  const parts: NonNullable<ExecutionMessage["parts"]>[number][] = [];
  if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
      else if (part.type === "thinking" && typeof part.thinking === "string") parts.push({ type: "thinking", thinking: part.thinking });
      else if (part.type === "toolCall" && typeof part.name === "string") {
        parts.push({ type: "toolCall", name: part.name,
          arguments: part.arguments && typeof part.arguments === "object" ? Object.freeze({ ...part.arguments }) : undefined });
      } else if (part.type === "image") parts.push({ type: "image" });
    }
  }
  const text = message.role === "bashExecution" ? `$ ${message.command ?? ""}\n${message.output ?? ""}`
    : message.summary ?? parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  return Object.freeze({ entryId, role: message.role, text, parts: Object.freeze(parts.map(part => Object.freeze(part))),
    toolName: message.toolName, isError: message.isError });
}
