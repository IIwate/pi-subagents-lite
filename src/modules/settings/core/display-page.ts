import type {
  DisplaySettingsView,
  DisplayToggleId,
  SettingsRow,
} from "../contracts/settings-contracts.js";

interface DisplayToggleDefinition {
  id: DisplayToggleId;
  label: string;
  detail: string;
}

export const DISPLAY_TOGGLES: readonly DisplayToggleDefinition[] = [
  { id: "expandListByDefault", label: "Expand list by default", detail: "Start each new conversation with the agent list expanded." },
  { id: "showTools", label: "Show tools", detail: "Show tool call count (N calls) in the agent list." },
  { id: "showTurns", label: "Show turns", detail: "Show turn count (⟳ ) in the agent list." },
  { id: "showInput", label: "Show input tokens", detail: "Show input tokens (↑) in the agent list." },
  { id: "showOutput", label: "Show output tokens", detail: "Show output tokens (↓) in the agent list." },
  { id: "showContext", label: "Show context %", detail: "Show context-fill percent (%) in the agent list." },
  { id: "showCost", label: "Show cost", detail: "Show dollar cost ($) in the agent list." },
  { id: "showTime", label: "Show time", detail: "Show elapsed time in the agent list." },
];

export function displayToggleDefinition(id: string): DisplayToggleDefinition | undefined {
  return DISPLAY_TOGGLES.find((toggle) => toggle.id === id);
}

export function buildDisplayRows(view: DisplaySettingsView): SettingsRow[] {
  return DISPLAY_TOGGLES.map(({ id, label, detail }) => ({
    id,
    kind: "toggle" as const,
    label,
    detail,
    value: view[id] ? "ON" : "OFF",
    choices: ["ON", "OFF"],
  }));
}

/** The list-expansion default only takes effect on a new conversation, so the notice carries the reload hint. */
export function displayChangeNotice(id: DisplayToggleId, value: boolean): string {
  const definition = displayToggleDefinition(id)!;
  const reloadHint = id === "expandListByDefault" ? " · /reload to apply now" : "";
  return `${definition.label} ${value ? "ON" : "OFF"}${reloadHint}`;
}
