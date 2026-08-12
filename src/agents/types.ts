import type { AgentDefinitionSnapshot } from "../modules/agent-catalogue/public.js";
import type { SystemPromptMode as RuntimeSystemPromptMode } from "../modules/subagent-runtime/public.js";

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** How the subagent system prompt is constructed. */
export type SystemPromptMode = RuntimeSystemPromptMode;

/** Agent configuration derived from the catalogue boundary schema. */
export type AgentConfig = Omit<AgentDefinitionSnapshot, "source"> & {
  source?: "built-in" | "project" | "global";
};
