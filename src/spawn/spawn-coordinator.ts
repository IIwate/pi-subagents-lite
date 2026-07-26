import { getNavigator, getPiInstance, getSessionCtx, getWidget } from "../shell.js";
import { SHORT_ID_LENGTH } from "../types.js";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, SpawnConfig } from "../types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.js";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: Nudge system (schedule/batch/emit), background agent tracking.
 * Delegates concurrency and record lifecycle to AgentManager (peers, not ownership).
 *
 * Decision refs: D4 (stats on record only), D6 (Nudge owned here),
 * D2 (peers with AgentManager).
 */

// ============================================================================
// Types
// ============================================================================

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

// ============================================================================
// Constants
// ============================================================================

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

// ============================================================================
// SpawnCoordinator
// ============================================================================

export class SpawnCoordinator {
  /** Agent IDs spawned as background — only these trigger a nudge on completion. */
  private backgroundAgentIds = new Set<string>();

  /** Captured ExtensionContext per background agent, bound to the spawning session. */
  private backgroundContexts = new Map<string, ExtensionContext>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  /** Active nudge timer. */
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for LLM tool executor and menu wizard.
   */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    // Shared config fields (SpawnConfig) pass through unchanged; only the
    // intent-only fields (type/prompt/runInBackground) need translation.
    const { type, prompt, runInBackground, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
    };

    const agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget();
    if (widget) {
      widget.ensureTimer();
    }
    getNavigator()?.ensureTimer();

    // Track background agents + capture ctx for fallback notification
    if (intent.runInBackground) {
      this.backgroundAgentIds.add(agentId);
      this.backgroundContexts.set(agentId, ctx);
    }

    const record = this.manager.getRecord(agentId)!;

    if (!intent.runInBackground) {
      // Foreground: await completion
      await record.execution.promise;

      // Foreground tool handler reads the result inline on return — mark it
      // consumed so the cleanup timer may evict the record once it ages out.
      record.lifecycle.resultConsumed = true;
    }

    return { agentId, record };
  }

  /** Route user input to a running or settled subagent session. */
  async interact(agentId: string, message: string, images?: ImageContent[]): Promise<boolean> {
    const record = this.manager.getRecord(agentId);
    if (!record) return false;

    // Deliver the completed background result before mutating the same record
    // for an interactive continuation.
    if (this.pendingNudges.delete(agentId)) {
      this.emitIndividualNudge(agentId);
    }

    const accepted = await this.manager.interact(agentId, message, {}, images);
    if (accepted) {
      getWidget()?.ensureTimer();
      getNavigator()?.ensureTimer();
    }
    return accepted;
  }

  /** Check if an agent was spawned as background. */
  isBackground(agentId: string): boolean {
    return this.backgroundAgentIds.has(agentId);
  }

  /**
   * Schedule a nudge for a background agent.
   * Batches with NUDGE_DELAY_MS window to coalesce rapid completions.
   */
  scheduleNudge(agentId: string): void {
    this.pendingNudges.add(agentId);

    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.pendingNudges];
      this.pendingNudges.clear();

      for (const id of batch) {
        this.emitIndividualNudge(id);
      }
    }, NUDGE_DELAY_MS);
  }

  /**
   * Called by AgentManager's onComplete callback (wired at session_start).
   * Owns the completion side-effects: nudge scheduling.
   */
  onAgentComplete(record: AgentRecord): void {
    // Schedule nudge for background agents
    if (this.backgroundAgentIds.has(record.id)) {
      this.scheduleNudge(record.id);
      this.backgroundAgentIds.delete(record.id);
    }
  }

  /** Dispose: clear timer and background tracking. */
  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();
    this.backgroundAgentIds.clear();
    this.backgroundContexts.clear();
    this.disposed = true;
  }

  // ── Private ──

  /** Emit an individual nudge for a completed background agent. */
  private emitIndividualNudge(agentId: string): void {
    // Skip if disposed — prevents stale pi usage after session replacement
    if (this.disposed) return;

    // Read pi from shell at call time so we get a fresh reference after reload.
    const pi = getPiInstance();
    if (!pi) return;

    const record = this.manager.getRecord(agentId);
    if (!record) return;

    const details = buildAgentDetails(record, {
      includeStats: true,
      includeStatus: true,
    });

    try {
      // Pick delivery mode based on parent session state:
      // - steer: queues while running, delivers before next LLM call
      // - followUp: waits for agent to finish, then delivers
      const ctx = getSessionCtx();
      const parentIdle = ctx?.isIdle?.() ?? true;
      const deliverAs = parentIdle ? "followUp" : "steer";

      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]\n\n${formatResultContent(record)}`,
          details,
          // Keep the TUI silent: users see completion in the list below the editor,
          // while the LLM still receives the full result text.
          display: false,
        },
        {
          deliverAs,
          triggerTurn: true,
        },
      );

      // Full result delivered to the LLM — record is now safe for the cleanup
      // timer to evict once it ages out.
      record.lifecycle.resultConsumed = true;
    } catch (error) {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      const spawnCtx = this.backgroundContexts.get(agentId);
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(
            `[Subagent "${record.display.type}" ${record.lifecycle.status}] Result available`,
            "info",
          );
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    } finally {
      this.backgroundContexts.delete(agentId);
    }
  }
}
