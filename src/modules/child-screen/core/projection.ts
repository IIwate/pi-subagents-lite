import type {
  ChildRecordSummary,
  ChildStatus,
  LinePart,
  RenderedLine,
  StatsVisibility,
} from "../contracts/navigator.js";
import type { TextLayout } from "../contracts/navigator.js";
import { buildStatsParts, STATS_SEP } from "./stats.js";
import {
  agentStatusColor,
  agentStatusLabel,
  displayNameOf,
  effectiveStatus,
  pendingLabel,
} from "./status.js";

const STATUS_COLUMN_GAP = 2;
const MIN_LEFT_COLUMN_WIDTH = 18;
const MIN_STATS_COLUMN_WIDTH = 12;

export function line(parts: LinePart[]): RenderedLine {
  return { parts };
}

export function lineText(rendered: RenderedLine): string {
  return rendered.parts.map((part) => part.text).join("");
}

function computeListWindow(
  entryCount: number,
  focusIndex: number,
  rows: number,
): { start: number; end: number } {
  const maxVisible = Math.min(6, Math.max(3, Math.floor(rows / 5)));
  const visibleCount = Math.min(entryCount, maxVisible);
  const maxStart = Math.max(0, entryCount - visibleCount);
  const start = Math.min(maxStart, Math.max(0, focusIndex - Math.floor(visibleCount / 2)));
  return { start, end: start + visibleCount };
}

function summaryParts(
  records: readonly ChildRecordSummary[],
  pending: number | undefined,
  notice: string | undefined,
  collapse: boolean,
  selected: boolean,
): LinePart[] {
  const running = records.filter((record) => record.status === "running").length;
  const queued = records.filter((record) => record.status === "queued").length;
  const parts: LinePart[] = [];
  if (notice) parts.push({ text: notice, color: "warning", bold: true });
  else {
    if (running > 0) parts.push({ text: `${running} running`, color: "dim" });
    if (queued > 0) parts.push({ text: `${queued} queued`, color: "dim" });
    parts.push({ text: `${records.length} total`, color: "dim" });
    if (pending) parts.push({ text: pendingLabel(pending), color: "warning" });
  }
  parts.push({ text: collapse ? "Alt+A collapse" : "Alt+A expand", color: "dim" });
  if (selected) parts.push({ text: "Alt+M main", color: "dim" });
  return parts;
}

function joinDim(parts: LinePart[]): LinePart[] {
  const joined: LinePart[] = [];
  parts.forEach((part, index) => {
    if (index > 0) joined.push({ text: STATS_SEP, color: "dim" });
    joined.push(part);
  });
  return joined;
}

// Main used to join these parts into one colorless string so truncate
// could take a single width. That was the moment Remove, Blocked, and
// the Main marker forgot the roles paint already knew how to apply.
// We cut part by part instead. A part that cannot fit is truncated
// with the layout's ellipsis and everything after it is dropped.
// Revisit if TextLayout grows a native part-aware cut.
function truncateParts(
  parts: readonly LinePart[],
  width: number,
  layout: TextLayout,
): LinePart[] {
  const out: LinePart[] = [];
  let used = 0;
  for (const part of parts) {
    const remaining = width - used;
    if (remaining <= 0) break;
    const partWidth = layout.visibleWidth(part.text);
    if (partWidth <= remaining) {
      out.push(part);
      used += partWidth;
      continue;
    }
    const cut = layout.truncate(part.text, remaining);
    if (cut) {
      const next: LinePart = { text: cut };
      if (part.color) next.color = part.color;
      if (part.bold) next.bold = part.bold;
      out.push(next);
    }
    break;
  }
  return out;
}

export function projectFooterStatus(
  records: readonly ChildRecordSummary[],
  options: {
    listExpanded: boolean;
    pending?: number;
    notice?: string;
    selected: boolean;
  },
): LinePart[] | undefined {
  if ((records.length === 0 && !options.pending) || options.listExpanded) return undefined;
  const title = records.length === 1 ? "Subagent" : "Subagents";
  return [
    { text: `${title} (`, color: "dim" },
    ...joinDim(summaryParts(records, options.pending, options.notice, false, options.selected)),
    { text: ")", color: "dim" },
  ];
}

function renderAgentRow(
  leftPrefix: string,
  leftPrefixParts: LinePart[],
  description: string,
  stats: string,
  width: number,
  prefixWidth: number,
  layout: TextLayout,
): RenderedLine {
  const statsWidth = Math.max(0, width - Math.max(MIN_LEFT_COLUMN_WIDTH, prefixWidth) - STATUS_COLUMN_GAP);
  const statsText = statsWidth > 0 ? layout.truncate(stats, statsWidth, "…") : "";
  const leftWidth = statsText
    ? Math.max(0, width - layout.visibleWidth(statsText) - STATUS_COLUMN_GAP)
    : width;
  if (leftWidth < prefixWidth) {
    return line([{ text: layout.truncate(leftPrefix, leftWidth, "…") }]);
  }
  const descriptionWidth = Math.max(0, leftWidth - prefixWidth - STATUS_COLUMN_GAP);
  const renderedDescription = descriptionWidth > 0 && description
    ? `  ${layout.truncate(description, descriptionWidth, "…")}`
    : "";
  const leftText = `${leftPrefix}${renderedDescription}`;
  if (!statsText) {
    return line([
      ...leftPrefixParts,
      ...(renderedDescription ? [{ text: renderedDescription, color: "dim" }] : []),
    ]);
  }
  const padding = Math.max(0, width - layout.visibleWidth(leftText) - layout.visibleWidth(statsText));
  return line([
    ...leftPrefixParts,
    ...(renderedDescription ? [{ text: renderedDescription, color: "dim" }] : []),
    { text: `${" ".repeat(padding)}${statsText}`, color: "dim" },
  ]);
}

