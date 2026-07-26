import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./agents/default-agents.js";
import { registerAgents, getAvailableTypes, setAgentScanDirs } from "./agents/agent-types.js";
import { scanAgentFilesInDir, mergeAgents } from "./agents/agent-discovery.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { AgentNavigator } from "./ui/agent-navigator.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { registerAgentTool } from "./registration.js";
import {
  getPiInstance,
  getManager,
  getWidget,
  getNavigator,
  getCoordinator,
  getStore,
  setSessionCtx,
  setManager,
  setWidget,
  setNavigator,
  setCoordinator,
} from "./shell.js";

// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the manager and widget singletons exist.
 * Idempotent — safe to call on every session_start.
 */
export function ensureManagerAndWidget(): void {
  const currentManager = getManager();
  const currentWidget = getWidget();
  const currentNavigator = getNavigator();

  // Create manager if missing
  if (!currentManager) {
    // Coordinator will be created after manager, so use a placeholder onComplete
    // that we'll replace once coordinator is created.
    const newManager = new AgentManager(
      undefined, // onComplete wired below
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
      undefined,
      getStore().agent.outputThinkingBufferSize,
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    // Now create coordinator with the real manager
    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    // Wire the manager's onComplete to the coordinator
    newManager.setOnComplete((record) => {
      // Delegate completion side-effects to coordinator
      coordinator.onAgentComplete(record);

      // 刷新状态栏计数与下方代理列表
      getWidget()?.update();
      getNavigator()?.update();
    });
  }

  // Create widget (status-bar badge) if missing
  if (!currentWidget) {
    setWidget(new AgentWidget(getManager()!));
  }

  if (!currentNavigator) {
    const newNavigator = new AgentNavigator(
      getManager()!,
      async (agentId, text) => getCoordinator()?.interact(agentId, text) ?? false,
    );
    setNavigator(newNavigator);
    // 列表统计可见性由 ConfigStore 同步（与 widget 同一注入模式）
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

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;

  const [userAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);

  // Merge with defaults (skip defaults when disableDefaultAgents is on)
  const defaults = disableDefaults ? new Map() : DEFAULT_AGENTS;
  const merged = mergeAgents(defaults, userAgents, projectAgents);

  // Register into the type registry (skip re-adding defaults)
  registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

export async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // ConfigStore is authoritative for config + session overrides + widget/manager
  // side effects.
  getStore().reload();
  ensureManagerAndWidget();
  await scanAndRegisterAgents(ctx);
}

// ============================================================================
// Event listener setup
// ============================================================================

/** Register all pi.on() event listeners. */
export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    const selectedAgentId = getNavigator()?.selectedId();
    const text = event.text.trim();
    if (
      !selectedAgentId
      || text.startsWith("/")
      || text.startsWith("!")
    ) return;

    const accepted = await getCoordinator()?.interact(
      selectedAgentId,
      event.text,
      event.images,
    ) ?? false;
    if (!accepted) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify("Selected subagent is not available for interaction", "warning");
    }
    return { action: "handled" as const };
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    // Set UI context on first tool execution
    if (!getWidget()) {
      ensureManagerAndWidget();
    }
    getWidget()?.setUICtx(ctx.ui as unknown as UICtx);
    getWidget()?.update();
  });

  // Main session run ended — Working row is gone; force reflow so Pi's
  // differential render does not leave blank gaps above the agent list.
  // nextTick: let Pi remove Working before we repaint.
  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    setTimeout(() => getNavigator()?.forceLayoutReflow(), 0);
  });


  // session_start — load config, scan agents, register into registry,
  // then re-register Agent tool with dynamic agent type enum
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    // Re-register with updated agent type list (now includes user/project agents)
    registerAgentTool(pi);
    if (ctx.mode === "tui") {
      getNavigator()?.setUICtx(ctx.ui);
    }
  });

  // session_shutdown — abort all, dispose manager
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    // Warn if agents were killed
    const currentManager = getManager();
    if (currentManager) {
      const records = currentManager.listAgents();
      const active = records.filter(r => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    }
    // Dispose navigator, coordinator, store, widget, then manager
    getNavigator()?.dispose();
    setNavigator(null);
    getCoordinator()?.dispose();
    setCoordinator(null);
    getStore().dispose();
    getWidget()?.dispose();
    setWidget(null);
    const mgr = getManager();
    if (mgr) {
      await mgr.dispose();
      setManager(null);
    }
  });
}
