import type { BackgroundResultRecord } from "../contracts/delivery.js";

export interface ResultRepository {
  read(): { pending: BackgroundResultRecord[]; latest: BackgroundResultRecord[] };
  /**
   * Reread the current parent session for an explicit status lookup. The
   * construction snapshot grows stale; another runtime may persist a later
   * continuation after the volatile record is gone. Acknowledgement means
   * delivered, not erased, so the latest result remains queryable.
   */
  find(query: { agentId: string; deliveryId?: string }): BackgroundResultRecord | undefined;
  append(record: BackgroundResultRecord): boolean;
  acknowledge(parentSessionId: string, deliveryIds: readonly string[]): boolean;
}

export interface ParentMessenger {
  send(message: { customType: string; content: string; display: false }, mode: "turn" | "follow-up"): boolean;
}

export interface DeliveryHostContext {
  parentSessionId(): string;
  activeBranchIds(): string[];
  isIdle(): boolean;
}

export interface DeliveryFallbackStore {
  take(sessionId: string): BackgroundResultRecord[];
  save(sessionId: string, records: readonly BackgroundResultRecord[]): void;
}
