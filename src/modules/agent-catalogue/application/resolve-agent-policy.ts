import { Check } from "typebox/value";
import {
  ResolveAgentPolicyCommandSchema,
  ResolvedAgentLoadingPolicySchema,
  type ResolveAgentPolicyResult,
  type ResolvedAgentLoadingPolicy,
} from "../contracts/catalogue-contracts.js";
import { resolveLoadingPolicy } from "../core/resolve-loading-policy.js";

function failure(code: "invalid-command" | "invalid-policy", message: string): ResolveAgentPolicyResult {
  return { ok: false, error: { code, message } };
}

export function resolveAgentDefinitionPolicy(command: unknown): ResolveAgentPolicyResult {
  if (!Check(ResolveAgentPolicyCommandSchema, command)) {
    return failure("invalid-command", "Agent policy command is invalid.");
  }

  const policy = resolveLoadingPolicy(command.definition, command.configuration);
  const snapshot: unknown = JSON.parse(JSON.stringify(policy));
  return Check(ResolvedAgentLoadingPolicySchema, snapshot)
    ? { ok: true, policy: snapshot as ResolvedAgentLoadingPolicy }
    : failure("invalid-policy", "Resolved Agent loading policy is invalid.");
}
