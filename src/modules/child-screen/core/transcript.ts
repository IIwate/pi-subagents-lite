import type { ChildRecordSummary, RenderedLine } from "../contracts/navigator.js";
import type { TextLayout } from "../contracts/navigator.js";
import { line } from "./projection.js";
import { agentStatusLabel, displayNameOf } from "./status.js";

const TOOL_RESULT_CHAR_LIMIT = 4000;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object"
      && item !== null
      && (item as { type?: string }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("");
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((item) =>
    typeof item === "object"
    && item !== null
    && (item as { type?: string }).type === "image",
  ).length;
}

function appendWrapped(lines: RenderedLine[], text: string, width: number, layout: TextLayout, color?: string): void {
  const wrapped = layout.wrap(text, Math.max(1, width - 2));
  for (const wrappedLine of wrapped) {
    lines.push(line([{ text: wrappedLine ? `  ${wrappedLine}` : "", color }]));
  }
}

function summarizeToolArgs(name: string, rawArgs: Record<string, unknown> | undefined): string {
  if (!rawArgs || typeof rawArgs !== "object" || Object.keys(rawArgs).length === 0) return "";
  switch (name) {
    case "read":
      return `(${JSON.stringify(typeof rawArgs.path === "string" ? rawArgs.path : "")})`;
    case "write": {
      const path = typeof rawArgs.file_path === "string" ? rawArgs.file_path : "";
      const size = typeof rawArgs.content === "string" ? rawArgs.content.length : 0;
      return `(${JSON.stringify(path)}, ${size} chars)`;
    }
    case "edit": {
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      const editCount = Array.isArray(rawArgs.edits) ? rawArgs.edits.length : 0;
      return `(${JSON.stringify(path)}, ${editCount} edits)`;
    }
    case "bash": {
      const cmd = typeof rawArgs.command === "string" ? rawArgs.command : "";
      const heredocIdx = cmd.search(/<<\s*['"]?\w+['"]?/);
      const cleanCmd = heredocIdx >= 0 ? cmd.slice(0, heredocIdx).trim() : cmd.trim();
      const display = cleanCmd.length > 100 ? `${cleanCmd.slice(0, 100)}…` : cleanCmd;
      return `(${JSON.stringify(display)})`;
    }
    case "grep":
    case "rg":
      return `(${JSON.stringify(typeof rawArgs.pattern === "string" ? rawArgs.pattern : "")}, ${JSON.stringify(typeof rawArgs.path === "string" ? rawArgs.path : "")})`;
    default: {
      const keys = Object.keys(rawArgs);
      if (keys.length === 1) {
        const val = rawArgs[keys[0]];
        const display = typeof val === "string" && val.length > 200
          ? JSON.stringify(`${val.slice(0, 200)}...`)
          : JSON.stringify(val);
        return `(${display})`;
      }
      return ` ${JSON.stringify(rawArgs)}`;
    }
  }
}

function appendMessage(
  lines: RenderedLine[],
  message: Record<string, unknown>,
  width: number,
  layout: TextLayout,
): void {
  switch (message.role) {
    case "user": {
      const text = textFromContent(message.content);
      const images = imageCount(message.content);
      if (!text && images === 0) return;
      lines.push(line([{ text: "" }]));
      lines.push(line([{ text: "User", color: "accent", bold: true }]));
      if (text) appendWrapped(lines, text, width, layout);
      if (images > 0) appendWrapped(lines, `[${images} image${images === 1 ? "" : "s"}]`, width, layout, "dim");
      return;
    }
    case "assistant": {
      if (!Array.isArray(message.content)) return;
      lines.push(line([{ text: "" }]));
      lines.push(line([{ text: "Assistant", bold: true }]));
      for (const item of message.content as Array<Record<string, unknown>>) {
        if (item.type === "text" && typeof item.text === "string") {
          appendWrapped(lines, item.text, width, layout);
        } else if (item.type === "thinking" && typeof item.thinking === "string") {
          lines.push(line([{ text: "  Thinking", color: "dim" }]));
          appendWrapped(lines, item.thinking, width, layout, "dim");
        } else if (item.type === "toolCall") {
          const name = typeof item.name === "string" ? item.name : "tool";
          const args = item.arguments && typeof item.arguments === "object"
            ? item.arguments as Record<string, unknown>
            : undefined;
          appendWrapped(lines, `▸ ${name}${summarizeToolArgs(name, args)}`, width, layout, "dim");
        }
      }
      return;
    }
    case "toolResult": {
      const text = textFromContent(message.content);
      const clipped = text.length > TOOL_RESULT_CHAR_LIMIT
        ? `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n… (tool result truncated)`
        : text;
      const icon = message.isError ? "✗" : "✓";
      lines.push(line([
        { text: icon, color: message.isError ? "error" : "success" },
        { text: ` ${typeof message.toolName === "string" ? message.toolName : "tool"}`, color: "dim" },
      ]));
      if (clipped) appendWrapped(lines, clipped, width, layout, "dim");
      return;
    }
    case "bashExecution": {
      lines.push(line([{ text: "" }]));
      lines.push(line([{ text: `$ ${typeof message.command === "string" ? message.command : ""}`, color: "accent" }]));
      if (typeof message.output === "string") appendWrapped(lines, message.output, width, layout);
      return;
    }
    case "compactionSummary":
    case "branchSummary": {
      lines.push(line([{ text: "" }]));
      lines.push(line([{
        text: message.role === "compactionSummary" ? "Compaction summary" : "Branch summary",
        color: "dim",
      }]));
      if (typeof message.summary === "string") appendWrapped(lines, message.summary, width, layout);
    }
  }
}

export function projectTranscript(
  record: ChildRecordSummary | undefined,
  width: number,
  layout: TextLayout,
): RenderedLine[] {
  if (!record) return [];
  const status = agentStatusLabel(record.status);
  const debugLabel = record.debugFaultKind ? " [DEBUG]" : "";
  const lines: RenderedLine[] = [
    line([{ text: `${displayNameOf(record)}${debugLabel} (${status})`, color: "accent", bold: true }]),
    line([{ text: "─".repeat(Math.max(1, width)), color: "dim" }]),
  ];
  const session = record.session;
  if (!session?.found || !session.live) {
    if (record.error) lines.push(line([{ text: `Error: ${record.error}`, color: "error" }]));
    else {
      lines.push(line([{
        text: record.status === "queued" ? "Waiting in queue…" : "Starting agent session…",
        color: "dim",
      }]));
    }
    return lines;
  }
  for (const message of session.messages) {
    if (message && typeof message === "object") appendMessage(lines, message as Record<string, unknown>, width, layout);
  }
  if (session.streamingMessage && typeof session.streamingMessage === "object") {
    appendMessage(lines, session.streamingMessage as Record<string, unknown>, width, layout);
  }
  if (record.error) lines.push(line([{ text: `Error: ${record.error}`, color: "error" }]));
  return lines.map((rendered) => line([{
    text: layout.truncate(rendered.parts.map((part) => part.text).join(""), width),
    color: rendered.parts.length === 1 ? rendered.parts[0]?.color : undefined,
    bold: rendered.parts.length === 1 ? rendered.parts[0]?.bold : undefined,
  }]));
}
