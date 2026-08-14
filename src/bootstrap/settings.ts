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
import { DEFAULT_GRACE_TURNS } from "../modules/subagent-runtime/public.js";
import { readConcurrencyFragment, updateConcurrencyLimits } from "./concurrency.js";
import { customPromptPath } from "./configuration.js";
import type { ExtensionRuntime } from "./extension-runtime.js";
import { createModelAccessSettingsOwner, readModelAccessFragment } from "./model-access.js";

// Owner adapters compose each settings page with the capability that owns
// its policy: the agent fragment seam, the concurrency seam, the
// model-access seam, and the live runtime/navigator.
function createDisplayOwner(runtime: ExtensionRuntime): DisplaySettingsOwner {
  return {
    read() {
      const agent = runtime.agentSettings.read();
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
      return runtime.agentSettings.update(id, value);
    },
  };
}

function createSpawnOwner(runtime: ExtensionRuntime): SpawnSettingsOwner {
  return {
    read() {
      const agent = runtime.agentSettings.read();
      return {
        forceBackground: agent.forceBackground,
        graceTurns: agent.graceTurns,
        graceTurnsFallback: DEFAULT_GRACE_TURNS,
        disableDefaultAgents: agent.disableDefaultAgents,
      };
    },
    update(update) {
      const result = runtime.agentSettings.update(update.id, update.value);
      // Registry availability is an owner-side effect and must not run when
      // the commit failed, otherwise runtime and persisted policy diverge.
      if (result.ok && update.id === "disableDefaultAgents") {
        runtime.agents.setDefaultAgentsDisabled(update.value);
      }
      return result;
    },
  };
}

function createPromptOwner(runtime: ExtensionRuntime): PromptSettingsOwner {
  return {
    read() {
      const agent = runtime.agentSettings.read();
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
      return runtime.agentSettings.update(update.id, update.value);
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
function activeModelKeys(runtime: ExtensionRuntime, ctx: ExtensionCommandContext): string[] {
  const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
  const scopedKeys = scopedModelKeys(ctx.scopedModels);
  const parentKey = ctx.model ? modelKey(ctx.model) : "";
  const keys = new Set<string>();
  if (parentKey) keys.add(parentKey);

  const routing = readModelAccessFragment();
  for (const type of runtime.agents.allTypes()) {
    for (const key of effectiveAlternateModelKeys(
      type,
      routing,
      [...availableKeys],
      scopedKeys ? [...scopedKeys] : null,
      parentKey,
    )) keys.add(key);
  }

  for (const record of runtime.manager?.listSnapshots() ?? []) {
    keys.add(record.concurrencyKey);
  }
  return [...keys].sort();
}

function createConcurrencyOwner(runtime: ExtensionRuntime, ctx: ExtensionCommandContext): ConcurrencySettingsOwner {
  return {
    read() {
      const fragment = readConcurrencyFragment();
      const models = activeModelKeys(runtime, ctx);
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
      return updateConcurrencyLimits(update, runtime.manager);
    },
  };
}

const RUNTIME_UNAVAILABLE = "Agent manager is not available in this session";
const CHILD_SCREEN_UNAVAILABLE = "Agent list is not available in this session";

function createDebugOwner(runtime: ExtensionRuntime): DebugSettingsOwner {
  return {
    read() {
      const armedFault = runtime.manager?.debugDiagnostics().armedFault?.kind;
      return armedFault ? { armedFault } : {};
    },
    agentTypes() {
      return runtime.agents.allTypes().flatMap((name) => {
        const config = runtime.agents.agentConfig(name);
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
      const manager = runtime.manager;
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
      const navigator = runtime.navigator;
      if (!navigator) return { ok: false, message: CHILD_SCREEN_UNAVAILABLE };
      navigator.setDebugStatusPreview(preview ?? undefined);
      return { ok: true };
    },
    armFault(fault) {
      const manager = runtime.manager;
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
export async function showAgentsMenu(runtime: ExtensionRuntime, ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings({
    summaries: createSummaryReader(),
    display: createDisplayOwner(runtime),
    spawn: createSpawnOwner(runtime),
    prompt: createPromptOwner(runtime),
    concurrency: createConcurrencyOwner(runtime, ctx),
    debug: createDebugOwner(runtime),
    modelAccess: createModelAccessSettingsOwner(ctx, () => runtime.agents.allTypes()),
  });
  await runSettingsScreen(ctx, settings);
}
