import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";
import { applyParentModelAccess as applyParentModelAccessDecision } from "../core/update-parent-access.js";

export function applyParentModelAccess(
  routing: unknown,
  agentType: string,
  allowed: boolean,
): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, routing) || agentType.trim().length === 0) {
    throw new TypeError("Parent model access update is invalid.");
  }
  return applyParentModelAccessDecision(routing, agentType.trim(), allowed);
}
