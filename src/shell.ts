/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the Shell is the single mutable container for all per-session
 * state. Created at session_start, disposed at session_shutdown. Handler
 * modules read from shell via the getter functions — no module-level mutable
 * globals.
 *
 * index.ts populates the shell at session_start; handler modules import
 * getManager() / getNavigator() / etc.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { AgentNavigator } from "./ui/agent-navigator.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import type { PendingResult } from "./spawn/result-inbox.js";
import { ConfigStore } from "./config/config-store.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  navigator: AgentNavigator | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

interface ProcessState {
  /** Process-local handoff buckets when a stale runtime rejects parent-session append. */
  fallbackResults: Map<string, PendingResult[]>;
  /** Async context survives Jiti module reloads without blocking unrelated parent work. */
  subagentSpawn: AsyncLocalStorage<boolean>;
}

const processState = ((globalThis as any)[Symbol.for("@iiwate/pi-subagents-lite/process-state-v2")] ??= {
  fallbackResults: new Map<string, PendingResult[]>(),
  subagentSpawn: new AsyncLocalStorage<boolean>(),
}) as ProcessState;

// Preserve a pending single-slot handoff when this version first loads into an
// already-running Pi process; subsequent reloads use the session-keyed Map.
if (!(processState.fallbackResults instanceof Map)) {
  const legacy = processState.fallbackResults as unknown as { sessionId?: string; results?: PendingResult[] } | undefined;
  processState.fallbackResults = new Map(
    legacy?.sessionId && legacy.results?.length ? [[legacy.sessionId, legacy.results]] : [],
  );
}

// ============================================================================
// Mutable module-level shell (populated by index.ts at session_start)
// ============================================================================

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  navigator: null,
  store: new ConfigStore(),
  coordinator: null,
};

// ============================================================================
// Getter functions (read current state at call time)
// ============================================================================

/** The PI extension API instance. Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** The current session context. Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** The current AgentManager, or null if not yet created. */
export function getManager(): AgentManager | null {
  return shell.manager;
}

/** The current keyboard-driven agent navigator, or null if not yet created. */
export function getNavigator(): AgentNavigator | null {
  return shell.navigator;
}

/** The ConfigStore (lives for the lifetime of the extension). */
export function getStore(): ConfigStore {
  return shell.store;
}

/** The current SpawnCoordinator, or null if not yet created. */
export function getCoordinator(): SpawnCoordinator | null {
  return shell.coordinator;
}

// ============================================================================
// Setter functions (called by index.ts to populate the shell)
// ============================================================================

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  shell.manager = m;
}

export function setNavigator(navigator: AgentNavigator | null): void {
  shell.navigator = navigator;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  shell.coordinator = c;
}

/** Transfer unpersisted final results only within the same parent session. */
export function takeFallbackResults(sessionId: string): PendingResult[] {
  const results = processState.fallbackResults.get(sessionId) ?? [];
  processState.fallbackResults.delete(sessionId);
  return results;
}

export function setFallbackResults(sessionId: string, results: readonly PendingResult[]): void {
  if (results.length > 0) processState.fallbackResults.set(sessionId, [...results]);
  else processState.fallbackResults.delete(sessionId);
}

// ============================================================================
// Subagent spawn context
// ============================================================================

/** Run child setup/execution in a context visible to freshly imported extension modules. */
export function withSubagentSpawn<T>(operation: () => Promise<T>): Promise<T> {
  return processState.subagentSpawn.run(true, operation);
}

/** True only in the async chain that is loading or running a subagent. */
export function isInsideSubagentSpawn(): boolean {
  return processState.subagentSpawn.getStore() === true;
}
