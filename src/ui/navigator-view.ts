import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildStatsParts, displayText, formatModelIdentity, STATS_SEP, type StatsVisibility } from "./format.js";
import type { Theme } from "./types.js";
import type { NavigationAgent, NavigationStatus, NavigatorViewState } from "./navigation.js";

const STATUS_COLUMN_GAP = 2;
const MIN_LEFT_COLUMN_WIDTH = 18;
const MIN_STATS_COLUMN_WIDTH = 12;
const DESIRED_DESCRIPTION_WIDTH = 40;

function pendingLabel(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"} pending`;
}

function renderAgentRow(
  leftPrefix: string,
  description: string,
  stats: string,
  width: number,
  prefixWidth: number,
  theme: Theme,
): string {
  const statsWidth = Math.max(0, width - Math.max(MIN_LEFT_COLUMN_WIDTH, prefixWidth) - STATUS_COLUMN_GAP);
  const statsText = statsWidth > 0 ? truncateToWidth(stats, statsWidth, "…") : "";
  const leftWidth = statsText
    ? Math.max(0, width - visibleWidth(statsText) - STATUS_COLUMN_GAP)
    : width;
  if (leftWidth < prefixWidth) return truncateToWidth(leftPrefix, leftWidth, "…");

  const descriptionWidth = Math.max(0, leftWidth - prefixWidth - STATUS_COLUMN_GAP);
  const renderedDescription = descriptionWidth > 0 && description
    ? `  ${theme.fg("dim", truncateToWidth(description, descriptionWidth, "…"))}`
    : "";
  const leftText = `${leftPrefix}${renderedDescription}`;
  if (!statsText) return leftText;
  const padding = Math.max(0, width - visibleWidth(leftText) - visibleWidth(statsText));
  return `${leftText}${" ".repeat(padding)}${statsText}`;
}

function applySelectedBackground(line: string, width: number, theme: Theme): string {
  if (!theme.bg) return line;
  const padding = Math.max(0, width - visibleWidth(line));
  const paddedLine = `${line}${" ".repeat(padding)}`;
  const sample = theme.bg("selectedBg", "");
  const bgMatch = sample.match(/^\x1b\[[0-9;]*m/);
  if (!bgMatch) return theme.bg("selectedBg", paddedLine);
  const bgCode = bgMatch[0];
  const restored = paddedLine.replace(/\x1b\[0?m/g, (match) => `${match}${bgCode}`);
  return theme.bg("selectedBg", restored);
}

function agentStatusLabel(status: NavigationStatus): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "cancelling": return "Cancelling";
    case "completed": return "Done";
    case "turn_limited": return "Turn limit";
    case "aborted": return "Aborted";
    case "stopped": return "Stopped";
    case "error": return "Error";
  }
}

export function plainAgentStatus(record: NavigationAgent): string {
  if (record.execution.retryState) {
    return `Retrying ${record.execution.retryState.attempt}/${record.execution.retryState.maxAttempts}`;
  }
  return agentStatusLabel(record.lifecycle.status);
}

function renderAgentStatus(
  record: NavigationAgent,
  theme: Theme,
): string {
  if (record.execution.retryState) {
    return theme.fg("warning", `Retrying ${record.execution.retryState.attempt}/${record.execution.retryState.maxAttempts}`);
  }
  const statusValue = record.lifecycle.status;
  const color = statusValue === "turn_limited" || statusValue === "aborted"
    ? "warning"
    : statusValue === "running"
      ? "accent"
      : statusValue === "completed"
        ? "success"
        : statusValue === "error"
          ? "error"
          : "dim";
  return theme.fg(color, agentStatusLabel(statusValue));
}

function computeListWindow(
  entryCount: number,
  focusIndex: number,
  rows: number,
): { start: number; end: number; visibleCount: number } {
  const maxVisible = Math.min(6, Math.max(3, Math.floor(rows / 5)));
  const visibleCount = Math.min(entryCount, maxVisible);
  const maxStart = Math.max(0, entryCount - visibleCount);
  const start = Math.min(maxStart, Math.max(0, focusIndex - Math.floor(visibleCount / 2)));
  return { start, end: start + visibleCount, visibleCount };
}

