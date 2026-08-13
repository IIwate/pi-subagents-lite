import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResultRepository } from "../../modules/background-result-delivery/public.js";
import {
  appendPendingResult,
  appendResultAck,
  readResultEntries,
} from "../../spawn/result-inbox.js";

export function createPiResultRepository(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ResultRepository {
  return {
    read() {
      const entries = readResultEntries(ctx);
      return {
        pending: [...entries.pending.values()],
        latest: [...entries.latest.values()],
      };
    },
    append(record) {
      return appendPendingResult(pi, record);
    },
    acknowledge(parentSessionId, deliveryIds) {
      return appendResultAck(pi, parentSessionId, deliveryIds);
    },
  };
}
