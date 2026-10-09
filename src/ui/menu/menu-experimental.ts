/**
 * menu-experimental.ts — Experimental features menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 *
 * Exports:
 *   - showExperimentalMenu: opt-in experimental features
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildListTheme, saveSetting } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { MenuRuntime } from "./helpers.js";

export async function showExperimentalMenu(ctx: ExtensionCommandContext, runtime: MenuRuntime): Promise<void> {
  const store = runtime.store;

  const items: SettingItem[] = [
    {
      id: "executionBackend",
      label: "Execution backend",
      currentValue: store.experimental.executionBackend,
      values: ["in-process", "worker"],
      description: "Isolate new tasks in supervised worker processes on Linux and Windows. Existing tasks keep their backend.",
    },
    {
      id: "observationPacking",
      label: "Observation packing",
      currentValue: store.experimental.observationPacking ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Compress large tool results into stable placeholders after 2 full sends, with paged recall via obs_recall.",
    },
    {
      id: "actionFusion",
      label: "Action fusion",
      currentValue: store.experimental.actionFusion ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Let edit/write take an optional then_run command, fusing a mutation and its verification into one turn.",
    },
  ];

  let settingsList: SettingsList;
  const onChange = (id: string, newValue: string) => {
    const saved = saveSetting(ctx, () => {
      switch (id) {
        case "executionBackend":
          store.mutate.experimental.setExecutionBackend(newValue as "in-process" | "worker");
          ctx.ui.notify(`Execution backend set to ${newValue}`, "info");
          break;
        case "observationPacking":
          store.mutate.experimental.setObservationPacking(newValue === "ON");
          ctx.ui.notify(`Observation packing set to ${newValue}`, "info");
          break;
        case "actionFusion":
          store.mutate.experimental.setActionFusion(newValue === "ON");
          ctx.ui.notify(`Action fusion set to ${newValue}`, "info");
          break;
      }
    });
    if (!saved) {
      const original = id === "executionBackend" ? store.experimental.executionBackend
        : (id === "actionFusion" ? store.experimental.actionFusion : store.experimental.observationPacking) ? "ON" : "OFF";
      settingsList.updateValue(id, original);
    }
  };

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    settingsList = new SettingsList(items, 10, buildListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Experimental features", theme, onCancel: () => done(undefined) });
  });
}