/** Pure terminal formatting over an already prepared display snapshot. */
export class NavigatorView {
  render(state: NavigatorViewState, width: number, rows: number): string[] {
    const theme = state.theme;
    // Keep the registered component stable across idle periods. Removing and re-adding the
    // whole below-editor widget corrupts Pi's differential row cache when the next editor
    // update arrives; an empty render preserves identity while contributing zero height.
    const records = state.records;
    const pending = state.pending;
    if ((records.length === 0 && !pending) || !state.listExpanded) return [];

    const entries = [{ id: null, record: undefined }, ...records.map(record => ({ id: record.id, record }))];
    const agentEntries = entries.slice(1);
    const focusId = state.listFocused ? state.highlightedId : state.selectedId;
    const agentFocusIndex = Math.max(0, agentEntries.findIndex(entry => entry.id === focusId));
    const { start, end } = computeListWindow(agentEntries.length, agentFocusIndex, rows);
    const visibleEntries = agentEntries.slice(start, end);
    const highlightedRecord = entries.find(entry => entry.id === state.highlightedId)?.record;

    // No permanent header chrome; show one contextual command bar while navigating.
    // The two-column prefix aligns it with the row circles, not the focus marker.
    const lines: string[] = [];
    const cols = width;
    const commandWidth = Math.max(1, cols - 1);
    if (state.listFocused) {
      if (state.confirmingClearId !== null) {
        const record = records.find(record => record.id === state.confirmingClearId);
        const target = truncateToWidth(displayText(record?.display.description ?? "agent"), 32);
        const confirmation = [
          theme.fg("dim", `Remove “${target}”? · Enter `),
          theme.fg("error", "Remove"),
          theme.fg("dim", " · Esc Cancel"),
        ].join("");
        lines.push(` ${truncateToWidth(confirmation, commandWidth)}`);
      } else {
        let commandText: string;
        if (highlightedRecord?.canDeliver) {
          commandText = "↑↓ Move · Enter Open · Space Unpin · Alt+S Deliver · Ctrl+D Remove · Esc Editor";
        } else {
          const pinHint = highlightedRecord
            ? ` · Space ${highlightedRecord.lifecycle.pinnedAt != null ? "Unpin" : "Pin"}`
            : "";
          commandText = `↑↓ Move · Enter Open${pinHint}${highlightedRecord ? " · Alt+T Take over" : ""} · Ctrl+D Remove · Esc Editor`;
        }
        lines.push(` ${truncateToWidth(
          theme.fg("dim", commandText),
          commandWidth,
        )}`);
      }
    }
    const mainActive = state.selectedId === null;
    const mainHighlighted = state.listFocused && state.highlightedId === null;
    const mainIndicator = mainActive ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const mainLabel = mainActive || mainHighlighted ? theme.bold("Main") : "Main";
    const running = records.filter(record => record.lifecycle.status === "running").length;
    const queued = records.filter(record => record.lifecycle.status === "queued").length;
    const summaryParts: string[] = [];
    if (state.notice) {
      summaryParts.push(theme.bold(theme.fg("warning", displayText(state.notice))));
    } else {
      if (running > 0) summaryParts.push(theme.fg("dim", `${running} running`));
      if (queued > 0) summaryParts.push(theme.fg("dim", `${queued} queued`));
      summaryParts.push(theme.fg("dim", `${records.length} total`));
      if (pending) summaryParts.push(theme.fg("warning", pendingLabel(pending)));
    }
    summaryParts.push(theme.fg("dim", "Alt+A collapse"));
    if (state.selectedId) summaryParts.push(theme.fg("dim", "Alt+M main"));
    const summary = summaryParts.join(theme.fg("dim", " · "));
    const mainText = ` ${mainIndicator} ${mainLabel}${theme.fg("dim", " (")}${summary}${theme.fg("dim", ")")}`;
    let mainLine = truncateToWidth(mainText, width);
    if (mainHighlighted) {
      mainLine = applySelectedBackground(mainLine, width, theme);
    }
    lines.push(mainLine);

    if (start > 0) {
      lines.push(theme.fg("dim", ` ↑ ${start} hidden`));
    }

    for (const entry of visibleEntries) {
      const record = entry.record!;
      const active = entry.id === state.selectedId;
      const highlighted = state.listFocused && entry.id === state.highlightedId;
      const pinned = record.lifecycle.pinnedAt != null;
      const indicator = active
        ? theme.fg("accent", "●")
        : theme.fg("dim", "○");
      const name = displayText(record.display.name).replace(/\n/g, " ");
      const description = displayText(record.display.description).replace(/\n/g, " ");
      const durationMs = (record.lifecycle.completedAt ?? state.now) - record.lifecycle.startedAt;
      const { modelName, providerName, thinkingLevel } = record.execution;
      const parentModel = state.parentModel;
      const plainStatus = plainAgentStatus(record);
      const status = renderAgentStatus(record, theme);
      const fixedPrefix = ` ${indicator} `;
      const pinBadge = pinned ? ` ${theme.fg("accent", "◆")}` : "";
      const plainPinBadge = pinned ? " ◆" : "";
      const statusSuffix = ` (${status})${pinBadge}`;
      const plainStatusSuffix = ` (${plainStatus})${plainPinBadge}`;
      const identityStr = formatModelIdentity({
        providerName,
        modelName,
        thinkingLevel,
      }, parentModel);
      const reservedStatsWidth = identityStr
        ? Math.max(MIN_STATS_COLUMN_WIDTH, visibleWidth(identityStr))
        : 0;
      const maxNameWidth = Math.max(
        1,
        width
          - visibleWidth(fixedPrefix)
          - visibleWidth(plainStatusSuffix)
          - STATUS_COLUMN_GAP
          - reservedStatsWidth,
      );
      const visibleNameText = truncateToWidth(name, maxNameWidth, "…");
      const visibleName = active || highlighted ? theme.bold(visibleNameText) : visibleNameText;
      const leftPrefix = `${fixedPrefix}${visibleName}${statusSuffix}`;
      const prefixWidth = visibleWidth(fixedPrefix)
        + visibleWidth(visibleNameText)
        + visibleWidth(plainStatusSuffix);

      const buildStats = (vis: StatsVisibility): string => {
        const parts = buildStatsParts({
          modelName,
          providerName,
          thinkingLevel,
          parent: parentModel,
          toolUses: record.stats.toolUses,
          turnCount: record.stats.turnCount != null && record.stats.turnCount > 0
            ? record.stats.turnCount
            : undefined,
          maxTurns: record.stats.maxTurns,
          input: record.stats.lifetimeUsage.input,
          output: record.stats.lifetimeUsage.output,
          contextPercent: record.stats.contextPercent ?? null,
          compactions: record.stats.compactionCount,
          cost: record.stats.lifetimeUsage.cost,
          durationMs,
        }, theme, vis);
        return parts.length > 0 ? theme.fg("dim", parts.join(STATS_SEP)) : "";
      };

      let stats = buildStats(state.statsVisibility);
      const targetDescWidth = description
        ? Math.min(DESIRED_DESCRIPTION_WIDTH, visibleWidth(description))
        : 0;
      const getAvailableDescWidth = (statsStr: string) => {
        const statsW = visibleWidth(statsStr);
        return width - prefixWidth - (statsW > 0 ? statsW + STATUS_COLUMN_GAP * 2 : 0);
      };

      if (targetDescWidth > 0 && getAvailableDescWidth(stats) < targetDescWidth) {
        // Level 1 degradation: drop token counts and cost
        stats = buildStats({
          ...state.statsVisibility,
          showInput: false,
          showOutput: false,
          showCost: false,
        });

        // Level 2 degradation: drop context percentage and turn counts if still tight
        if (getAvailableDescWidth(stats) < targetDescWidth) {
          stats = buildStats({
            ...state.statsVisibility,
            showInput: false,
            showOutput: false,
            showCost: false,
            showContext: false,
            showTurns: false,
          });
        }
      }

      let agentLine = renderAgentRow(
        leftPrefix,
        description,
        stats,
        width,
        prefixWidth,
        theme,
      );
      if (highlighted) {
        agentLine = applySelectedBackground(agentLine, width, theme);
      }
      lines.push(agentLine);
    }

    if (end < agentEntries.length) {
      lines.push(theme.fg("dim", ` ↓ ${agentEntries.length - end} hidden`));
    }

    return lines;
  }

