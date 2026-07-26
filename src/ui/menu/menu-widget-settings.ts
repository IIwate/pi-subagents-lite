/**
 * menu-widget-settings.ts — 显示设置菜单。
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Structure:
 *   Main list: thinkingBuffer, usageStats
 *   Usage stats submenu: 8 个统计可见性开关（作用于下方代理列表）
 *
 * Exports:
 *   - showWidgetSettingsMenu
 */

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
    if (stat) {
      stat.set(newValue === "ON");
      ctx.ui.notify(`${stat.label} ${newValue}`, "info");
      return;
    }

    if (id === "thinkingBuffer") {
      store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
      ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const statDescriptions: Record<string, string> = {
      showTools: "Show tool call count (N calls) in the agent list.",
      showTurns: "Show turn count (⟳ ) in the agent list.",
      showInput: "Show input tokens (↑) in the agent list.",
      deltaInputTokens: "Estimate input token delta for vLLM (no cache reporting).",
      showOutput: "Show output tokens (↓) in the agent list.",
      showContext: "Show context-fill percent (%) in the agent list.",
      showCost: "Show dollar cost ($) in the agent list.",
      showTime: "Show elapsed time in the agent list.",
    };
    const statItems: SettingItem[] = [...statConfig.entries()].map(([id, cfg]) => ({
      id,
      label: cfg.label,
      currentValue: cfg.get() ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: statDescriptions[id],
    }));

    const items: SettingItem[] = [
      {
        id: "thinkingBuffer",
        label: "Log file thinking buffer",
        currentValue: store.agent.outputThinkingBufferSize === 0 ? "OFF" : String(store.agent.outputThinkingBufferSize),
        values: ["OFF", "80", "200", "500", "1000"],
        description: "Controls log file thinking buffering in chars. OFF = only at turn end, 80 = flush after 80 chars.",
      },
      { id: "__sep__", label: " ", currentValue: "" },
      {
        id: "usageStats",
        label: "Usage stats",
        currentValue: "→",
        submenu: (_currentValue, done2) =>
          new SettingsList(statItems, 7, buildSettingsListTheme(theme), onChange, () => done2()),
        description: "Toggle which usage stats appear in the agent list.",
      },
    ];

    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Display Settings", theme, onCancel: () => done(undefined) });
  });
}
