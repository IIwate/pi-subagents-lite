import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExecutionMessage } from "../engine/contracts.js";
import type { NavigationAgent, TranscriptSnapshot } from "./navigation.js";
import { plainAgentStatus, renderPending, renderRetry } from "./navigator-view.js";
import { displayText, summarizeToolArgs } from "./format.js";
import type { Theme } from "./types.js";

function appendWrapped(lines: string[], text: string, width: number): void {
  for (const line of text.split("\n")) {
    if (!line) lines.push("");
    else lines.push(...wrapTextWithAnsi(line, Math.max(1, width - 2)).map(part => `  ${part}`));
  }
}

/** Cached layout owns no subscriptions or execution resources. */
export class TranscriptView {
  private rows = new WeakMap<ExecutionMessage, string[]>();
  private theme?: Theme;
  private width = 0;

  invalidate(): void { this.rows = new WeakMap(); }

  render(record: NavigationAgent, snapshot: TranscriptSnapshot, theme: Theme, width: number, dockActive: boolean): string[] {
    if (this.theme !== theme || this.width !== width) {
      this.invalidate(); this.theme = theme; this.width = width;
    }
    const lines = [
      theme.fg("accent", theme.bold(`${displayText(record.display.name).replace(/\n/g, " ")} (${plainAgentStatus(record)})`)),
      theme.fg("dim", "─".repeat(Math.max(1, width))),
    ].map(line => truncateToWidth(line, width));
    if (!snapshot.ready && !record.error) {
      lines.push(truncateToWidth(theme.fg("dim", record.lifecycle.status === "queued" ? "Waiting in queue…" : "Starting agent session…"), width));
    }
    for (const message of snapshot.messages) lines.push(...this.message(message, theme, width));
    if (snapshot.streaming) lines.push(...this.message(snapshot.streaming, theme, width));
    if (record.error) lines.push(truncateToWidth(theme.fg("error", `Error: ${displayText(record.error)}`), width));
    if (!dockActive) lines.push(...renderRetry(record, width, theme, Date.now()), ...renderPending(record, width, theme));
    return lines;
  }

  private message(message: ExecutionMessage, theme: Theme, width: number): string[] {
    const cached = this.rows.get(message);
    if (cached) return cached;
    const lines: string[] = [];
    const text = displayText(message.text);
    switch (message.role) {
      case "user": {
        const images = message.parts?.filter(part => part.type === "image").length ?? 0;
        if (!text && !images) break;
        lines.push("", theme.fg("accent", theme.bold("User")));
        if (text) appendWrapped(lines, text, width);
        if (images) appendWrapped(lines, theme.fg("dim", `[${images} image${images === 1 ? "" : "s"}]`), width);
        break;
      }
      case "assistant": {
        const content: string[] = [];
        for (const part of message.parts ?? [{ type: "text", text: message.text }]) {
          if (part.type === "text" && part.text) appendWrapped(content, displayText(part.text), width);
          else if (part.type === "thinking" && displayText(part.thinking).trim()) {
            content.push(theme.fg("dim", "  Thinking"));
            appendWrapped(content, theme.fg("dim", displayText(part.thinking).trim()), width);
          } else if (part.type === "toolCall") {
            const name = displayText(part.name);
            appendWrapped(content, theme.fg("dim", `▸ ${name}${displayText(summarizeToolArgs(part.name, part.arguments))}`), width);
          }
        }
        if (content.length) lines.push("", theme.bold("Assistant"), ...content);
        break;
      }
      case "toolResult": {
        lines.push(`${message.isError ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.fg("dim", displayText(message.toolName ?? "tool"))}`);
        const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n… (tool result truncated)` : text;
        if (clipped) appendWrapped(lines, theme.fg("dim", clipped), width);
        break;
      }
      case "bashExecution": lines.push(""); appendWrapped(lines, text, width); break;
      case "compactionSummary":
      case "branchSummary":
        lines.push("", theme.fg("dim", message.role === "compactionSummary" ? "Compaction summary" : "Branch summary"));
        if (text) appendWrapped(lines, text, width);
        break;
    }
    const rendered = lines.map(line => truncateToWidth(line, width));
    this.rows.set(message, rendered);
    return rendered;
  }
}
