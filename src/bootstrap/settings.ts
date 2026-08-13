import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createSettings,
  type DisplaySettingsOwner,
  type SettingsSummaryReader,
} from "../modules/settings/public.js";
import { runSettingsScreen } from "../platform/pi/tui/settings-screen.js";
import { getStore } from "../shell.js";
import { showModelRoutingMenu } from "../ui/menu/menu-model-routing.js";
import { showConcurrencySettingsMenu } from "../ui/menu/menu-concurrency.js";
import { showSpawnOptionsMenu } from "../ui/menu/menu-spawn-options.js";
import { showSystemPromptMenu } from "../ui/menu/menu-system-prompt.js";
import { showDebugMenu } from "../ui/menu/menu-debug.js";

// Transitional owner adapters over ConfigStore. Each settings slice replaces
// one adapter with the true policy-owning capability; the getStore() reads
// disappear with the store itself.
function createDisplayOwner(): DisplaySettingsOwner {
  return {
    read() {
      const agent = getStore().agent;
      return {
        expandListByDefault: agent.expandListByDefault,
        showTools: agent.showTools,
        showTurns: agent.showTurns,
        showInput: agent.showInput,
        showOutput: agent.showOutput,
        showContext: agent.showContext,
        showCost: agent.showCost,
        showTime: agent.showTime,
      };
    },
    update(id, value) {
      return getStore().updateDisplaySetting(id, value);
    },
  };
}

function createSummaryReader(): SettingsSummaryReader {
  return {
    read() {
      const store = getStore();
      return {
        modelAccessEnabled: store.routing.enabled,
        concurrencyDefault: store.concurrency.default,
      };
    },
  };
}

const legacyCategoryMenus: Readonly<Record<string, (ctx: ExtensionCommandContext) => Promise<void>>> = {
  "model-access": showModelRoutingMenu,
  "concurrency": showConcurrencySettingsMenu,
  "spawn-options": showSpawnOptionsMenu,
  "system-prompt": showSystemPromptMenu,
  "debug": showDebugMenu,
};

/** `/agents` entry point: the settings workflow rendered through the Pi host. */
export async function showAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings({
    summaries: createSummaryReader(),
    display: createDisplayOwner(),
  });
  await runSettingsScreen(ctx, settings, {
    openLegacyCategory: async (category) => {
      await legacyCategoryMenus[category]?.(ctx);
    },
  });
}
