import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import type { DeliverableMessage } from "../prompt/subagent-delivery.js";
import type { Theme } from "./types.js";
import { displayText } from "./format.js";

export interface DeliverySelectorOptions {
  record: AgentRecord;
  messages: readonly DeliverableMessage[];
  theme: Theme;
  tui?: TUI;
  onConfirm: (selectedIndices: number[]) => void;
  onCancel: () => void;
}

function fallbackMarkdownTheme(theme: Theme) {
  return {
    heading: (text: string) => theme.bold(text),
    link: (text: string) => theme.fg("accent", text),
    linkUrl: (text: string) => theme.fg("dim", text),
    code: (text: string) => theme.fg("accent", text),
    codeBlock: (text: string) => theme.fg("dim", text),
    codeBlockBorder: (text: string) => theme.fg("dim", text),
    quote: (text: string) => theme.fg("dim", text),
    quoteBorder: (text: string) => theme.fg("dim", text),
    hr: (text: string) => theme.fg("dim", text),
    listBullet: (text: string) => theme.fg("accent", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
}

interface MessageItem {
  index: number;
  role: "user" | "assistant";
  label: string;
  summary: string;
  content: string;
}

// Note: see .agents/notes/implemented/bug-fix/2026-09-10-terminal-preview-and-queue-sanitization.md
export class DeliverySelectorComponent implements Component {
  private record: AgentRecord;
  private items: MessageItem[];
  private theme: Theme;
  private tui?: TUI;
  private onConfirm: (selectedIndices: number[]) => void;
  private onCancel: () => void;
  private notice = "";
  private selectionLocked = false;

  cursorIndex: number = 0;
  selectedIndices: Set<number> = new Set();

  invalidate(): void {}

  constructor(options: DeliverySelectorOptions) {
    this.record = options.record;
    this.theme = options.theme;
    this.tui = options.tui;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;

    let userCount = 0;
    let assistantCount = 0;
    this.items = options.messages.map((m, i) => {
      const isUser = m.role === "user";
      const number = isUser ? ++userCount : ++assistantCount;
      const label = `[${isUser ? "User" : "Assistant"} #${number}]`;
      const content = displayText(m.content);
      const firstLine = content.trim().split("\n")[0] ?? "";
      return {
        index: i,
        role: m.role,
        label,
        summary: firstLine,
        content,
      };
    });

    // Default pre-select: latest assistant message, cursor positioned on it
    let lastAssistantIndex = -1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]?.role === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex >= 0) {
      this.selectedIndices.add(lastAssistantIndex);
      this.cursorIndex = lastAssistantIndex;
    } else if (this.items.length > 0) {
      this.cursorIndex = 0;
    }
  }

  setNotice(message: string, selectionLocked: boolean): void {
    this.notice = message;
    this.selectionLocked = selectionLocked;
    this.tui?.requestRender();
  }

  handleInput(data: string): void {
    if (this.items.length === 0) {
      if (matchesKey(data, Key.escape)) this.onCancel();
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
        this.tui?.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.cursorIndex < this.items.length - 1) {
        this.cursorIndex++;
        this.tui?.requestRender();
      }
      return;
    }

    if (data === " ") {
      if (this.selectionLocked) return;
      if (this.selectedIndices.has(this.cursorIndex)) {
        this.selectedIndices.delete(this.cursorIndex);
      } else {
        this.selectedIndices.add(this.cursorIndex);
      }
      this.tui?.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.selectedIndices.size > 0) {
        const sorted = [...this.selectedIndices].sort((a, b) => a - b);
        this.onConfirm(sorted);
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
  }

  render(width: number): string[] {
    if (width < 20) return [truncateToWidth("Esc Cancel", Math.max(0, width))];
    const totalWidth = width;
    const innerW = totalWidth - 2;
    const borderV = this.theme.fg("accent", "│");
    const topBorder = this.theme.fg("accent", `╭${"─".repeat(innerW)}╮`);
    const midBorder = this.theme.fg("accent", `├${"─".repeat(innerW)}┤`);
    const botBorder = this.theme.fg("accent", `╰${"─".repeat(innerW)}╯`);

    const pad = (text: string, len: number): string => {
      const vis = visibleWidth(text);
      if (vis >= len) return truncateToWidth(text, len);
      return text + " ".repeat(len - vis);
    };

    const row = (content: string): string => `${borderV}${pad(content, innerW)}${borderV}`;

    const lines: string[] = [];

    // Title bar
    const title = ` ${this.theme.bold(this.theme.fg("accent", "Deliver to Parent Session"))}`
      + this.theme.fg("dim", ` · ${displayText(this.record.display.type).replace(/\n/g, " ")} (${this.record.id.slice(0, 8)})`);
    lines.push(topBorder);
    lines.push(row(title));
    lines.push(midBorder);

    if (this.items.length === 0) {
      lines.push(row(this.theme.fg("dim", " (no deliverable messages in child session)")));
      lines.push(midBorder);
      lines.push(row(this.theme.fg("dim", " Esc Cancel")));
      lines.push(botBorder);
      return lines;
    }

    // Geometry calculation: 1 space padding on both sides, 38% left, 62% right
    const contentWidth = innerW - 2;
    const narrow = width < 50;
    const leftWidth = Math.max(26, Math.min(36, Math.floor(contentWidth * 0.38)));
    const divider = ` ${this.theme.fg("dim", "│")} `;
    const dividerWidth = 3;
    const rightWidth = narrow ? contentWidth : contentWidth - leftWidth - dividerWidth;

    // Visible window for left list
    const maxVisibleRows = Math.max(1, Math.min(14, (this.tui?.terminal?.rows ?? 24) - 8));
    let windowStart = 0;
    if (this.items.length > maxVisibleRows) {
      const half = Math.floor(maxVisibleRows / 2);
      windowStart = Math.max(0, Math.min(this.items.length - maxVisibleRows, this.cursorIndex - half));
    }
    const visibleItems = this.items.slice(windowStart, windowStart + maxVisibleRows);

    // Render left rows
    const leftRows: string[] = [];
    for (const item of visibleItems) {
      const isFocused = item.index === this.cursorIndex;
      const isChecked = this.selectedIndices.has(item.index);

      const cursor = isFocused ? this.theme.fg("accent", "› ") : "  ";
      const checkbox = isChecked
        ? this.theme.fg("success", "[x] ")
        : this.theme.fg("dim", "[ ] ");

      const labelColor = item.role === "user" ? "accent" : "muted";
      const labelText = this.theme.fg(labelColor, item.label);
      const prefixWidth = visibleWidth(cursor) + visibleWidth(checkbox) + visibleWidth(labelText) + 1;
      const availSummary = Math.max(4, leftWidth - prefixWidth);
      const summaryText = this.theme.fg("dim", truncateToWidth(item.summary, availSummary));

      const rowText = `${cursor}${checkbox}${labelText} ${summaryText}`;
      const padded = pad(rowText, leftWidth);
      leftRows.push(padded);
    }

    // Render right preview: markdown of current cursor item
    const currentItem = this.items[this.cursorIndex];
    const previewHeader = currentItem
      ? this.theme.bold(
          this.theme.fg(
            currentItem.role === "user" ? "accent" : "dim",
            `Preview: ${currentItem.label}`,
          ),
        )
      : "";

    let rightRows: string[] = [];
    if (narrow && currentItem) {
      const checked = this.selectedIndices.has(currentItem.index) ? "x" : " ";
      rightRows.push(`[${checked}] ${currentItem.label}`, `${this.cursorIndex + 1}/${this.items.length} · ${this.selectedIndices.size} selected`, "");
    } else if (previewHeader) rightRows.push(previewHeader, "");
    if (currentItem?.content) {
      const mdTheme = typeof getMarkdownTheme === "function"
        ? getMarkdownTheme()
        : fallbackMarkdownTheme(this.theme);
      const md = new Markdown(currentItem.content, 0, 0, mdTheme);
      const renderedMd = md.render(rightWidth);
      rightRows.push(...renderedMd);
    }

    // Maintain a stable body height across cursor movements to prevent vertical jitter
    // and stop line-count shrinkage from triggering terminal clearOnShrink (\x1b[3J) redraws.
    const bodyHeight = maxVisibleRows;
    for (let r = 0; r < bodyHeight; r++) {
      if (r === 0 && this.notice) {
        lines.push(row(this.theme.fg("warning", displayText(this.notice).replace(/\n/g, " "))));
        continue;
      }
      const index = this.notice ? r - 1 : r;
      const left = leftRows[index] ?? pad("", leftWidth);
      const right = rightRows[index] ?? "";
      if (narrow) {
        lines.push(row(` ${pad(right, contentWidth)} `));
        continue;
      }
      const paddedLeft = pad(left, leftWidth);
      const paddedRight = pad(right, rightWidth);
      lines.push(row(` ${paddedLeft}${divider}${paddedRight} `));
    }

    // Footer command bar
    lines.push(midBorder);
    const selectedCount = this.selectedIndices.size;
    const deliverHint = selectedCount > 0
      ? `Enter Deliver (${selectedCount} selected)`
      : "Enter Deliver (select at least 1)";
    let footer = this.selectionLocked
      ? " Enter Retry · Esc Close"
      : ` ↑↓ Move · Space Toggle · ${deliverHint} · Esc Cancel`;
    if (visibleWidth(footer) > innerW) {
      footer = this.selectionLocked ? "Enter Retry Esc" : "↑↓ Space Enter Esc";
    }
    lines.push(row(this.theme.fg("dim", footer)));
    lines.push(botBorder);

    return lines;
  }
}
