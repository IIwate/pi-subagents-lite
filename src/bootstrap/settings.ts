import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createSettings,
  type ConcurrencySettingsOwner,
  type DebugSettingsOwner,
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
import { DEFAULT_GRACE_TURNS, readAgentSettings, updateAgentSetting } from "./agent-settings.js";
import { readConcurrencyFragment, updateConcurrencyLimits } from "./concurrency.js";
import { customPromptPath } from "./configuration.js";
import { createModelAccessSettingsOwner, readModelAccessFragment } from "./model-access.js";
import { getManager, getNavigator } from "../shell.js";
import { getAgentConfig, getAllTypes, setDefaultAgentsDisabled } from "../agents/agent-types.js";

// Owner adapters compose each settings page with the capability that owns
// its policy: the agent fragment seam, the concurrency seam, the
// model-access seam, and the live runtime/navigator.
function createDisplayOwner(): DisplaySettingsOwner {
  return {
    read() {
      const agent = readAgentSettings();
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
      return updateAgentSetting(id, value);
    },
  };
}

function createSpawnOwner(): SpawnSettingsOwner {
  return {
    read() {
      const agent = readAgentSettings();
      return {
        forceBackground: agent.forceBackground,
        graceTurns: agent.graceTurns,
        graceTurnsFallback: DEFAULT_GRACE_TURNS,
        disableDefaultAgents: agent.disableDefaultAgents,
      };
    },
    update(update) {
      const result = updateAgentSetting(update.id, update.value);
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
      const agent = readAgentSettings();
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
      return updateAgentSetting(update.id, update.value);
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

  const routing = readModelAccessFragment();
  for (const type of getAllTypes()) {
    for (const key of effectiveAlternateModelKeys(
      type,
      routing,
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

const RUNTIME_UNAVAILABLE = "Agent manager is not available in this session";
const CHILD_SCREEN_UNAVAILABLE = "Agent list is not available in this session";

function createDebugOwner(): DebugSettingsOwner {
  return {
    read() {
      const armedFault = getManager()?.debugDiagnostics().armedFault?.kind;
      return armedFault ? { armedFault } : {};
    },
    agentTypes() {
      return getAllTypes().flatMap((name) => {
        const config = getAgentConfig(name);
        if (!config) return [];
        return [{
          name,
          description: config.description,
          ...(config.registeredTools ? { tools: [...config.registeredTools] } : {}),
          ...(config.source ? { source: config.source } : {}),
          hidden: config.hidden === true,
        }];
      });
    },
    diagnostics() {
      const manager = getManager();
      if (!manager) return { ok: false, message: RUNTIME_UNAVAILABLE };
      const diagnostics = manager.debugDiagnostics();
      return {
        ok: true,
        diagnostics: {
          ...(diagnostics.armedFault ? { armedFault: diagnostics.armedFault.kind } : {}),
          agents: diagnostics.agents.map((agent) => ({
            id: agent.id,
            type: agent.type,
            status: agent.status,
            session: agent.session,
            settled: agent.settled,
            resultPersisted: agent.resultPersisted,
            resultConsumed: agent.resultConsumed,
            ...(agent.debugFaultKind ? { debugFaultKind: agent.debugFaultKind } : {}),
            ...(agent.error !== undefined ? { error: agent.error } : {}),
          })),
        },
      };
    },
    setStatusPreview(preview) {
      const navigator = getNavigator();
      if (!navigator) return { ok: false, message: CHILD_SCREEN_UNAVAILABLE };
      navigator.setDebugStatusPreview(preview ?? undefined);
      return { ok: true };
    },
    armFault(fault) {
      const manager = getManager();
      if (!manager) return { ok: false, message: RUNTIME_UNAVAILABLE };
      void manager.execute(fault ? { kind: "arm-debug-fault", fault } : { kind: "clear-debug-fault" });
      return { ok: true };
    },
  };
}

function createSummaryReader(): SettingsSummaryReader {
  return {
    read() {
      return {
        modelAccessEnabled: readModelAccessFragment().enabled,
        concurrencyDefault: readConcurrencyFragment().default,
      };
    },
  };
}

/** `/agents` entry point: the settings workflow rendered through the Pi host. */
export async function showAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings({
    summaries: createSummaryReader(),
    display: createDisplayOwner(),
    spawn: createSpawnOwner(),
    prompt: createPromptOwner(),
    concurrency: createConcurrencyOwner(ctx),
    debug: createDebugOwner(),
    modelAccess: createModelAccessSettingsOwner(ctx),
  });
  await runSettingsScreen(ctx, settings);
}
