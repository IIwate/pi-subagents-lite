import type { AgentStatus } from "../contracts/lifecycle.js";

export function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

// Attention first, then motion, then the queue, then the archive.
// Warning and error paints already named who needs a person; stopped is
// dim and chosen, so it sinks with completed instead of burying a live
// run under a pile of user stops. There is no starting or stopping row —
// those phases never leave a status of their own. Revisit when a new
// AgentStatus appears, or if incomplete stops should join the failures.
export function listStatusRank(status: AgentStatus): number {
  switch (status) {
    case "error":
    case "aborted":
    case "turn_limited":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "completed":
    case "stopped":
      return 3;
  }
}

export function concurrencyKeyFromPolicy(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(
  into: { input: number; output: number; cacheWrite: number; cost: number },
  delta: { input: number; output: number; cacheWrite: number; cost: number },
): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cost += delta.cost;
}
