/**
 * menu-debug.ts — Debug menu concern.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Items: Agent types, runtime diagnostics, UI-only status previews, and
 * one-shot recovery tests.
 * Actions execute on select; Escape closes the menu.
 *
 * Exports:
 *   - showDebugMenu: agent types, diagnostics, previews, and recovery tests
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { buildListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getManager, getNavigator } from "../../shell.js";
import {
  DEBUG_RECOVERY_TTL_MS,
  type DebugFaultKind,
} from "../../agents/debug-fault.js";
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

const RECOVERY_TEST_ITEMS: Array<{
  value: string;
  label: string;
  description: string;
  fault?: DebugFaultKind;
}> = [
  {
    value: "arm-blocked-10s",
    label: "Arm: blocked · 10s",
    description: "Fail the next real child session after setup, then expire in 10 seconds",
    fault: "output_blocked",
  },
  {
    value: "arm-provider-10s",
    label: "Arm: provider error · 10s",
    description: "Fail the next real child session after setup, then expire in 10 seconds",
    fault: "provider_error",
  },
  { value: "arm-clear", label: "Arm: Clear", description: "Clear the pending one-shot recovery test" },
];

function buildDebugMenuItems(armedKind?: DebugFaultKind): SelectItem[] {
  return [
    { value: "agent-types", label: "Agent types", description: "List available agent types and their configs" },
    { value: "runtime-diagnostics", label: "Runtime diagnostics", description: "Inspect live sessions, errors, recovery windows, and armed faults" },
    ...STATUS_PREVIEW_ITEMS,
    ...RECOVERY_TEST_ITEMS.map((item) => ({
      ...item,
      label: item.fault === armedKind ? `${item.label} (armed)` : item.label,
    })),
  ];
}

function showRuntimeDiagnostics(ctx: ExtensionCommandContext): void {
  const diagnostics = getManager()?.debugDiagnostics();
  if (!diagnostics) {
    ctx.ui.notify("Agent manager is not available in this session", "info");
    return;
  }

  const lines = ["Subagent runtime diagnostics:\n"];
  if (diagnostics.armedFault) {
    lines.push(`Armed fault: ${diagnostics.armedFault.kind} · next started Agent · ${Math.ceil(DEBUG_RECOVERY_TTL_MS / 1000)}s recovery`);
    lines.push("");
  }
  if (diagnostics.agents.length === 0) {
    lines.push("No agents.");
  }
  for (const agent of diagnostics.agents) {
    lines.push(`${agent.id.slice(0, 8)} (${agent.type}) ${agent.status}`);
    lines.push(`  Session: ${agent.session} · Settled: ${agent.settled ? "yes" : "no"} · Result delivered: ${agent.resultConsumed ? "yes" : "no"}`);
    if (agent.debugFaultKind) {
      lines.push(`  Debug fault: ${agent.debugFaultKind}`);
    }
    if (agent.recoverable) {
      const countdown = agent.recoveryPaused ? "paused" : "active";
      lines.push(`  Recovery: Needs input · ${countdown} · ${Math.ceil((agent.recoveryRemainingMs ?? 0) / 1000)}s remaining`);
    }
    if (agent.error) lines.push(`  Error: ${agent.error}`);
    lines.push("");
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

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
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showDebugMenu(ctx: ExtensionCommandContext): Promise<void> {
  let result: unknown = "refresh";
  while (result === "refresh") {
    result = await ctx.ui.custom((_tui, theme, _kb, done) => {
      const armedKind = getManager()?.debugDiagnostics().armedFault?.kind;
      const selectList = new SelectList(buildDebugMenuItems(armedKind), 10, buildListTheme(theme));
      selectList.onSelect = async (item) => {
        if (item.value === "agent-types") {
          await showAgentTypes(ctx);
        } else if (item.value === "runtime-diagnostics") {
          showRuntimeDiagnostics(ctx);
        } else {
          const preview = STATUS_PREVIEW_ITEMS.find(option => option.value === item.value);
          if (preview) {
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
            return;
          }

          const recoveryTest = RECOVERY_TEST_ITEMS.find(option => option.value === item.value);
          if (!recoveryTest) return;
          const manager = getManager();
          if (!manager) {
            ctx.ui.notify("Agent manager is not available in this session", "info");
            return;
          }
          if (recoveryTest.fault) {
            manager.armDebugFault(recoveryTest.fault);
            ctx.ui.notify(`Armed ${recoveryTest.fault} for the next agent`, "info");
          } else {
            manager.clearDebugFault();
            ctx.ui.notify("Cleared armed recovery test", "info");
          }
          done("refresh");
        }
      };
      return new SettingsListWrapper(selectList, { title: "Debug", theme, onCancel: () => done(undefined) });
    });
  }
}
