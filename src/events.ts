import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, registerAgents, setAgentScanDirs, scanAndMerge } from "./agents/agent-types.js";
import { getDeliveryReceipt } from "./spawn/result-inbox.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentNavigator } from "./ui/agent-navigator.js";
import { AgentPresentation } from "./agents/agent-presentation.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { modelKey, scopedModelKeys } from "./models/model-scope.js";
import { buildCurrentAgentGuidance } from "./prompt/agent-guidance.js";
import {
  getManager,
  getNavigator,
  getCoordinator,
  getSessionCtx,
  getStore,
  setSessionCtx,
  setManager,
  setNavigator,
  setCoordinator,
} from "./shell.js";

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
    const newManager = new AgentManager(
      undefined, // onComplete wired below
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    // Now create coordinator with the real manager
    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    newManager.setOnComplete(record => coordinator.onAgentComplete(record));
  }

  if (!currentNavigator) {
    const newNavigator = new AgentNavigator(
      new AgentPresentation(getManager()!, getCoordinator()!),
      undefined,
      () => getCoordinator()?.pendingResultCount(),
      () => {
        const session = getSessionCtx();
        if (!session) return undefined;
        return {
          providerName: session.model?.provider,
          modelName: session.model?.id,
          thinkingLevel: session.thinkingLevel,
        };
      },
      getStore().agent.expandListByDefault,
    );
    setNavigator(newNavigator);
    // ConfigStore synchronizes list stats visibility through dependency injection.
    getStore().setDeps({ navigator: newNavigator });
  }
  getManager()?.setOnRemove(() => getNavigator()?.update());
  getManager()?.setOnStatsUpdate(() => {
    getNavigator()?.ensureTimer();
    getNavigator()?.update();
  });
}

/**
 * Scan agent files from user and project directories, merge with defaults,
 * and register into the type registry.
 */
export async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const userAgentDir = path.join(getAgentDir(), "agents");
  const trusted = ctx.isProjectTrusted?.() !== false;
  const projectAgentDir = trusted ? path.join(ctx.cwd, CONFIG_DIR_NAME, "agents") : "";

  const disableDefaults = getStore().agent.disableDefaultAgents;
  setAgentScanDirs(userAgentDir, projectAgentDir, disableDefaults);
  const merged = await scanAndMerge({ disableDefaultAgents: disableDefaults });

  // Register into the type registry (skip re-adding defaults)
  registerAgents(merged, { disableDefaultAgents: disableDefaults });
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
// Note: see .agents/notes/implemented/architecture/2026-09-09-dynamic-guidance-injection.md
export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const resultMessage = await getCoordinator()?.prepareBeforeAgentStart();
    if (!event.systemPromptOptions.selectedTools?.includes("Agent")) {
      return resultMessage ? { message: resultMessage } : undefined;
    }
    const guidance = buildCurrentAgentGuidance({
      agents: getAvailableTypes().flatMap((name) => {
        const config = getAgentConfig(name);
        return config ? [{
          name,
          description: config.description,
          registeredTools: config.registeredTools,
          maxTurns: config.maxTurns,
        }] : [];
      }),
      parentModelKey: ctx.model ? modelKey(ctx.model) : "",
      routing: getStore().routing,
      availableKeys: new Set(ctx.modelRegistry.getAvailable().map(modelKey)),
      scopedKeys: scopedModelKeys(ctx.scopedModels),
    });
    return {
      message: resultMessage,
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
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

    if (getNavigator()?.handleEditorSubmit(event.text, "steer", event.images)) return { action: "handled" as const };
  });

  pi.on("agent_start", () => {
    getCoordinator()?.onParentAgentStart();
  });

  pi.on("message_end", (event, ctx) => {
    const receipt = getDeliveryReceipt(event.message);
    const coordinator = getCoordinator();
    if (receipt?.parentSessionId === ctx.sessionManager.getSessionId() && coordinator) {
      // Pi persists the message after extension handlers return.
      setImmediate(() => {
        void coordinator.reconcileDeliveryState();
      });
    }
  });

  // Main session run ended — Working row is gone; force reflow so Pi's
  // differential render does not leave blank gaps above the agent list.
  // setTimeout(0) lets Pi remove the Working row before relayout on the next event-loop turn.
  pi.on("agent_end", (_event, ctx) => {
    getCoordinator()?.onParentAgentEnd();
    if (!ctx.hasUI) return;
    setTimeout(() => getNavigator()?.forceLayoutReflow(), 0);
  });

  pi.on("agent_settled", async () => {
    await getCoordinator()?.onParentSettled();
  });

  pi.on("session_tree", async () => {
    await getCoordinator()?.onSessionTree();
  });

  pi.on("model_select", (_event, ctx) => {
    setSessionCtx(ctx);
    getNavigator()?.update();
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    setSessionCtx(ctx);
    getNavigator()?.update();
  });

  // session_start — load config and refresh the Agent catalogue used by guidance.
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    if (ctx.mode === "tui") {
      getNavigator()?.setUICtx(ctx.ui);
    }
    await getCoordinator()?.restorePending();
  });

  // session_shutdown — abort all, dispose manager
  pi.on("session_shutdown", async (event: unknown, ctx: ExtensionContext) => {
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
      const records = currentManager.listAgents();
      const active = records.filter(r => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        const reason = (event as { reason?: string } | undefined)?.reason;
        const message = reason === "reload"
          ? `${active.length} agent(s) killed by reload`
          : `${active.length} agent(s) stopped on session close`;
        ctx.ui.notify(message, "warning");
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
      try { getCoordinator()?.dispose(); } finally { setCoordinator(null); }
    });
    await cleanup(() => getStore().dispose());

    if (failures.length > 0) throw failures[0];
  });
}
