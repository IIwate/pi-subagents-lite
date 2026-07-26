/** Display settings for the below-editor agent list. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

/** Stat visibility config — label and store accessors keyed by stat id. */
function buildStatConfig(store: ReturnType<typeof getStore>) {
  return new Map<string, { label: string; get: () => boolean; set: (v: boolean) => void }>([
    ["showTools", { label: "Show tools", get: () => store.agent.showTools, set: (v) => store.mutate.agent.setShowTools(v) }],
    ["showTurns", { label: "Show turns", get: () => store.agent.showTurns, set: (v) => store.mutate.agent.setShowTurns(v) }],
    ["showInput", { label: "Show input tokens", get: () => store.agent.showInput, set: (v) => store.mutate.agent.setShowInput(v) }],
    ["deltaInputTokens", { label: "Delta input tokens", get: () => store.agent.deltaInputTokens, set: (v) => store.mutate.agent.setDeltaInputTokens(v) }],
    ["showOutput", { label: "Show output tokens", get: () => store.agent.showOutput, set: (v) => store.mutate.agent.setShowOutput(v) }],
    ["showContext", { label: "Show context %", get: () => store.agent.showContext, set: (v) => store.mutate.agent.setShowContext(v) }],
    ["showCost", { label: "Show cost", get: () => store.agent.showCost, set: (v) => store.mutate.agent.setShowCost(v) }],
    ["showTime", { label: "Show time", get: () => store.agent.showTime, set: (v) => store.mutate.agent.setShowTime(v) }],
  ]);
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const statConfig = buildStatConfig(store);

  const onChange = (id: string, newValue: string) => {
    const stat = statConfig.get(id);
    if (!stat) return;
    stat.set(newValue === "ON");
    ctx.ui.notify(`${stat.label} ${newValue}`, "info");
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const descriptions: Record<string, string> = {
      showTools: "Show tool call count (N calls) in the agent list.",
      showTurns: "Show turn count (⟳ ) in the agent list.",
      showInput: "Show input tokens (↑) in the agent list.",
      deltaInputTokens: "Estimate input token delta for vLLM (no cache reporting).",
      showOutput: "Show output tokens (↓) in the agent list.",
      showContext: "Show context-fill percent (%) in the agent list.",
      showCost: "Show dollar cost ($) in the agent list.",
      showTime: "Show elapsed time in the agent list.",
    };
    const items: SettingItem[] = [...statConfig.entries()].map(([id, cfg]) => ({
      id,
      label: cfg.label,
      currentValue: cfg.get() ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: descriptions[id],
    }));

    const settingsList = new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Display Settings", theme, onCancel: () => done(undefined) });
  });
}
