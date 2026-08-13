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
import type { SubagentRuntime } from "./modules/subagent-runtime/public.js";
import type { AgentNavigator } from "./ui/agent-navigator.js";
import type {
  BackgroundDelivery,
  BackgroundResultRecord,
} from "./modules/background-result-delivery/public.js";
import { ConfigStore } from "./config/config-store.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: SubagentRuntime | null;
  delivery: BackgroundDelivery | null;
  navigator: AgentNavigator | null;
  store: ConfigStore;
}

interface ProcessState {
  /** Process-local handoff buckets when a stale runtime rejects parent-session append. */
  fallbackResults: Map<string, BackgroundResultRecord[]>;
  /** Async context survives Jiti module reloads without blocking unrelated parent work. */
  subagentSpawn: AsyncLocalStorage<boolean>;
}

const processState = ((globalThis as any)[Symbol.for("@iiwate/pi-subagents-lite/process-state-v2")] ??= {
  fallbackResults: new Map<string, BackgroundResultRecord[]>(),
  subagentSpawn: new AsyncLocalStorage<boolean>(),
}) as ProcessState;

// Preserve a pending single-slot handoff when this version first loads into an
// already-running Pi process; subsequent reloads use the session-keyed Map.
if (!(processState.fallbackResults instanceof Map)) {
  const legacy = processState.fallbackResults as unknown as { sessionId?: string; results?: BackgroundResultRecord[] } | undefined;
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
  delivery: null,
  navigator: null,
  store: new ConfigStore(),
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

/** The current Subagent runtime, or null if not yet created. */
export function getManager(): SubagentRuntime | null {
  return shell.manager;
}

/** The current background delivery facade, or null if not yet created. */
export function getDelivery(): BackgroundDelivery | null {
  return shell.delivery;
}

/** The current keyboard-driven agent navigator, or null if not yet created. */
export function getNavigator(): AgentNavigator | null {
  return shell.navigator;
}

/** The ConfigStore (lives for the lifetime of the extension). */
export function getStore(): ConfigStore {
  return shell.store;
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

export function setManager(m: SubagentRuntime | null): void {
  shell.manager = m;
}

export function setDelivery(delivery: BackgroundDelivery | null): void {
  shell.delivery = delivery;
}

export function setNavigator(navigator: AgentNavigator | null): void {
  shell.navigator = navigator;
}

/** Transfer unpersisted final results only within the same parent session. */
export function takeFallbackResults(sessionId: string): BackgroundResultRecord[] {
  const results = processState.fallbackResults.get(sessionId) ?? [];
  processState.fallbackResults.delete(sessionId);
  return results;
}

export function setFallbackResults(sessionId: string, results: readonly BackgroundResultRecord[]): void {
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
