/**
 * prompts.ts — Pi host adapter for Subagent system-prompt assembly.
 *
 * Skill XML wrapping and inherit/custom header selection stay here because
 * they bind Pi-loaded skill bytes to the prompt module. Assembly itself is
 * assembleSubagentPrompt. Inherit mode is a first-class request that module
 * already honors; this file must not pretend agents have no parent identity.
 */

import type { EnvInfo } from "../../types.js";
import type { SystemPromptMode } from "../../modules/prompt/public.js";
import { assembleSubagentPrompt } from "../../modules/prompt/public.js";

/** The fields assembleSubagentPrompt reads from an accepted definition. */
interface AgentPromptConfig {
  name: string;
  systemPrompt: string;
}

/** One preloaded skill: full content inlined into the prompt. */
export interface PreloadedSkill {
  name: string;
  description: string;
  content: string;
}

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Preloaded skill contents to inject (full content + description). */
  skillBlocks?: PreloadedSkill[];
  /** Pre-rendered `<skill>` elements for the whitelist block. */
  skillElements?: string[];
  /** Parent system prompt (for inherit mode). */
  parentSystemPrompt?: string;
  /** Custom system prompt content (for custom mode). */
  customSystemPrompt?: string;
  /** Project context files (AGENTS.md) for custom mode. */
  contextFiles?: Array<{ path: string; content: string }>;
}

/**
 * Bind Pi-loaded skill bytes and host extras, then hand assembly to
 * assembleSubagentPrompt. Mode meaning, inherit visibility, and header
 * fallback live in the prompt module; this adapter does not restate them.
 *
 * @param config   Agent configuration.
 * @param cwd      Current working directory.
 * @param env      Environment info.
 * @param extras   Optional extra sections to inject (skills, parent/custom prompts).
 * @param mode     System prompt mode from the prompt module.
 */
export function buildAgentPrompt(
  config: AgentPromptConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
  mode: SystemPromptMode = "replace",
): string {
  const skillElements: string[] = [...(extras?.skillElements ?? [])];
  for (const skill of extras?.skillBlocks ?? []) {
    skillElements.push(
      `<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><content>${escapeXml(skill.content)}</content></skill>`,
    );
  }

  const rawHeader = mode === "inherit" ? extras?.parentSystemPrompt
    : mode === "custom" ? extras?.customSystemPrompt
    : undefined;
  const result = assembleSubagentPrompt({
    kind: "assemble-subagent-prompt",
    mode,
    agentName: config.name,
    agentInstructions: config.systemPrompt,
    cwd,
    env: { isGitRepo: env.isGitRepo, branch: env.branch, platform: env.platform },
    header: rawHeader ?? null,
    contextFiles: extras?.contextFiles ?? [],
    skillElements,
  });
  if (!result.ok) throw new TypeError(result.error.message);
  return result.prompt;
}

function escapeXml(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
