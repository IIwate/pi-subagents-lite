import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { registerAgents, setAgentScanDirs } from "./agents/agent-types.js";
import type { AgentConfig } from "./agents/types.js";
import { createAgentCatalogueRuntime } from "./bootstrap/agent-catalogue.js";
import { createConfigurationRuntime } from "./bootstrap/configuration.js";
import {
  AgentCatalogueConfigurationSchema,
  type AgentDefinitionSnapshot,
} from "./modules/agent-catalogue/public.js";
import { createHostSubagentRuntime } from "./bootstrap/subagent-runtime.js";
import { AgentNavigator } from "./ui/agent-navigator.js";
import { createParentGuidanceRuntime } from "./bootstrap/prompt.js";
import {
  getManager,
  getNavigator,
  getStore,
  getPiInstance,
  getSessionCtx,
  setSessionCtx,
  setManager,
  setNavigator,
} from "./shell.js";
import { bindSessionHost, createSessionHost, currentSessionHost } from "./bootstrap/session-host.js";

const agentCatalogue = createAgentCatalogueRuntime();
const configuration = createConfigurationRuntime();
const parentGuidance = createParentGuidanceRuntime();

function toAgentConfig(definition: AgentDefinitionSnapshot): AgentConfig {
  const { source, ...config } = structuredClone(definition);
  return source === "built-in" ? config : { ...config, source };
}

// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the manager, coordinator, and navigator exist.
 * Idempotent — safe to call on every session_start.
 */
export function ensureManagerAndNavigator(): void {
  const currentManager = getManager();
  const currentNavigator = getNavigator();

  // Create manager if missing
  if (!currentManager) {
    // Coordinator will be created after manager, so use a placeholder onComplete
    // that we'll replace once coordinator is created.
    const newManager = createHostSubagentRuntime({
      pi: getPiInstance(),
      ctx: getSessionCtx(),
      limits: getStore().concurrency,
    });
    setManager(newManager);
    getStore().setDeps({ manager: newManager });

    const coordinator = createSessionHost(newManager);
    bindSessionHost(coordinator);

    newManager.setOnComplete(record => coordinator.onAgentComplete(record));
  }

  if (!currentNavigator) {
    const newNavigator = new AgentNavigator(
      getManager()!,
      async (agentId, text) => currentSessionHost()?.interact(agentId, text)
        ?? { accepted: false, reason: "unavailable" },
      () => currentSessionHost()?.pendingResultCount(),
      getStore().agent.expandListByDefault,
    );
    setNavigator(newNavigator);
    // ConfigStore synchronizes list stats visibility through dependency injection.
    getStore().setDeps({ navigator: newNavigator });
  }
  getManager()?.setOnRemove(() => getNavigator()?.update());
}

/**
 * Scan agent files from user and project directories, merge with defaults,
 * and register into the type registry.
 */
export async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const homeDir = process.env.HOME || "";
  const userAgentDir = path.join(homeDir, ".pi", "agent", "agents");
  const projectAgentDir = path.join(ctx.cwd, ".pi", "agents");

  const configurationResult = await configuration.execute({
    kind: "read-value",
    path: ["agent", "disableDefaultAgents"],
  });
  if (!configurationResult.ok) throw new Error(configurationResult.error.message);
  const catalogueConfiguration = configurationResult.found
    ? { disableDefaultAgents: configurationResult.value }
    : {};
  if (!Check(AgentCatalogueConfigurationSchema, catalogueConfiguration)) {
    throw new TypeError("Agent catalogue configuration is invalid.");
  }
  const disableDefaults = catalogueConfiguration.disableDefaultAgents === true;
  setAgentScanDirs(userAgentDir, projectAgentDir, disableDefaults);
  const result = await agentCatalogue.execute({
    kind: "discover",
    roots: { globalDirectory: userAgentDir, projectDirectory: projectAgentDir },
    configuration: catalogueConfiguration,
  });
  if (!result.ok) throw new Error(result.error.message);
  registerAgents(new Map(
    result.catalogue.definitions.map((definition) => [definition.name, toAgentConfig(definition)]),
  ), { disableDefaultAgents: true });
}

export async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // ConfigStore is authoritative for config, session overrides, and manager/UI side effects.
  getStore().reload();
  ensureManagerAndNavigator();
  await scanAndRegisterAgents(ctx);
}

// ============================================================================
// Event listener setup
// ============================================================================

/** Register all pi.on() event listeners. */
export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const resultMessage = currentSessionHost()?.prepareBeforeAgentStart();
    if (!event.systemPromptOptions.selectedTools?.includes("Agent")) {
      return resultMessage ? { message: resultMessage } : undefined;
    }
    const assembled = parentGuidance.assembleFromSession(ctx);
    if (!assembled.ok) throw new TypeError(assembled.error.message);
    return {
      message: resultMessage,
      systemPrompt: `${event.systemPrompt}\n\n${assembled.guidance}`,
    };
  });

  pi.on("input", async (event, _ctx) => {
    if (event.source !== "interactive") return;
    const selectedAgentId = getNavigator()?.selectedId();
    const text = event.text.trim();
    if (
      !selectedAgentId
      || text.startsWith("/")
      || text.startsWith("!")
    ) return;

    const navigator = getNavigator();
    const requestId = navigator?.beginInteraction(selectedAgentId) ?? -1;
    const result = await currentSessionHost()?.interact(
      selectedAgentId,
      event.text,
      event.images,
    ) ?? { accepted: false as const, reason: "unavailable" as const };
    navigator?.completeInteraction(requestId, selectedAgentId, event.text, result);
    return { action: "handled" as const };
  });

  pi.on("agent_start", () => {
    currentSessionHost()?.onParentAgentStart();
  });

  // Main session run ended — Working row is gone; force reflow so Pi's
  // differential render does not leave blank gaps above the agent list.
  // setTimeout(0) lets Pi remove the Working row before relayout on the next event-loop turn.
  pi.on("agent_end", (event, ctx) => {
    currentSessionHost()?.onParentAgentEnd(event.messages);
    if (!ctx.hasUI) return;
    setTimeout(() => getNavigator()?.forceLayoutReflow(), 0);
  });

  pi.on("agent_settled", () => {
    currentSessionHost()?.onParentSettled();
  });

  pi.on("session_tree", () => {
    currentSessionHost()?.onSessionTree();
  });

  // session_start — load config and refresh the Agent catalogue used by guidance.
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    if (ctx.mode === "tui") {
      getNavigator()?.setUICtx(ctx.ui);
    }
    currentSessionHost()?.restorePending();
  });

  // session_shutdown — abort all, dispose manager
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };

    await cleanup(() => {
      const currentManager = getManager();
      if (!currentManager) return;
      const records = currentManager.listSnapshots();
      const active = records.filter(r => r.status === "running" || r.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    });

    // Cleanup must reach the child sessions even when a stale host UI component throws.
    // Rethrow the first failure afterwards so Pi still records the shutdown fault.
    await cleanup(() => {
      try { getNavigator()?.dispose(); } finally { setNavigator(null); }
    });
    // Let the manager abort and settle its runs while the coordinator can still
    // receive legitimate completion callbacks. The coordinator is disposed
    // afterwards so its durable fallback handoff is not cut off first.
    await cleanup(async () => {
      try { await getManager()?.dispose(); } finally { setManager(null); }
    });
    await cleanup(() => {
      try { currentSessionHost()?.dispose(); } finally { bindSessionHost(null); }
    });
    await cleanup(() => getStore().dispose());

    if (failures.length > 0) throw failures[0];
  });
}
