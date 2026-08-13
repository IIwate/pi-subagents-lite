import type { ChildRecordSummary, LinePart, StatsVisibility } from "../contracts/navigator.js";

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export const STATS_SEP = " · ";

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatTurns(turnCount: number, maxTurns: number | null | undefined): LinePart {
  if (maxTurns == null) return { text: `${turnCount}⟳` };
  const ratio = turnCount / maxTurns;
  const text = ratio >= 0.8 ? `${turnCount}≤${maxTurns}⟳` : `${turnCount}⟳`;
  if (ratio >= 1) return { text, color: "error" };
  if (ratio >= 0.8) return { text, color: "warning" };
  return { text };
}

export function buildStatsParts(
  record: ChildRecordSummary,
  now: number,
  visible?: StatsVisibility,
): LinePart[] {
  const session = record.session;
  const invocation = record.invocation;
  const stats = record.stats;
  const parts: LinePart[] = [];
  const providerName = session?.provider ?? invocation?.providerName;
  const modelName = session?.modelId ?? invocation?.modelName;
  const thinkingLevel = session?.thinkingLevel ?? invocation?.thinkingLevel;
  if (providerName) parts.push({ text: providerName, color: "dim" });
  if (modelName) parts.push({ text: modelName, color: "dim" });
  if (thinkingLevel) parts.push({ text: thinkingLevel, color: "dim" });
  if (!stats) return parts;
  if (visible?.showTools !== false && stats.toolUses > 0) parts.push({ text: `${stats.toolUses} calls` });
  if (visible?.showTurns !== false && stats.turnCount != null && stats.turnCount > 0) {
    parts.push(formatTurns(stats.turnCount, stats.maxTurns));
  }
  if (visible?.showInput !== false || visible?.showOutput !== false) {
    const inputTokens = visible?.showInput !== false ? stats.input : 0;
    const outputTokens = visible?.showOutput !== false ? stats.output : 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const tokenParts: string[] = [];
      if (inputTokens > 0) tokenParts.push(`↑${formatTokens(inputTokens)}`);
      if (outputTokens > 0) tokenParts.push(`↓${formatTokens(outputTokens)}`);
      const annot: LinePart[] = [];
      const percent = visible?.showContext !== false
        ? (session?.found ? session.contextPercent ?? null : stats.contextPercent ?? null)
        : null;
      if (percent != null) {
        const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
        annot.push({ text: `${Math.round(percent)}%`, color });
      }
      const compactions = visible?.showContext !== false ? stats.compactionCount : 0;
      if (compactions > 0) annot.push({ text: `↻ ${compactions}`, color: "dim" });
      const tokenStr = tokenParts.join(" ");
      if (annot.length === 0) parts.push({ text: tokenStr });
      else {
        parts.push({ text: tokenStr });
        parts.push(...annot);
      }
    }
  }
  if (visible?.showCost !== false && stats.cost > 0) parts.push({ text: formatCost(stats.cost) });
  if (visible?.showTime !== false && record.startedAt != null) {
    const durationMs = (record.completedAt ?? now) - record.startedAt;
    parts.push({ text: formatMs(durationMs) });
  }
  return parts;
}
