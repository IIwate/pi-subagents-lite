import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeliveryHostContext } from "../../modules/background-result-delivery/public.js";

export function createPiDeliveryContext(
  ctx: () => ExtensionContext,
): DeliveryHostContext {
  return {
    parentSessionId: () => ctx().sessionManager.getSessionId(),
    activeBranchIds: () => ctx().sessionManager.getBranch().map((entry) => entry.id),
    isIdle: () => ctx().isIdle(),
  };
}
