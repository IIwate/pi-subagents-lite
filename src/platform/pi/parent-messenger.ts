import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ParentMessenger } from "../../modules/background-result-delivery/public.js";

export function createPiParentMessenger(pi: ExtensionAPI): ParentMessenger {
  return {
    send(message, mode) {
      try {
        if (mode === "follow-up") pi.sendMessage(message, { deliverAs: "followUp" });
        else pi.sendMessage(message, { triggerTurn: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
