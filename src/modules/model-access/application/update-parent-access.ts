import { type ModelAccessFragment } from "../contracts/model-access-contracts.js";
import { outboundFragment, requireFragment } from "./checked-fragment.js";
import { applyParentModelAccess as applyParentModelAccessDecision } from "../core/update-parent-access.js";

export function applyParentModelAccess(
  routing: unknown,
  agentType: string,
  allowed: boolean,
): ModelAccessFragment {
  if (agentType.trim().length === 0) {
    throw new TypeError("Parent model access update is invalid.");
  }
  return outboundFragment(applyParentModelAccessDecision(requireFragment(routing), agentType.trim(), allowed));
}
