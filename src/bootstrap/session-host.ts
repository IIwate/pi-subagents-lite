import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentSnapshot,
  InteractionResult,
  SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import {
  createBackgroundDelivery,
  type BackgroundDelivery,
  type BackgroundResultRecord,
  type DeliveryCommand,
  type DeliveryCommandResult,
} from "../modules/background-result-delivery/public.js";
import { getStatusNote } from "../status-note.js";
import { createPiDeliveryContext } from "../platform/pi/delivery-context.js";
import { createPiParentMessenger } from "../platform/pi/parent-messenger.js";
import { createPiResultRepository } from "../platform/pi/result-repository.js";
import type { SpawnConfig } from "../types.js";
import {
  setFallbackResults,
  takeFallbackResults,
} from "../platform/process/process-state.js";
import type { ExtensionRuntime } from "./extension-runtime.js";

export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  signal?: AbortSignal;
  runInBackground: boolean;
}

export interface SpawnResult {
  agentId: string;
  snapshot: AgentSnapshot;
}

function toResult(snapshot: AgentSnapshot): BackgroundResultRecord | undefined {
  const parentSessionId = snapshot.resultSessionId;
  if (!parentSessionId) return undefined;
  return {
    deliveryId: randomUUID(),
    parentSessionId,
    originEntryId: snapshot.resultOriginEntryId ?? null,
    agentId: snapshot.id,
    type: snapshot.type,
    status: snapshot.status,
    result: (
      snapshot.status === "error"
        ? `Agent failed: ${snapshot.error || "unknown error"}`
        : (snapshot.result ?? "") + getStatusNote(snapshot)
    ).trim() || "(no output)",
    error: snapshot.error?.trim() || null,
    provider: snapshot.invocation?.providerName,
    model: snapshot.invocation?.modelName,
    createdAt: snapshot.completedAt ?? Date.now(),
  };
}

export function isParentRunSuccessful(
  messages: readonly { role: string; stopReason?: string; errorMessage?: string }[],
): boolean {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  return !!last
    && last.stopReason !== "error"
    && last.stopReason !== "aborted"
    && last.errorMessage === undefined;
}

/** Delivery is wired at session_start; a missing session context is a wiring bug. */
function requireSessionCtx(runtime: ExtensionRuntime): ExtensionContext {
  if (!runtime.sessionCtx) throw new Error("Session context is not initialised.");
  return runtime.sessionCtx;
}

export function createHostDelivery(runtime: ExtensionRuntime): BackgroundDelivery {
  return createBackgroundDelivery({
    repository: createPiResultRepository(runtime.pi, requireSessionCtx(runtime)),
    messenger: createPiParentMessenger(runtime.pi),
    context: createPiDeliveryContext(() => requireSessionCtx(runtime)),
    fallback: {
      take: takeFallbackResults,
      save: setFallbackResults,
    },
  });
}

function pendingIds(delivery: BackgroundDelivery): Set<string> {
  const inspected = delivery.execute({ kind: "inspect" });
  return new Set(inspected.ok ? inspected.snapshot.pending.map((item) => item.deliveryId) : []);
}

function syncRuntimeFlags(
  manager: SubagentRuntime,
  delivery: BackgroundDelivery,
  previousPending: Set<string>,
): void {
  const current = pendingIds(delivery);
  for (const snapshot of manager.listSnapshots()) {
    const deliveryId = snapshot.resultDeliveryId;
    if (!deliveryId) continue;
    if (current.has(deliveryId)) manager.markResult(snapshot.id, { persisted: true });
    if (previousPending.has(deliveryId) && !current.has(deliveryId)) {
      manager.markResult(snapshot.id, { consumed: true });
    }
  }
}

export function applyDeliveryCommand(
  manager: SubagentRuntime,
  delivery: BackgroundDelivery,
  command: DeliveryCommand,
): DeliveryCommandResult {
  const previous = pendingIds(delivery);
  const result = delivery.execute(command);
  syncRuntimeFlags(manager, delivery, previous);
  return result;
}

export async function spawnAgent(
  runtime: ExtensionRuntime,
  spawnCtx: ExtensionContext,
  intent: SpawnIntent,
): Promise<SpawnResult> {
  const manager = runtime.manager;
  if (!manager) throw new Error("Subagent runtime is not initialised.");
  const { type, prompt, runInBackground, ...spawnOptions } = intent;
  const resultSessionId = runInBackground ? spawnCtx.sessionManager.getSessionId() : undefined;
  const resultOriginEntryId = runInBackground ? spawnCtx.sessionManager.getLeafId() : undefined;
  if (resultOriginEntryId) {
    runtime.delivery?.execute({ kind: "track-origin", originEntryId: resultOriginEntryId });
  }
  const spawned = await manager.execute({
    kind: "spawn",
    type,
    prompt,
    description: spawnOptions.description,
    acceptedPolicy: spawnOptions.acceptedPolicy,
    worktreePath: spawnOptions.worktreePath,
    parentCwd: spawnOptions.worktreePath ? spawnCtx.cwd : undefined,
    invocation: spawnOptions.invocation,
    resultSessionId,
    resultOriginEntryId,
    parentAborted: spawnOptions.signal?.aborted === true,
  });
  if (!spawned.ok || !spawned.snapshot) {
    throw new Error(spawned.ok ? "Spawn did not return a snapshot." : spawned.error.message);
  }
  const agentId = spawned.snapshot.id;
  if (spawnOptions.signal && !spawnOptions.signal.aborted) {
    spawnOptions.signal.addEventListener("abort", () => {
      manager.stop(agentId, "user");
    }, { once: true });
  }
  runtime.navigator?.ensureTimer();
  if (!runInBackground) {
    await manager.waitUntilSettled(agentId);
    manager.markResult(agentId, { consumed: true });
  }
  return { agentId, snapshot: manager.getSnapshot(agentId) ?? spawned.snapshot };
}

export async function interactAgent(
  runtime: ExtensionRuntime,
  agentId: string,
  message: string,
  images?: ImageContent[],
): Promise<InteractionResult> {
  const manager = runtime.manager;
  if (!manager?.getSnapshot(agentId)) return { accepted: false, reason: "unavailable" };
  const interacted = await manager.execute({
    kind: "interact",
    id: agentId,
    message,
    images: images as unknown[] | undefined,
  });
  const result = interacted.ok && interacted.interaction
    ? interacted.interaction
    : { accepted: false as const, reason: "unavailable" as const };
  if (result.accepted) runtime.navigator?.ensureTimer();
  return result;
}

export function recordTerminalResult(
  manager: SubagentRuntime,
  delivery: BackgroundDelivery,
  snapshot: AgentSnapshot,
): void {
  const result = toResult(snapshot);
  if (!result || !manager.getSnapshot(snapshot.id)) return;
  manager.markResult(snapshot.id, { deliveryId: result.deliveryId });
  applyDeliveryCommand(manager, delivery, {
    kind: "record-terminal",
    record: result,
    stillPresent: manager.getSnapshot(snapshot.id) != null,
  });
}

/**
 * Composition-root wiring only. Delivery lives on the runtime record next to
 * the manager it serves. A combined coordinator facade was the rejected
 * alternative — callers already know whether they want spawn or delivery.
 */
export function wireHostDelivery(
  runtime: ExtensionRuntime,
  manager: SubagentRuntime,
): BackgroundDelivery {
  const delivery = createHostDelivery(runtime);
  runtime.delivery = delivery;
  manager.setOnComplete((snapshot) => {
    recordTerminalResult(manager, delivery, snapshot);
    runtime.navigator?.update();
  });
  return delivery;
}
