import type { BackgroundResultRecord } from "../contracts/delivery.js";

export function belongsToActiveBranch(
  result: BackgroundResultRecord,
  parentSessionId: string,
  activeBranchIds: ReadonlySet<string>,
): boolean {
  return result.parentSessionId === parentSessionId
    && (result.originEntryId === null || activeBranchIds.has(result.originEntryId));
}

export function buildResultMessage(results: readonly BackgroundResultRecord[]) {
  if (results.length === 0) return undefined;
  return {
    customType: "subagent-result",
    content: results.map((result) =>
      `[Subagent "${result.type}" ${result.agentId} ${result.status}]\n\n${result.result}`,
    ).join("\n\n---\n\n"),
    display: false as const,
  };
}
