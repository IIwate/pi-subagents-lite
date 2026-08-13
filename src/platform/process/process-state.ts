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

// The symbol key is shared with previously released versions; renaming it
// would strand a live process's pending handoffs across an upgrade reload.
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
