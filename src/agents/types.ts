import type { AgentDefinitionSnapshot } from "../modules/agent-catalogue/public.js";

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

export type { SystemPromptMode } from "../modules/prompt/public.js";

/** Agent configuration derived from the catalogue boundary schema. */
export type AgentConfig = Omit<AgentDefinitionSnapshot, "source"> & {
  source?: "built-in" | "project" | "global";
};
