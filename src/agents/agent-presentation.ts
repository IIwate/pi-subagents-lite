import type { AgentRecord } from "../types.js";
import type { ExecutionMessage } from "../engine/contracts.js";
import type { NavigationAction, NavigationAgent, NavigationReply, NavigationSource, TranscriptSnapshot } from "../ui/navigation.js";
import { projectMessage } from "../drivers/message-projection.js";
import { getConfig } from "./agent-types.js";
import type { AgentManager } from "./agent-manager.js";
import type { SpawnCoordinator } from "../spawn/spawn-coordinator.js";

type Session = NonNullable<AgentRecord["execution"]["session"]>;
interface TranscriptCache {
  session: Session;
  messages: WeakMap<object, ExecutionMessage>;
  nextId: number;
  unsubscribe?: () => void;
  listener?: () => void;
}

/** Presents manager-owned sessions through values; only the execution owner retains live handles. */
export class AgentPresentation implements NavigationSource {
  private readonly caches = new Map<string, TranscriptCache>();
  private readonly watchers = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly manager: AgentManager, private readonly delivery?: Pick<SpawnCoordinator, "deliverSelectedMessages" | "retrySelectedDelivery">) {}

  listAgents(): readonly NavigationAgent[] { return this.manager.listAgents().map(record => this.project(record)); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getRecord(id: string): NavigationAgent | undefined { const record = this.manager.getRecord(id); return record && this.project(record); }

  private project(record: AgentRecord): NavigationAgent {
    const session = record.execution.session;
    const invocation = record.display.invocation;
    const queued = [
      ...(session?.getSteeringMessages?.() ?? []).map(text => ({ kind: "steer" as const, input: { text } })),
      ...(session?.getFollowUpMessages?.() ?? []).map(text => ({ kind: "followUp" as const, input: { text } })),
      ...(record.execution.pendingSteers ?? []).map(item => ({ kind: item.kind ?? "steer" as const, input: { text: item.message, images: item.images } })),
    ];
    return Object.freeze({
      id: record.id, operationId: record.execution.operationId ?? record.id,
      display: Object.freeze({ type: record.display.type, name: getConfig(record.display.type).displayName, description: record.display.description }),
      lifecycle: Object.freeze({ ...record.lifecycle }),
      execution: Object.freeze({ settled: record.execution.settled ?? !["queued", "running"].includes(record.lifecycle.status),
        providerName: session?.model?.provider ?? invocation?.providerName, modelName: session?.model?.id ?? invocation?.modelName,
        thinkingLevel: session?.thinkingLevel ?? invocation?.thinkingLevel, debugFaultKind: record.execution.debugFaultKind,
        retryState: record.execution.retryState ? Object.freeze({ ...record.execution.retryState }) : undefined }),
      stats: Object.freeze({ ...record.stats, lifetimeUsage: Object.freeze({ ...record.stats.lifetimeUsage }) }),
      queued: Object.freeze(queued.map((item, index) => Object.freeze({ ...item, entryId: `${item.kind}:${index}:${item.input.text}` }))),
      error: record.error, result: record.result,
      canDeliver: Boolean(record.lifecycle.takenOver && (record.result?.trim()
        || session?.messages.some(message => (message.role === "user" || message.role === "assistant")
          && projectMessage("selection", message).text.trim()))),
    });
  }

  transcript(id: string): TranscriptSnapshot {
    const record = this.manager.getRecord(id);
    const session = record?.execution.session;
    if (!session) return { ready: Boolean(record?.result), messages: record?.result ? [{ entryId: `${id}:result`, role: "assistant", text: record.result }] : [] };
    const cache = this.cache(id, session);
    const project = (message: Session["messages"][number]) => {
      let projected = cache.messages.get(message);
      if (!projected) { projected = projectMessage(`${id}:${++cache.nextId}`, message); cache.messages.set(message, projected); }
      return projected;
    };
    const streaming = session.agent.state.streamingMessage;
    const messages = session.messages.map(project);
    if (record?.result && !messages.some(message => (message.role === "user" || message.role === "assistant") && message.text.trim())) {
      messages.push({ entryId: `${id}:result`, role: "assistant", text: record.result });
    }
    return { ready: true, messages, streaming: streaming ? project(streaming) : undefined };
  }

  private cache(id: string, session: Session): TranscriptCache {
    let cache = this.caches.get(id);
    if (cache?.session === session) return cache;
    const listener = this.watchers.get(id);
    cache?.unsubscribe?.();
    cache = { session, messages: new WeakMap(), nextId: 0, listener };
    this.caches.set(id, cache);
    if (listener) this.subscribeCache(cache);
    return cache;
  }

  private subscribeCache(cache: TranscriptCache): void {
    cache.unsubscribe = cache.session.subscribe(event => {
      if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") cache.messages.delete(event.message);
      cache.listener?.();
      for (const listener of this.listeners) listener();
    });
  }

  watchTranscript(id: string, listener: () => void): () => void {
    this.watchers.set(id, listener);
    const session = this.manager.getRecord(id)?.execution.session;
    if (session) {
      const cache = this.cache(id, session);
      if (!cache.unsubscribe) { cache.listener = listener; this.subscribeCache(cache); }
    }
    return () => { const cache = this.caches.get(id); cache?.unsubscribe?.(); this.caches.delete(id); this.watchers.delete(id); };
  }

  dispatch(action: NavigationAction): NavigationReply | Promise<NavigationReply> {
    if (action.type === "deliver") {
      const result = action.deliveryId ? this.delivery?.retrySelectedDelivery(action.deliveryId)
        : this.delivery?.deliverSelectedMessages(action.selection.taskId, action.selection.messages.map(message => ({ role: message.role as "user" | "assistant", content: message.text })));
      if (result?.status === "saved") return { accepted: true, deliveryId: result.delivery.deliveryId };
      if (result?.status === "pending") return { accepted: false, reason: "save_failed", deliveryId: result.delivery.deliveryId };
      return { accepted: false, reason: "unavailable" };
    }
    const record = this.getRecord(action.taskId);
    if (!record || record.operationId !== action.operationId) return { accepted: false, reason: "unavailable" };
    switch (action.type) {
      case "steer":
      case "followUp": return this.manager.sendInput(action.taskId, action.input.text, action.input.images?.map(image => ({ ...image })), action.type);
      case "continue": {
        if (!record.execution.settled) return { accepted: false, reason: "unavailable" };
        const continuation = this.manager.interact(action.taskId, action.input.text, action.input.images?.map(image => ({ ...image })));
        const operationId = this.getRecord(action.taskId)?.operationId;
        return continuation.then(reply => reply.accepted ? { ...reply, operationId } : reply);
      }
      case "takeover": return this.manager.takeOver(action.taskId) ? { accepted: true } : { accepted: false, reason: "unavailable" };
      case "abort": return this.manager.abort(action.taskId, "user") ? { accepted: true } : { accepted: false, reason: "unavailable" };
      case "abortRetry": return this.manager.abortRetry(action.taskId) ? { accepted: true } : { accepted: false, reason: "unavailable" };
      case "pin": {
        const pinned = this.manager.togglePinned(action.taskId);
        return pinned === undefined ? { accepted: false, reason: "unavailable" } : { accepted: true, pinned };
      }
      case "remove": return this.manager.clear(action.taskId, "user") ? { accepted: true } : { accepted: false, reason: "unavailable" };
      case "dequeue": {
        if (record.queued.length !== action.entryIds.length || record.queued.some((item, index) => item.entryId !== action.entryIds[index])) {
          return { accepted: false, reason: "already_consumed" };
        }
        return { accepted: true, restored: this.manager.dequeueMessages(action.taskId).map(text => ({ text })) };
      }
    }
  }

  dispose(): void { for (const cache of this.caches.values()) cache.unsubscribe?.(); this.caches.clear(); this.watchers.clear(); this.listeners.clear(); }
}
