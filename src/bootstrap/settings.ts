import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createSettings,
  type ConcurrencySettingsOwner,
  type DisplaySettingsOwner,
  type PromptSettingsOwner,
  type SettingsSummaryReader,
  type SpawnSettingsOwner,
} from "../modules/settings/public.js";
import { DEFAULT_CONCURRENCY_LIMIT } from "../modules/subagent-runtime/public.js";
import { effectiveAlternateModelKeys } from "../modules/model-access/public.js";
import { modelKey, scopedModelKeys } from "../models/model-scope.js";
import { runSettingsScreen } from "../platform/pi/tui/settings-screen.js";
import {
  createCustomPromptFile,
  customPromptFileExists,
} from "../platform/fs/prompt-files.js";
import { readConcurrencyFragment, updateConcurrencyLimits } from "./concurrency.js";
import { customPromptPath } from "./configuration.js";
import { getManager, getStore } from "../shell.js";
import { getAllTypes, setDefaultAgentsDisabled } from "../agents/agent-types.js";
import { showModelRoutingMenu } from "../ui/menu/menu-model-routing.js";
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

/**
 * Model keys that can actually schedule work right now: the parent model,
 * every routable alternate for every agent type, and the keys of accepted
 * sessions (still actionable after routing or scope changes).
 */
function activeModelKeys(ctx: ExtensionCommandContext): string[] {
  const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  const parentKey = ctx.model ? modelKey(ctx.model) : "";
  const keys = new Set<string>();
  if (parentKey) keys.add(parentKey);

  for (const type of getAllTypes()) {
    for (const key of effectiveAlternateModelKeys(
      type,
      getStore().routing,
      [...availableKeys],
      scopedKeys ? [...scopedKeys] : null,
      parentKey,
    )) keys.add(key);
  }

  for (const record of getManager()?.listSnapshots() ?? []) {
    keys.add(record.concurrencyKey);
  }
  return [...keys].sort();
}

function createConcurrencyOwner(ctx: ExtensionCommandContext): ConcurrencySettingsOwner {
  return {
    read() {
      const fragment = readConcurrencyFragment();
      const models = activeModelKeys(ctx);
      const providers = [...new Set(models.map((key) => key.split("/")[0]).filter((p): p is string => Boolean(p)))].sort();
      return {
        defaultLimit: fragment.default,
        factoryDefaultLimit: DEFAULT_CONCURRENCY_LIMIT,
        providerLimits: fragment.providers,
        modelLimits: fragment.models,
        activeProviders: providers,
        activeModels: models,
      };
    },
    update(update) {
      return updateConcurrencyLimits(update);
    },
  };
}

function createSummaryReader(): SettingsSummaryReader {
  return {
    read() {
      return {
        modelAccessEnabled: getStore().routing.enabled,
        concurrencyDefault: readConcurrencyFragment().default,
      };
    },
  };
}

const legacyCategoryMenus: Readonly<Record<string, (ctx: ExtensionCommandContext) => Promise<void>>> = {
  "model-access": showModelRoutingMenu,
  "debug": showDebugMenu,
};

/** `/agents` entry point: the settings workflow rendered through the Pi host. */
export async function showAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings({
    summaries: createSummaryReader(),
    display: createDisplayOwner(),
    spawn: createSpawnOwner(),
    prompt: createPromptOwner(),
    concurrency: createConcurrencyOwner(ctx),
  });
  await runSettingsScreen(ctx, settings, {
    openLegacyCategory: async (category) => {
      await legacyCategoryMenus[category]?.(ctx);
    },
  });
}