export function projectList(options: {
  records: readonly ChildRecordSummary[];
  selectedAgentId: string | null;
  highlightedAgentId: string | null;
  listFocused: boolean;
  confirmingClearId: string | null;
  interactionNotice?: string;
  pending?: number;
  columns: number;
  rows: number;
  now: number;
  preview?: ChildStatus;
  statsVisibility?: StatsVisibility;
  layout: TextLayout;
}): RenderedLine[] {
  const {
    records, selectedAgentId, highlightedAgentId, listFocused, confirmingClearId,
    interactionNotice, pending, columns, rows, now, preview, statsVisibility, layout,
  } = options;
  if (records.length === 0 && !pending) return [];
  const lines: RenderedLine[] = [];
  const commandWidth = Math.max(1, columns - 2);
  const highlighted = records.find((record) => record.id === highlightedAgentId);
  if (listFocused) {
    if (confirmingClearId) {
      const record = records.find((item) => item.id === confirmingClearId);
      const target = layout.truncate(record?.description ?? "agent", 32);
      lines.push(line([
        { text: "  " },
        ...truncateParts([
          { text: `Remove “${target}”? · Enter `, color: "dim" },
          { text: "Remove", color: "error" },
          { text: " · Esc Cancel", color: "dim" },
        ], commandWidth, layout),
      ]));
    } else {
      const pinHint = highlighted ? ` · Space ${highlighted.pinned ? "Unpin" : "Pin"}` : "";
      lines.push(line([{
        text: layout.truncate(`↑↓ Move · Enter Open${pinHint} · Ctrl+D Remove · Esc Editor`, commandWidth),
        color: "dim",
      }].map((part) => ({ ...part, text: `  ${part.text}` }))));
    }
  }

  const mainActive = selectedAgentId === null;
  const mainHighlighted = listFocused && highlightedAgentId === null;
  const focusIndex = Math.max(0, records.findIndex((record) =>
    record.id === (listFocused ? highlightedAgentId : selectedAgentId),
  ));
  const { start, end } = computeListWindow(records.length, Math.max(0, focusIndex), rows);
  const summary = joinDim(summaryParts(records, pending, interactionNotice, true, selectedAgentId != null));
  const mainLine: LinePart[] = [
    mainHighlighted ? { text: "›", color: "accent" } : { text: " " },
    { text: " " },
    { text: mainActive ? "●" : "○", color: mainActive ? "accent" : "dim" },
    { text: " " },
    mainActive || mainHighlighted ? { text: "Main", bold: true } : { text: "Main" },
    { text: " (", color: "dim" },
    ...summary,
    { text: ")", color: "dim" },
  ];
  lines.push(line(truncateParts(mainLine, columns, layout)));

  if (start > 0) {
    lines.push(line([{ text: `  ↑ ${start} hidden`, color: "dim" }]));
  }

  for (const record of records.slice(start, end)) {
    const active = record.id === selectedAgentId;
    const rowHighlighted = listFocused && record.id === highlightedAgentId;
    const indicatorText = record.pinned ? (active ? "◆" : "◇") : active ? "●" : "○";
    const status = effectiveStatus(record, preview);
    const plainStatus = agentStatusLabel(status);
    const debugBadge = record.debugFaultKind ? " [DEBUG]" : "";
    const name = displayNameOf(record);
    const statsParts = buildStatsParts(record, now, statsVisibility);
    const stats = statsParts.map((part) => part.text).join(STATS_SEP);
    const identityStats = [record.session?.provider ?? record.invocation?.providerName, record.session?.modelId ?? record.invocation?.modelName]
      .filter(Boolean)
      .join(STATS_SEP);
    const reservedStatsWidth = Math.max(MIN_STATS_COLUMN_WIDTH, layout.visibleWidth(identityStats));
    const fixedPrefix = `${rowHighlighted ? "›" : " "} ${indicatorText} `;
    const plainStatusSuffix = `${debugBadge} (${plainStatus})`;
    const maxNameWidth = Math.max(
      1,
      columns - layout.visibleWidth(fixedPrefix) - layout.visibleWidth(plainStatusSuffix) - STATUS_COLUMN_GAP - reservedStatsWidth,
    );
    const visibleNameText = layout.truncate(name, maxNameWidth, "…");
    const leftPrefix = `${fixedPrefix}${visibleNameText}${plainStatusSuffix}`;
    const prefixWidth = layout.visibleWidth(fixedPrefix)
      + layout.visibleWidth(visibleNameText)
      + layout.visibleWidth(plainStatusSuffix);
    const leftParts: LinePart[] = [
      { text: rowHighlighted ? "›" : " ", color: rowHighlighted ? "accent" : undefined },
      { text: " " },
      { text: indicatorText, color: active || record.pinned ? "accent" : "dim" },
      { text: " " },
      { text: visibleNameText, bold: active || rowHighlighted },
      ...(record.debugFaultKind ? [{ text: " " }, { text: "[DEBUG]", color: "accent", bold: true }] : []),
      { text: " (" },
      { text: plainStatus, color: agentStatusColor(status) },
      { text: ")" },
    ];
    lines.push(renderAgentRow(
      leftPrefix,
      leftParts,
      record.description,
      stats,
      columns,
      prefixWidth,
      layout,
    ));
  }

  if (end < records.length) {
    lines.push(line([{ text: `  ↓ ${records.length - end} hidden`, color: "dim" }]));
  }
  return lines;
}
