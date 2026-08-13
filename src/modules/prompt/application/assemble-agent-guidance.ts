import { Check } from "typebox/value";
import {
  AgentGuidanceRequestSchema,
  type AgentGuidanceResult,
} from "../contracts/prompt-contracts.js";
import { assembleGuidanceText } from "../core/assemble-guidance.js";

export function assembleAgentGuidance(command: unknown): AgentGuidanceResult {
  if (!Check(AgentGuidanceRequestSchema, command)) {
    return {
      ok: false,
      error: { code: "invalid-command", message: "Agent guidance command is invalid." },
    };
  }
  return { ok: true, guidance: assembleGuidanceText(command) };
}
