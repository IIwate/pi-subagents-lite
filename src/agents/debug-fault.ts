export type DebugFaultKind = "output_blocked" | "provider_error";

export function debugFaultMessage(kind: DebugFaultKind): string {
  return kind === "output_blocked"
    ? "debug injected: content was flagged"
    : "debug injected: provider error after session setup";
}
