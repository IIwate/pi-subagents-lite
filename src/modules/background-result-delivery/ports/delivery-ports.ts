import type { BackgroundResultRecord } from "../contracts/delivery.js";

export interface ResultRepository {
  read(): { pending: BackgroundResultRecord[]; latest: BackgroundResultRecord[] };
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
