import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createSettings,
  type DisplaySettingsOwner,
  type PromptSettingsOwner,
  type SettingsSummaryReader,
  type SpawnSettingsOwner,
} from "../modules/settings/public.js";
import { runSettingsScreen } from "../platform/pi/tui/settings-screen.js";
import {
  createCustomPromptFile,
  customPromptFileExists,
} from "../platform/fs/prompt-files.js";
import { customPromptPath } from "./configuration.js";
import { getStore } from "../shell.js";
import { setDefaultAgentsDisabled } from "../agents/agent-types.js";
import { showModelRoutingMenu } from "../ui/menu/menu-model-routing.js";
import { showConcurrencySettingsMenu } from "../ui/menu/menu-concurrency.js";
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
      return getStore().updateAgentSetting(id, value);
    },
  };
}

function createSpawnOwner(): SpawnSettingsOwner {
  return {
    read() {
      const agent = getStore().agent;
      return {
        forceBackground: agent.forceBackground,
        graceTurns: agent.graceTurns,
        disableDefaultAgents: agent.disableDefaultAgents,
      };
    },
    update(update) {
      const result = getStore().updateAgentSetting(update.id, update.value);
      // Registry availability is an owner-side effect and must not run when
      // the commit failed, otherwise runtime and persisted policy diverge.
      if (result.ok && update.id === "disableDefaultAgents") {
        setDefaultAgentsDisabled(update.value);
      }
      return result;
    },
  };
}

function createPromptOwner(): PromptSettingsOwner {
  return {
    read() {
      const agent = getStore().agent;
      return {
        systemPromptMode: agent.systemPromptMode,
        includeContextFiles: agent.includeContextFiles,
        loadSkillsImplicitly: agent.loadSkillsImplicitly,
        loadExtensionsImplicitly: agent.loadExtensionsImplicitly,
        customPromptPath,
        customPromptFileExists: customPromptFileExists(customPromptPath),
      };
    },
    update(update) {
      return getStore().updateAgentSetting(update.id, update.value);
    },
    createCustomPromptFile() {
      return createCustomPromptFile(customPromptPath);
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
  "debug": showDebugMenu,
};

/** `/agents` entry point: the settings workflow rendered through the Pi host. */
export async function showAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings({
    summaries: createSummaryReader(),
    display: createDisplayOwner(),
    spawn: createSpawnOwner(),
    prompt: createPromptOwner(),
  });
  await runSettingsScreen(ctx, settings, {
    openLegacyCategory: async (category) => {
      await legacyCategoryMenus[category]?.(ctx);
    },
  });
}
