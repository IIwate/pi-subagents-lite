import type { BackgroundResultRecord } from "../contracts/delivery.js";

// The parent wake is a knock, not a reprint. 4000 matches the Child
// tool-result clip: enough of the lead to know what happened, not
// enough to refill the context window with a report that already
// lives on the record. Persist and AgentStatus still carry the
// whole text. Revisit if Child moves its limit, or if truncated
// wakes start costing a second lookup every time.
const PARENT_INJECTION_RESULT_CHAR_LIMIT = 4000;

export function belongsToActiveBranch(
  result: BackgroundResultRecord,
  parentSessionId: string,
  activeBranchIds: ReadonlySet<string>,
): boolean {
  return result.parentSessionId === parentSessionId
    && (result.originEntryId === null || activeBranchIds.has(result.originEntryId));
}

function injectedResultBody(result: BackgroundResultRecord): string {
  if (result.result.length <= PARENT_INJECTION_RESULT_CHAR_LIMIT) return result.result;
  return `${result.result.slice(0, PARENT_INJECTION_RESULT_CHAR_LIMIT)}\n… (truncated; use AgentStatus({ agent_id: "${result.agentId}" }) to read the full result)`;
}

export function buildResultMessage(results: readonly BackgroundResultRecord[]) {
  if (results.length === 0) return undefined;
  return {
    customType: "subagent-result",
    content: results.map((result) =>
      `[Subagent "${result.type}" ${result.agentId} ${result.status}]\n\n${injectedResultBody(result)}`,
    ).join("\n\n---\n\n"),
    display: false as const,
  };
}
