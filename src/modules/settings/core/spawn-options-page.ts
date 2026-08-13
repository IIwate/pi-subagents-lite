import type { SettingsRow, SpawnSettingsView } from "../contracts/settings-contracts.js";

/** Grace turns below this are rejected; 0 means an immediate hard stop after the soft limit. */
export const GRACE_TURNS_MINIMUM = 0;

export function buildSpawnOptionsRows(view: SpawnSettingsView): SettingsRow[] {
  return [
    {
      id: "forceBackground",
      kind: "toggle",
      label: "Force background",
      detail: "Spawn every agent in the background by default (no foreground wait).",
      value: view.forceBackground ? "ON" : "OFF",
      choices: ["ON", "OFF"],
    },
    {
      id: "graceTurns",
      kind: "numeric",
      label: "Grace turns",
      detail: "Extra turns after the soft turn limit before a hard abort.",
      value: String(view.graceTurns),
      min: GRACE_TURNS_MINIMUM,
      fallback: view.graceTurnsFallback,
    },
    {
      id: "disableDefaultAgents",
      kind: "toggle",
      label: "Disable default agents",
      detail: "Block new uses of built-in agent types; existing agents continue.",
      value: view.disableDefaultAgents ? "ON" : "OFF",
      choices: ["ON", "OFF"],
    },
  ];
}

export function spawnChangeNotice(id: "forceBackground" | "graceTurns" | "disableDefaultAgents", value: boolean | number): string {
  switch (id) {
    case "forceBackground":
      return `Force background set to ${value === true ? "ON" : "OFF"}`;
    case "graceTurns":
      return `Grace turns set to ${value}`;
    case "disableDefaultAgents":
      return `Default agents ${value === true ? "disabled" : "enabled"}`;
  }
}
