/**
 * process-state.ts — The only approved process-global storage.
 *
 * Two responsibilities must survive Pi's Jiti module reloads, which reset
 * every module-scope binding:
 *
 * - The session-keyed fallback result inbox: final results that a stale
 *   runtime could not append to its parent session are parked here until the
 *   same parent session reloads and drains them.
 * - The child-spawn async marker: a freshly reloaded copy of this extension
 *   must stay inert when the reload happens inside a subagent's async chain,
 *   without making unrelated parent work inert.
 *
 * Both live under one `globalThis` symbol. Everything else is ordinary
 * session state owned by the extension runtime record; adding a third
 * process-global responsibility requires an explicit plan approval.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { BackgroundResultRecord } from "../../modules/background-result-delivery/public.js";

interface ProcessState {
  /** Process-local handoff buckets when a stale runtime rejects parent-session append. */
  fallbackResults: Map<string, BackgroundResultRecord[]>;
  /** Async context survives Jiti module reloads without blocking unrelated parent work. */
  subagentSpawn: AsyncLocalStorage<boolean>;
}

// v3 is the Map-shaped inbox. An older build parked under a previous
// symbol is left behind: converting that leftover would keep a shape this
// module no longer names, and a live process cannot present the old
// single-slot once the key has moved. Revisit only if a documented reload
// contract must read that older key again.
const processState = ((globalThis as any)[Symbol.for("@iiwate/pi-subagents-lite/process-state-v3")] ??= {
  fallbackResults: new Map<string, BackgroundResultRecord[]>(),
  subagentSpawn: new AsyncLocalStorage<boolean>(),
}) as ProcessState;

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

/** Run child setup/execution in a context visible to freshly imported extension modules. */
export function withSubagentSpawn<T>(operation: () => Promise<T>): Promise<T> {
  return processState.subagentSpawn.run(true, operation);
}

/** True only in the async chain that is loading or running a subagent. */
export function isInsideSubagentSpawn(): boolean {
  return processState.subagentSpawn.getStore() === true;
}
