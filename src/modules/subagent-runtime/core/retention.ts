import { DEFAULT_RETENTION_MS, type AgentSnapshot } from "../contracts/lifecycle.js";
import { isTerminalStatus } from "./lifecycle-status.js";

export function shouldExpire(
  snapshot: AgentSnapshot,
  now: number,
  retentionMs = DEFAULT_RETENTION_MS,
): boolean {
  if (!isTerminalStatus(snapshot.status)) return false;
  if (snapshot.pinnedAt != null) return false;
  if (!snapshot.resultPersisted && !snapshot.resultConsumed) return false;
  const expiresAt = (snapshot.completedAt ?? 0) + retentionMs + (snapshot.cleanupExpiryPausedMs ?? 0);
  return expiresAt < now;
}

export function unpinCleanupPausedMs(snapshot: AgentSnapshot, now: number): number {
  if (snapshot.pinnedAt == null) return snapshot.cleanupExpiryPausedMs ?? 0;
  if (!isTerminalStatus(snapshot.status) || snapshot.completedAt == null) {
    return snapshot.cleanupExpiryPausedMs ?? 0;
  }
  const pausedFrom = Math.max(snapshot.pinnedAt, snapshot.completedAt);
  return (snapshot.cleanupExpiryPausedMs ?? 0) + Math.max(0, now - pausedFrom);
}
