/** Child-session footer formatting for the selected subagent screen. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { formatTokens } from "../agents/usage.js";
import type { Theme } from "./types.js";

type FooterUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
};

type ContextUsage = {
  percent: number | null;
  contextWindow: number;
};

function readLatestCacheHitRate(
  session: NonNullable<AgentRecord["execution"]["session"]>,
): number | undefined {
  try {
    const entries = session.sessionManager.getEntries() as Array<{
      type?: string;
      message?: {
        role?: string;
        usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
      };
    }>;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const usage = entry?.type === "message" && entry.message?.role === "assistant"
        ? entry.message.usage
        : undefined;
      if (!usage) continue;
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      return promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
    }
  } catch {
    // Session stats remain usable when entry inspection fails.
  }
  return undefined;
}

function readUsage(record: AgentRecord): FooterUsage {
  const session = record.execution.session;
  if (session) {
    try {
      const stats = session.getSessionStats();
      return {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        cost: stats.cost,
        latestCacheHitRate: readLatestCacheHitRate(session),
      };
    } catch {
      // Fall back to the manager's lifetime accumulator.
    }
  }

  const usage = record.stats.lifetimeUsage;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: 0,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  };
}

function readContextUsage(record: AgentRecord): ContextUsage {
  const session = record.execution.session;
  if (session) {
    try {
      const context = session.getContextUsage();
      return {
        percent: context?.percent ?? null,
        contextWindow: context?.contextWindow ?? session.model?.contextWindow ?? 0,
      };
    } catch {
      return {
        percent: record.stats.contextPercent ?? null,
        contextWindow: session.model?.contextWindow ?? 0,
      };
    }
  }
  return { percent: record.stats.contextPercent ?? null, contextWindow: 0 };
}

function usesSubscription(record: AgentRecord): boolean {
  const session = record.execution.session;
  const model = session?.model;
  if (!session || !model) return false;
  try {
    return session.modelRuntime.isUsingOAuth(model.provider);
  } catch {
    return false;
  }
}

function contextDisplay(
  context: ContextUsage,
  autoCompact: boolean,
  theme: Theme,
): string {
  const auto = autoCompact ? " (auto)" : "";
  const percent = context.percent;
  const text = percent === null
    ? `?/${formatTokens(context.contextWindow, true)}${auto}`
    : `${percent.toFixed(1)}%/${formatTokens(context.contextWindow, true)}${auto}`;
  if (percent !== null && percent > 90) return theme.fg("error", text);
  if (percent !== null && percent > 70) return theme.fg("warning", text);
  return text;
}

/** Render the token/context/model line used in place of Main's footer stats. */
export function renderAgentFooterStats(record: AgentRecord, theme: Theme, width: number): string {
  const session = record.execution.session;
  const usage = readUsage(record);
  const context = readContextUsage(record);
  const parts: string[] = [];

  if (usage.input) parts.push(`↑${formatTokens(usage.input, true)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output, true)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead, true)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite, true)}`);
  if ((usage.cacheRead || usage.cacheWrite) && usage.latestCacheHitRate !== undefined) {
    parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
  }
  const subscription = usesSubscription(record);
  if (usage.cost || subscription) {
    parts.push(`$${usage.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
  }
  parts.push(contextDisplay(context, session?.autoCompactionEnabled ?? true, theme));

  let statsLeft = parts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const model = session?.model;
  const modelName = model?.id ?? record.display.invocation?.modelName ?? "no-model";
  const providerName = model?.provider ?? record.display.invocation?.providerName;
  const identityLabel = providerName ? `${providerName} • ${modelName}` : modelName;
  const thinkingLevel = session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
  const showsThinking = model
    ? model.reasoning === true
    : record.display.invocation?.thinkingLevel !== undefined;
  const rightSide = showsThinking
    ? thinkingLevel === "off"
      ? `${identityLabel} • thinking off`
      : `${identityLabel} • ${thinkingLevel ?? "off"}`
    : identityLabel;
  const rightWidth = visibleWidth(rightSide);
  const minPadding = 2;

  let statsLine: string;
  if (statsLeftWidth + minPadding + rightWidth <= width) {
    statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + rightSide;
  } else {
    const available = width - statsLeftWidth - minPadding;
    if (available <= 0) {
      statsLine = statsLeft;
    } else {
      const truncatedRight = truncateToWidth(rightSide, available, "");
      statsLine = statsLeft
        + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)))
        + truncatedRight;
    }
  }

  const remainder = statsLine.slice(statsLeft.length);
  return theme.fg("dim", statsLeft) + theme.fg("dim", remainder);
}
