import type { AgentStatus } from "../contracts/lifecycle.js";

export function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
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
