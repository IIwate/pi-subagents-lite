import { readFileSync } from "node:fs";
import { parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeliveryAttempt, DeliveryChannel, DeliveryReceipt, TaskDelivery } from "../engine/contracts.js";

export const RESULT_MESSAGE_TYPE = "subagents-lite:v3-result";
const WAKE_MESSAGE_TYPE = "subagents-lite:v3-wake";
type ParentContext = Pick<ExtensionContext, "sessionManager" | "isIdle" | "hasPendingMessages">;

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function resultContent(delivery: TaskDelivery): string {
  return `[Subagent ${delivery.taskId} ${delivery.status}]\n\n${delivery.text}`;
}

/** Public Pi API adapter. Result bodies stay in the native outbox until the parent is idle. */
export class PiDeliveryChannel implements DeliveryChannel {
  private readonly sessionId: string;
  private readonly sessionFile: string | undefined;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly getContext: () => ParentContext,
  ) {
    const session = getContext().sessionManager;
    this.sessionId = session.getSessionId();
    this.sessionFile = session.getSessionFile();
  }

  async deliver(delivery: TaskDelivery, eligible: () => boolean): Promise<DeliveryAttempt> {
    const ctx = this.getContext();
    if (!this.isCurrent(ctx) || delivery.parent.sessionId !== this.sessionId) return { status: "pending", reason: "ineligible" };
    const entries = this.readDurableEntries();
    if (!entries) return { status: "pending", reason: "not_durable" };
    const existing = this.receipt(entries, delivery);
    if (existing) {
      this.wake(delivery, entries, eligible);
      return { status: "received", receipt: existing };
    }
    if (!eligible() || !this.belongs(ctx, delivery)) return { status: "pending", reason: "ineligible" };
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return { status: "pending", reason: "busy" };
    if (this.receipt(ctx.sessionManager.getEntries(), delivery)) {
      // Pi publishes to memory before a filesystem append. Resending would duplicate live context.
      throw new Error("Parent result exists only in memory; reload the parent session before retrying delivery");
    }

    // No await separates the last eligibility check, the synchronous idle append, and receipt verification.
    // Current Pi's queued custom messages cannot be individually withdrawn after navigation or takeover.
    this.pi.sendMessage({
      customType: RESULT_MESSAGE_TYPE, content: resultContent(delivery), display: false,
      details: {
        deliveryId: delivery.deliveryId, parentSessionId: delivery.parent.sessionId,
        taskId: delivery.taskId, operationId: delivery.operationId, sourceEntryIds: [...delivery.sourceEntryIds],
      },
    }, { triggerTurn: false });
    const persisted = this.readDurableEntries();
    const receipt = persisted && this.receipt(persisted, delivery);
    if (!receipt) throw new Error("Parent result was not durably persisted");
    this.wake(delivery, persisted, eligible);
    return { status: "received", receipt };
  }

  private isCurrent(ctx: ParentContext): boolean {
    return ctx.sessionManager.getSessionId() === this.sessionId && ctx.sessionManager.getSessionFile() === this.sessionFile;
  }

  private belongs(ctx: ParentContext, delivery: TaskDelivery): boolean {
    return this.isCurrent(ctx) && (delivery.kind === "selection" || delivery.parent.entryId === null
      || ctx.sessionManager.getBranch().some(entry => entry.id === delivery.parent.entryId));
  }

  private readDurableEntries(): readonly unknown[] | undefined {
    if (!this.sessionFile) return;
    let content: string;
    try { content = readFileSync(this.sessionFile, "utf8"); } catch (error) {
      if (object(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (!content.endsWith("\n")) throw new Error("Parent session log has an incomplete durable record");
    const entries = parseSessionEntries(content);
    const header = entries[0];
    if (!header || header.type !== "session" || header.id !== this.sessionId) throw new Error("Parent session log identity mismatch");
    return entries;
  }

  private receipt(entries: readonly unknown[], delivery: TaskDelivery): DeliveryReceipt | undefined {
    for (const entry of entries) {
      if (!object(entry) || entry.type !== "custom_message" || entry.customType !== RESULT_MESSAGE_TYPE
        || !object(entry.details) || entry.details.deliveryId !== delivery.deliveryId) continue;
      if (entry.details.parentSessionId !== this.sessionId || entry.details.taskId !== delivery.taskId
        || entry.details.operationId !== delivery.operationId || entry.content !== resultContent(delivery)
        || entry.display !== false || typeof entry.id !== "string" || !entry.id
        || typeof entry.timestamp !== "string" || !entry.timestamp
        || (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId))) {
        throw new Error("Parent delivery identity or content mismatch");
      }
      return { deliveryId: delivery.deliveryId, parentSessionId: this.sessionId, entryId: entry.id };
    }
    return;
  }

  private wake(delivery: TaskDelivery, entries: readonly unknown[], eligible: () => boolean): void {
    const ctx = this.getContext();
    if (!eligible() || !this.belongs(ctx, delivery) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (entries.some(entry => object(entry) && entry.type === "custom_message" && entry.customType === WAKE_MESSAGE_TYPE
      && object(entry.details) && entry.details.deliveryId === delivery.deliveryId && entry.details.parentSessionId === this.sessionId)) return;
    this.pi.sendMessage({
      customType: WAKE_MESSAGE_TYPE, content: "Continue with the subagent result in the preceding messages.", display: false,
      details: { deliveryId: delivery.deliveryId, parentSessionId: this.sessionId },
    }, { triggerTurn: true });
  }
}