  collapsed(state: NavigatorViewState): string | undefined {
    const { records, pending, theme } = state;
    if ((!records.length && !pending) || state.listExpanded) return;
    const running = records.filter(record => record.lifecycle.status === "running").length;
    const queued = records.filter(record => record.lifecycle.status === "queued").length;
    const parts: string[] = [];
    if (state.notice) parts.push(theme.bold(theme.fg("warning", displayText(state.notice))));
    else {
      if (running) parts.push(theme.fg("dim", `${running} running`));
      if (queued) parts.push(theme.fg("dim", `${queued} queued`));
      parts.push(theme.fg("dim", `${records.length} total`));
      if (pending) parts.push(theme.fg("warning", pendingLabel(pending)));
    }
    parts.push(theme.fg("dim", "Alt+A expand"));
    if (state.selectedId) parts.push(theme.fg("dim", "Alt+M main"));
    return `${theme.fg("dim", `${records.length === 1 ? "Subagent" : "Subagents"} (`)}${parts.join(theme.fg("dim", " · "))}${theme.fg("dim", ")")}`;
  }
}

export function renderPending(record: NavigationAgent | undefined, width: number, theme: Theme): string[] {
  if (!record?.queued.length) return [];
  return ["", ...record.queued.map(item => truncateToWidth(theme.fg("dim",
    `${item.kind === "steer" ? "Steering" : item.kind === "followUp" ? "Follow-up" : "Pending"}: ${displayText(item.input.text).replace(/\n/g, " ")}`), width)),
    truncateToWidth(theme.fg("dim", "↳ Alt+Up to edit all queued messages"), width)];
}

export function renderRetry(record: NavigationAgent | undefined, width: number, theme: Theme, now: number): string[] {
  const retry = record?.execution.retryState;
  if (!retry) return [];
  const seconds = Math.ceil(Math.max(0, retry.delayMs - (now - retry.startAt)) / 1000);
  return [truncateToWidth(theme.fg("warning", `↻ Retrying (${retry.attempt}/${retry.maxAttempts}) in ${seconds}s... (Esc to cancel)`), width)];
}
