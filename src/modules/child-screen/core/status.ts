import type { ChildRecordSummary, ChildStatus } from "../contracts/navigator.js";

export function agentStatusLabel(status: ChildStatus): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Done";
    case "turn_limited": return "Turn limit";
    case "aborted": return "Aborted";
    case "stopped": return "Stopped";
    case "error": return "Error";
  }
}

export function agentStatusColor(status: ChildStatus): string {
  if (status === "turn_limited" || status === "aborted") return "warning";
  if (status === "running") return "accent";
  if (status === "completed") return "success";
  if (status === "error") return "error";
  return "dim";
}

export function pendingLabel(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"} pending`;
}

export function displayNameOf(record: ChildRecordSummary): string {
  return record.displayName || record.type;
}

export function effectiveStatus(record: ChildRecordSummary, preview?: ChildStatus): ChildStatus {
  return preview ?? record.status;
}
