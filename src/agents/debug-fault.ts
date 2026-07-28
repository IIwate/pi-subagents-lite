export type DebugFaultKind = "output_blocked" | "provider_error";

/** One-shot, session-local fault armed from /agents → Debug. */
export interface ArmedDebugFault {
  kind: DebugFaultKind;
  recoveryTtlMs: number;
}

export const DEBUG_RECOVERY_WINDOWS = [
  { label: "10s", ms: 10_000 },
  { label: "30m", ms: 30 * 60_000 },
] as const;

export function debugFaultMessage(kind: DebugFaultKind): string {
  return kind === "output_blocked"
    ? "debug injected: content was flagged"
    : "debug injected: provider error after session setup";
}
