import { Check } from "typebox/value";
import {
  SubagentPromptRequestSchema,
  SubagentPromptResultSchema,
  type SubagentPromptResult,
} from "../contracts/prompt-contracts.js";
import {
  assembleSubagentPromptText,
  isVisiblePromptHeader,
} from "../core/assemble-subagent-prompt.js";

function failure(message: string): SubagentPromptResult {
  return { ok: false, error: { code: "invalid-command", message } };
}

function outbound(result: SubagentPromptResult): SubagentPromptResult {
  return Check(SubagentPromptResultSchema, result)
    ? result
    : failure("Subagent prompt result does not match its contract.");
}

export function assembleSubagentPrompt(command: unknown): SubagentPromptResult {
  if (!Check(SubagentPromptRequestSchema, command)) {
    return outbound(failure("Subagent prompt command is invalid."));
  }
  if (command.mode === "inherit" && !isVisiblePromptHeader(command.header)) {
    return outbound(failure("Inherited parent prompt is unavailable."));
  }
  return outbound({ ok: true, prompt: assembleSubagentPromptText(command) });
}
