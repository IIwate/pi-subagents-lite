import { type ModelAccessFragment } from "../contracts/model-access-contracts.js";
import { outboundFragment, requireFragment } from "./checked-fragment.js";
import {
  applyAgentProviderAccess as applyAgentProviderAccessDecision,
  applyQuickAgentProviderAccess as applyQuickAgentProviderAccessDecision,
} from "../core/update-provider-access.js";

export function applyAgentProviderAccess(
  routing: unknown,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  return outboundFragment(
    applyAgentProviderAccessDecision(requireFragment(routing), agentType, provider, models),
  );
}

export function applyQuickAgentProviderAccess(
  routing: unknown,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  return outboundFragment(
    applyQuickAgentProviderAccessDecision(requireFragment(routing), agentType, provider, models),
  );
}
