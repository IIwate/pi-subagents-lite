import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";
import {
  applyAgentProviderAccess as applyAgentProviderAccessDecision,
  applyQuickAgentProviderAccess as applyQuickAgentProviderAccessDecision,
} from "../core/update-provider-access.js";

function requireFragment(routing: unknown): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, routing)) {
    throw new TypeError("Model access fragment is invalid.");
  }
  return routing;
}

export function applyAgentProviderAccess(
  routing: unknown,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  return applyAgentProviderAccessDecision(requireFragment(routing), agentType, provider, models);
}

export function applyQuickAgentProviderAccess(
  routing: unknown,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  return applyQuickAgentProviderAccessDecision(requireFragment(routing), agentType, provider, models);
}
