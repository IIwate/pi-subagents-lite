import type { AgentRecord } from "../types.js";

export type RecoverableFailureKind = "output_blocked" | "provider_error";

// Only explicit provider markers are classified as blocked. Pi currently loses
// several providers' raw finish reasons, so generic refusals stay provider_error.
const OUTPUT_BLOCKED_PATTERN = /\bcontent_filter\b|content was flagged/i;

/** Live-session continuation only; reload, shutdown, or manual clear destroys it. */
export function recoverableFailureKind(record: AgentRecord): RecoverableFailureKind | undefined {
  if (
    record.lifecycle.status !== "error"
    || record.execution.settled !== true
    || record.execution.session === undefined
    || record.execution.session.isStreaming === true
  ) {
    return undefined;
  }
  return OUTPUT_BLOCKED_PATTERN.test(record.error ?? "") ? "output_blocked" : "provider_error";
}

export function needsUserInput(record: AgentRecord): boolean {
  return recoverableFailureKind(record) !== undefined;
}
