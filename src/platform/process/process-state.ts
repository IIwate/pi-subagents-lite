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

const PROCESS_STATE_V2 = Symbol.for("@iiwate/pi-subagents-lite/process-state-v2");
const PROCESS_STATE_V3 = Symbol.for("@iiwate/pi-subagents-lite/process-state-v3");

function isMapInbox(value: unknown): value is ProcessState {
  return !!value
    && typeof value === "object"
    && (value as ProcessState).fallbackResults instanceof Map;
}

/**
 * v3 is the name this build writes. A same-process `/reload` used to park
 * results under v2; a fresh Map here would leave that live bucket where the
 * returning parent can no longer reach it.
 *
 * When v3 is absent and v2 still holds a Map, both keys name that same
 * object until the inbox is empty. A non-Map leftover is ignored: that
 * shape cannot appear after the Map-keyed v2 release, and inventing a
 * conversion would keep a type this module no longer owns. Revisit if a
 * documented older key or shape must be read again.
 */
function resolveProcessState(): ProcessState {
  const globalState = globalThis as Record<symbol, unknown>;
  const current = globalState[PROCESS_STATE_V3];
  if (isMapInbox(current)) return current;

  const previous = globalState[PROCESS_STATE_V2];
  if (isMapInbox(previous)) {
    globalState[PROCESS_STATE_V3] = previous;
    return previous;
  }

  const created: ProcessState = {
    fallbackResults: new Map<string, BackgroundResultRecord[]>(),
    subagentSpawn: new AsyncLocalStorage<boolean>(),
  };
  globalState[PROCESS_STATE_V3] = created;
  return created;
}

const processState = resolveProcessState();

function releaseRetiredInboxAlias(): void {
  if (processState.fallbackResults.size > 0) return;
  const globalState = globalThis as Record<symbol, unknown>;
  if (globalState[PROCESS_STATE_V2] === processState) {
    delete globalState[PROCESS_STATE_V2];
  }
}

/** Transfer unpersisted final results only within the same parent session. */
export function takeFallbackResults(sessionId: string): BackgroundResultRecord[] {
  const results = processState.fallbackResults.get(sessionId) ?? [];
  processState.fallbackResults.delete(sessionId);
  releaseRetiredInboxAlias();
  return results;
}

export function setFallbackResults(sessionId: string, results: readonly BackgroundResultRecord[]): void {
  if (results.length > 0) processState.fallbackResults.set(sessionId, [...results]);
  else processState.fallbackResults.delete(sessionId);
  releaseRetiredInboxAlias();
}

/** Run child setup/execution in a context visible to freshly imported extension modules. */
export function withSubagentSpawn<T>(operation: () => Promise<T>): Promise<T> {
  return processState.subagentSpawn.run(true, operation);
}

/** True only in the async chain that is loading or running a subagent. */
export function isInsideSubagentSpawn(): boolean {
  return processState.subagentSpawn.getStore() === true;
}
