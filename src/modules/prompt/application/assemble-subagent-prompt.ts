import { Check } from "typebox/value";
import {
  SubagentPromptRequestSchema,
  type SubagentPromptResult,
} from "../contracts/prompt-contracts.js";
import { assembleSubagentPromptText } from "../core/assemble-subagent-prompt.js";

export function assembleSubagentPrompt(command: unknown): SubagentPromptResult {
  if (!Check(SubagentPromptRequestSchema, command)) {
    return {
      ok: false,
      error: { code: "invalid-command", message: "Subagent prompt command is invalid." },
    };
  }
  return { ok: true, prompt: assembleSubagentPromptText(command) };
}
