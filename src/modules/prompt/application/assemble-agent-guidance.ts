import { Check } from "typebox/value";
import {
  AgentGuidanceRequestSchema,
  AgentGuidanceResultSchema,
  type AgentGuidanceResult,
} from "../contracts/prompt-contracts.js";
import { assembleGuidanceText } from "../core/assemble-guidance.js";

function failure(message: string): AgentGuidanceResult {
  return { ok: false, error: { code: "invalid-command", message } };
}

function outbound(result: AgentGuidanceResult): AgentGuidanceResult {
  return Check(AgentGuidanceResultSchema, result)
    ? result
    : failure("Agent guidance result does not match its contract.");
}

export function assembleAgentGuidance(command: unknown): AgentGuidanceResult {
  if (!Check(AgentGuidanceRequestSchema, command)) {
    return outbound(failure("Agent guidance command is invalid."));
  }
  return outbound({ ok: true, guidance: assembleGuidanceText(command) });
}
