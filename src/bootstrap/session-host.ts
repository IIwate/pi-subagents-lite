import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSnapshot, SubagentRuntime } from "../modules/subagent-runtime/public.js";
import {
  createBackgroundDelivery,
  type BackgroundDelivery,
  type BackgroundResultRecord,
} from "../modules/background-result-delivery/public.js";
import { getStatusNote } from "../status-note.js";
import { createPiDeliveryContext } from "../platform/pi/delivery-context.js";
import { createPiParentMessenger } from "../platform/pi/parent-messenger.js";
import { createPiResultRepository } from "../platform/pi/result-repository.js";
import type { SpawnCoordinatorApi, SpawnIntent, SpawnResult } from "../spawn/coordinator-api.js";
import {
  getNavigator,
  getPiInstance,
  getSessionCtx,
  setFallbackResults,
  takeFallbackResults,
} from "../shell.js";

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

function isParentRunSuccessful(
  messages: readonly { role: string; stopReason?: string; errorMessage?: string }[],
): boolean {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  return !!last
    && last.stopReason !== "error"
    && last.stopReason !== "aborted"
    && last.errorMessage === undefined;
}

let boundHost: SpawnCoordinatorApi | null = null;

export function bindSessionHost(host: SpawnCoordinatorApi | null): void {
  boundHost = host;
}

export function currentSessionHost(): SpawnCoordinatorApi | null {
  return boundHost;
}

export function createSessionHost(runtime: SubagentRuntime): SpawnCoordinatorApi {
  const ctx = getSessionCtx();
  const pi = getPiInstance();
  const delivery: BackgroundDelivery = createBackgroundDelivery({
    repository: createPiResultRepository(pi, ctx),
    messenger: createPiParentMessenger(pi),
    context: createPiDeliveryContext(getSessionCtx),
    fallback: {
      take: takeFallbackResults,
      save: setFallbackResults,
    },
  });

  const pendingIds = () => {
    const inspected = delivery.execute({ kind: "inspect" });
    return new Set(inspected.ok ? inspected.snapshot.pending.map((item) => item.deliveryId) : []);
  };

  const syncRuntimeFlags = (previousPending: Set<string>): void => {
    const current = pendingIds();
    for (const snapshot of runtime.listSnapshots()) {
      const deliveryId = snapshot.resultDeliveryId;
      if (!deliveryId) continue;
      if (current.has(deliveryId)) runtime.markResult(snapshot.id, { persisted: true });
      if (previousPending.has(deliveryId) && !current.has(deliveryId)) {
        runtime.markResult(snapshot.id, { consumed: true });
      }
    }
  };

  const runDelivery = (command: Parameters<BackgroundDelivery["execute"]>[0]) => {
    const previous = pendingIds();
    const result = delivery.execute(command);
    syncRuntimeFlags(previous);
    return result;
  };

  return {
    async spawn(_pi: ExtensionAPI, spawnCtx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
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
    },
    async interact(agentId, message, images?: ImageContent[]) {
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
    },
    onAgentComplete(snapshot) {
      const result = toResult(snapshot);
      if (!result || !runtime.getSnapshot(snapshot.id)) return;
      runtime.markResult(snapshot.id, { deliveryId: result.deliveryId });
      runDelivery({
        kind: "record-terminal",
        record: result,
        stillPresent: runtime.getSnapshot(snapshot.id) != null,
      });
      getNavigator()?.update();
    },
    prepareBeforeAgentStart() {
      const result = runDelivery({ kind: "parent-preflight" });
      return result.ok ? result.injection : undefined;
    },
    onParentAgentStart() {
      runDelivery({ kind: "parent-start" });
    },
    onParentAgentEnd(messages) {
      runDelivery({ kind: "parent-end", succeeded: isParentRunSuccessful(messages) });
    },
    onParentSettled() {
      runDelivery({ kind: "parent-settled" });
      getNavigator()?.update();
    },
    restorePending() {
      runDelivery({ kind: "restore" });
      getNavigator()?.update();
    },
    onSessionTree() {
      runDelivery({ kind: "session-tree" });
      getNavigator()?.update();
    },
    pendingResultCount() {
      return delivery.pendingResultCount();
    },
    getStoredResult(agentId) {
      return delivery.getStoredResult(agentId, runtime.getSnapshot(agentId)?.resultDeliveryId);
    },
    markResultPresented(deliveryId) {
      runDelivery({ kind: "mark-presented", deliveryId });
    },
    dispose() {
      runDelivery({ kind: "dispose" });
    },
  };
}
