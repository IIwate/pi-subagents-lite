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
import {
  getNavigator,
  getPiInstance,
  getSessionCtx,
  setDelivery,
} from "../shell.js";

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

export function createHostDelivery(): BackgroundDelivery {
  return createBackgroundDelivery({
    repository: createPiResultRepository(getPiInstance(), getSessionCtx()),
    messenger: createPiParentMessenger(getPiInstance()),
    context: createPiDeliveryContext(getSessionCtx),
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
  runtime: SubagentRuntime,
  delivery: BackgroundDelivery,
  previousPending: Set<string>,
): void {
  const current = pendingIds(delivery);
  for (const snapshot of runtime.listSnapshots()) {
    const deliveryId = snapshot.resultDeliveryId;
    if (!deliveryId) continue;
    if (current.has(deliveryId)) runtime.markResult(snapshot.id, { persisted: true });
    if (previousPending.has(deliveryId) && !current.has(deliveryId)) {
      runtime.markResult(snapshot.id, { consumed: true });
    }
  }
}

export function applyDeliveryCommand(
  runtime: SubagentRuntime,
  delivery: BackgroundDelivery,
  command: DeliveryCommand,
): DeliveryCommandResult {
  const previous = pendingIds(delivery);
  const result = delivery.execute(command);
  syncRuntimeFlags(runtime, delivery, previous);
  return result;
}

export async function spawnAgent(
  runtime: SubagentRuntime,
  spawnCtx: ExtensionContext,
  intent: SpawnIntent,
): Promise<SpawnResult> {
  const { type, prompt, runInBackground, ...spawnOptions } = intent;
  const spawned = await runtime.execute({
    kind: "spawn",
    type,
    prompt,
    description: spawnOptions.description,
    acceptedPolicy: spawnOptions.acceptedPolicy,
    worktreePath: spawnOptions.worktreePath,
    parentCwd: spawnOptions.worktreePath ? spawnCtx.cwd : undefined,
    invocation: spawnOptions.invocation,
    resultSessionId: runInBackground ? spawnCtx.sessionManager.getSessionId() : undefined,
    resultOriginEntryId: runInBackground ? spawnCtx.sessionManager.getLeafId() : undefined,
    parentAborted: spawnOptions.signal?.aborted === true,
  });
  if (!spawned.ok || !spawned.snapshot) {
    throw new Error(spawned.ok ? "Spawn did not return a snapshot." : spawned.error.message);
  }
  const agentId = spawned.snapshot.id;
  if (spawnOptions.signal && !spawnOptions.signal.aborted) {
    spawnOptions.signal.addEventListener("abort", () => {
      runtime.stop(agentId, "user");
    }, { once: true });
  }
  getNavigator()?.ensureTimer();
  if (!runInBackground) {
    await runtime.waitUntilSettled(agentId);
    runtime.markResult(agentId, { consumed: true });
  }
  return { agentId, snapshot: runtime.getSnapshot(agentId) ?? spawned.snapshot };
}

export async function interactAgent(
  runtime: SubagentRuntime,
  agentId: string,
  message: string,
  images?: ImageContent[],
): Promise<InteractionResult> {
  if (!runtime.getSnapshot(agentId)) return { accepted: false, reason: "unavailable" };
  const interacted = await runtime.execute({
    kind: "interact",
    id: agentId,
    message,
    images: images as unknown[] | undefined,
  });
  const result = interacted.ok && interacted.interaction
    ? interacted.interaction
    : { accepted: false as const, reason: "unavailable" as const };
  if (result.accepted) getNavigator()?.ensureTimer();
  return result;
}

export function recordTerminalResult(
  runtime: SubagentRuntime,
  delivery: BackgroundDelivery,
  snapshot: AgentSnapshot,
): void {
  const result = toResult(snapshot);
  if (!result || !runtime.getSnapshot(snapshot.id)) return;
  runtime.markResult(snapshot.id, { deliveryId: result.deliveryId });
  applyDeliveryCommand(runtime, delivery, {
    kind: "record-terminal",
    record: result,
    stillPresent: runtime.getSnapshot(snapshot.id) != null,
  });
}

/**
 * Composition-root wiring only. Delivery lives on the shell the same way
 * the runtime does: one getter, retired when Phase 8 deletes the remaining
 * locators. A combined coordinator facade was the rejected alternative —
 * callers already know whether they want spawn or delivery.
 */
export function wireHostDelivery(runtime: SubagentRuntime): BackgroundDelivery {
  const delivery = createHostDelivery();
  setDelivery(delivery);
  runtime.setOnComplete((snapshot) => {
    recordTerminalResult(runtime, delivery, snapshot);
    getNavigator()?.update();
  });
  return delivery;
}
