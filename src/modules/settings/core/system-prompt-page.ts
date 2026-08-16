import { Check } from "typebox/value";
import { SystemPromptModeSchema, type SystemPromptMode } from "../../prompt/public.js";
import type { PromptSettingsView, SettingsRow } from "../contracts/settings-contracts.js";

/**
 * Choices come from the prompt module's schema, not a parallel list.
 * Bootstrap imports this list so validation cannot drift. Revisit if TypeBox
 * stops exposing union members on `anyOf`.
 */
function modesFromSchema(): readonly SystemPromptMode[] {
  const modes = SystemPromptModeSchema.anyOf.map((variant) => {
    if (typeof variant.const !== "string" || !Check(SystemPromptModeSchema, variant.const)) {
      throw new TypeError("System prompt mode schema is not a string-literal union.");
    }
    return variant.const;
  });
  if (modes.length === 0) {
    throw new TypeError("System prompt mode schema has no variants.");
  }
  return modes;
}

export const SYSTEM_PROMPT_MODES = modesFromSchema();

export function buildSystemPromptRows(view: PromptSettingsView): SettingsRow[] {
  const rows: SettingsRow[] = [
    {
      id: "systemPromptMode",
      kind: "choice",
      label: "System prompt mode",
      detail: "How the subagent system prompt is built: replace, inherit, or custom.",
      value: view.systemPromptMode,
      choices: [...SYSTEM_PROMPT_MODES],
    },
  ];

  // The create action only exists while it is actionable: custom mode without
  // an existing file. Success removes the row on the next snapshot.
  if (view.systemPromptMode === "custom" && !view.customPromptFileExists) {
    rows.push({
      id: "createPromptFile",
      kind: "action",
      label: "Create prompt file",
      detail: `Create ${view.customPromptPath} with a starter template for custom mode.`,
      value: view.customPromptPath,
      choices: ["Create"],
    });
  }

  rows.push(
    {
      id: "includeContextFiles",
      kind: "toggle",
      label: "Include AGENTS.md",
      detail: "Load project and Pi agent directory AGENTS.md as shared <project_context>.",
      value: view.includeContextFiles ? "ON" : "OFF",
      choices: ["ON", "OFF"],
    },
    {
      id: "loadSkillsImplicitly",
      kind: "toggle",
      label: "Load skills implicitly",
      detail: "Give new agents all skills when frontmatter omits the field.",
      value: view.loadSkillsImplicitly ? "ON" : "OFF",
      choices: ["ON", "OFF"],
    },
    {
      id: "loadExtensionsImplicitly",
      kind: "toggle",
      label: "Load extensions implicitly",
      detail: "Give new agents all extensions when frontmatter omits the field.",
      value: view.loadExtensionsImplicitly ? "ON" : "OFF",
      choices: ["ON", "OFF"],
    },
  );

  return rows;
}

export function promptChangeNotice(
  id: "systemPromptMode" | "includeContextFiles" | "loadSkillsImplicitly" | "loadExtensionsImplicitly",
  value: string | boolean,
): string {
  const rendered = typeof value === "boolean" ? (value ? "ON" : "OFF") : value;
  switch (id) {
    case "systemPromptMode":
      return `System prompt mode set to ${rendered}`;
    case "includeContextFiles":
      return `Include AGENTS.md set to ${rendered}`;
    case "loadSkillsImplicitly":
      return `Load skills implicitly set to ${rendered}`;
    case "loadExtensionsImplicitly":
      return `Load extensions implicitly set to ${rendered}`;
  }
}
