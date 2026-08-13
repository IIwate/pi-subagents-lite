import type { RootSummaries, SettingsRow } from "../contracts/settings-contracts.js";

export function buildRootRows(summaries: RootSummaries): SettingsRow[] {
  return [
    {
      id: "model-access",
      kind: "category",
      label: "Model access",
      detail: summaries.modelAccessEnabled
        ? "Alternates ON · Provider and Agent access"
        : "Alternates OFF · Parent access only",
    },
    {
      id: "concurrency",
      kind: "category",
      label: "Concurrency settings",
      detail: `${summaries.concurrencyDefault} slots per model`,
    },
    {
      id: "spawn-options",
      kind: "category",
      label: "Spawn options",
      detail: "Background, limits, and Agent availability",
    },
    {
      id: "system-prompt",
      kind: "category",
      label: "System prompt",
      detail: "Prompt mode, custom prompt file, AGENTS.md",
    },
    {
      id: "display",
      kind: "category",
      label: "Display settings",
      detail: "List defaults and stats visibility",
    },
    {
      id: "debug",
      kind: "category",
      label: "Debug",
      detail: "Agent types, diagnostics, and fault injection",
    },
  ];
}
