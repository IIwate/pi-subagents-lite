/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { EnvInfo } from "../types.js";
import type { AgentConfig, SystemPromptMode } from "../agents/types.js";
import type { SkillMeta, PreloadedSkill } from "./skill-loader.js";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { assembleSubagentPrompt } from "../modules/prompt/public.js";

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Preloaded skill contents to inject (full content + description). */
  skillBlocks?: PreloadedSkill[];
  /** Skill metadata for whitelist display (name, description, location only). */
  skillMetas?: SkillMeta[];
  /** Parent system prompt (for inherit mode). */
  parentSystemPrompt?: string;
  /** Custom system prompt content (for custom mode). */
  customSystemPrompt?: string;
  /** Project context files (AGENTS.md) for custom mode. */
  contextFiles?: Array<{ path: string; content: string }>;
}

/**
 * Strip pi scaffolding sections from a parent system prompt.
 *
 * In inherit mode, the parent's prompt already contains:
 *   - <project_context>...</project_context>  (AGENTS.md)
 *   - Skills block (text intro + <available_skills>...</available_skills>)
 *   - Current date: YYYY-MM-DD
 *   - Current working directory: /path
 *
 * These are re-added by subagents-lite from the subagent's own config,
 * so we strip them to avoid duplication.
 *
 * @param prompt  The parent system prompt to clean.
 * @returns       The prompt with scaffolding sections removed.
 */
/**
 * Build the system prompt for an agent from its config.
 *
 * Three modes:
 * - replace (default): generic header + env + agent's systemPrompt
 * - inherit: parent's system prompt (stripped of scaffolding) + env + agent's systemPrompt
 * - custom: content of ~/.pi/agent/subagents-lite-prompt.md + env + agent's systemPrompt
 *
 * Agent's own systemPrompt is always included in <agent_instructions> tags.
 *
 * @param config   Agent configuration.
 * @param cwd      Current working directory.
 * @param env      Environment info.
 * @param extras   Optional extra sections to inject (skills, parent/custom prompts).
 * @param mode     System prompt mode (replace, inherit, custom).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
  mode: SystemPromptMode = "replace",
): string {
  const skillElements: string[] = [];
  if (extras?.skillMetas?.length) {
    const piSkills: Skill[] = extras.skillMetas.map((m) => ({
      name: m.name,
      description: m.description,
      filePath: m.location,
      baseDir: "",
      sourceInfo: {} as any,
      disableModelInvocation: m.disableModelInvocation,
    }));
    const formatted = formatSkillsForPrompt(piSkills);
    const extracted = formatted.match(/<skill>[\s\S]*?<\/skill>/g);
    if (extracted) skillElements.push(...extracted);
  }
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
