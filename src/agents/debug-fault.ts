export type DebugFaultKind = "output_blocked" | "provider_error";

/** One-shot, session-local fault armed from /agents → Debug. */
export interface ArmedDebugFault {
  kind: DebugFaultKind;
}

/** Fixed recovery window for a fault injected from the Debug menu. */
export const DEBUG_RECOVERY_TTL_MS = 10_000;

export function debugFaultMessage(kind: DebugFaultKind): string {
  return kind === "output_blocked"
    ? "debug injected: content was flagged"
    : "debug injected: provider error after session setup";
}
