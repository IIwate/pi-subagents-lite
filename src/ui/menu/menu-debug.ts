/**
 * menu-debug.ts — Debug menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Items: Agent types, agent briefing, and UI-only status previews.
 * Actions execute on select; Escape closes the menu.
 *
 * Exports:
 *   - showDebugMenu: agent types, briefing, and status preview
 *
 * Private helpers (single-consumer, co-located):
 *   - showAgentTypes: list available agent types and their configs
 *   - handleAgentBriefing: send agent types/capabilities info to LLM
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAvailableTypes, getAllTypes } from "../../agents/agent-types.js";
import { buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getPiInstance, getNavigator } from "../../shell.js";
import type { DebugStatusPreview } from "../agent-navigator.js";

const STATUS_PREVIEW_ITEMS: Array<{
  value: string;
  label: string;
  description: string;
  preview?: DebugStatusPreview;
}> = [
  { value: "preview-clear", label: "Preview: Clear", description: "Restore actual lifecycle status labels" },
  { value: "preview-queued", label: "Preview: Queued", description: "Render all subagent rows as queued", preview: "queued" },
  { value: "preview-running", label: "Preview: Running", description: "Render all subagent rows as running", preview: "running" },
  { value: "preview-done", label: "Preview: Done", description: "Render all subagent rows as done", preview: "completed" },
  { value: "preview-turn-limit", label: "Preview: Turn limit", description: "Render all subagent rows at the turn limit", preview: "turn_limited" },
  { value: "preview-aborted", label: "Preview: Aborted", description: "Render all subagent rows as aborted", preview: "aborted" },
  { value: "preview-stopped", label: "Preview: Stopped", description: "Render all subagent rows as stopped", preview: "stopped" },
  { value: "preview-error", label: "Preview: Error", description: "Render all subagent rows as errors", preview: "error" },
  { value: "preview-needs-input", label: "Preview: Needs input", description: "Render all subagent rows as needing input", preview: "needs_input" },
];

async function showAgentTypes(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const lines: string[] = ["Available agent types:\n"];
  for (const name of types) {
    const cfg = getAgentConfig(name);
    if (!cfg) continue;
    const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAgentBriefing(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAvailableTypes();
  const agents = types.map((t) => ({ name: t, config: getAgentConfig(t) }));

  const lines: string[] = [
    "# Agent Types and Capabilities\n",
    "The following agent types are available. Use the `agent` parameter to select one.\n",
  ];

  for (const { name, config } of agents) {
    if (!config) continue;
    lines.push(`## ${config.displayName ?? name}`);
    lines.push(config.description);
    lines.push("");

    if (config.registeredTools) {
      lines.push(`**Tools:** ${config.registeredTools.join(", ")}`);
    }
    if (config.model) {
      lines.push(`**Default model:** ${config.model}`);
    }
    if (config.maxTurns) {
      lines.push(`**Max turns:** ${config.maxTurns}`);
    }
    lines.push("");
  }

  // Parameter descriptions
  lines.push("## Agent Tool Parameters\n");
  lines.push("| Parameter | Description |");
  lines.push("|-----------|-------------|");
  lines.push("| `prompt` | The task for the agent (required) |");
  lines.push("| `description` | One-line summary of what the agent should do (required) |");
  lines.push("| `agent` | Which agent type to use (default: general-purpose) |");
  lines.push("| `model` | Optional model override. Forms: bare id (`grok-4.5`), `provider/id` (`cpa-responses/grok-4.5`), or with thinking shorthand (`grok-4.5:low`). Bare id must exactly match an available model id. Default: configured override or parent model. |");
  lines.push("| `thinking` | Optional thinking mode override (e.g., `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Also accepted via `model` as `id:thinking`. |");
  lines.push("| `run_in_background` | When `true`, result is auto-delivered — do NOT poll, sleep, or timeout-wait. Parent task advances automatically on completion. |");
  lines.push("| `worktree_path` | Optional path to a git worktree of the parent's repo. See below for details. |");
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, sleep, timeout, or busy-wait");
  lines.push("  → When a subagent finishes, a notification arrives and the parent task advances automatically");
  lines.push("");
  lines.push("## `worktree_path` Parameter\n");
  lines.push("Use `worktree_path` to run a subagent in a different git worktree of the parent's repository.");
  lines.push("");
  lines.push("- **Optional.** Omit to run the subagent in the parent's working directory (default behavior).");
  lines.push("- **Must be a path** inside a git worktree of the parent's repo, including the main checkout. Not a different repo, not a non-git directory.");
  lines.push("- **Relative paths** are resolved against the parent's working directory.");
  lines.push("- **On failure** the validator returns a specific reason (e.g., 'not a worktree of the parent's repository', 'path does not exist') — use this to self-correct.");
  lines.push("- **Agent type discovery:** The worktree's `.pi/agents/` directory is scanned for agent types when this param is set, so worktree-local types become available to that spawn.");
  getPiInstance().sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

export async function showDebugMenu(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      { value: "agent-types", label: "Agent types", description: "List available agent types and their configs" },
      { value: "agent-briefing", label: "Agent briefing", description: "Send agent types/capabilities info to LLM (Optional, if having issues)" },
      ...STATUS_PREVIEW_ITEMS,
    ];

    const selectList = new SelectList(items, 10, buildSelectListTheme(theme));
    selectList.onSelect = async (item) => {
      if (item.value === "agent-types") {
        await showAgentTypes(ctx);
      } else if (item.value === "agent-briefing") {
        await handleAgentBriefing(ctx);
      } else {
        const preview = STATUS_PREVIEW_ITEMS.find(option => option.value === item.value);
        if (!preview) return;
        const navigator = getNavigator();
        if (!navigator) {
          ctx.ui.notify("Agent list is not available in this session", "info");
          return;
        }
        navigator.setDebugStatusPreview(preview.preview);
        ctx.ui.notify(
          preview.preview ? `Status preview set to ${preview.label.slice("Preview: ".length)}` : "Status preview cleared",
          "info",
        );
      }
    };
    return new SettingsListWrapper(selectList, { title: "Debug", theme, onCancel: () => done(undefined) });
  });
}
