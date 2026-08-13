/**
 * debug-page.ts — Rows, reports, and row-id decoding for the debug page.
 *
 * Reports are plain preformatted text: the page owns their layout so the
 * renderer only ever shows a notice, and the owner only supplies structured
 * JSON. Preview and fault rows keep the one-item-per-option shape of the
 * old menu — a single cycling row would apply every intermediate option.
 */

import type {
  DebugFault,
  DebugAgentType,
  DebugDiagnosticsView,
  DebugSettingsView,
  DebugStatusPreview,
  SettingsRow,
} from "../contracts/settings-contracts.js";

interface PreviewOption {
  id: string;
  label: string;
  detail: string;
  preview: DebugStatusPreview | null;
}

const PREVIEW_OPTIONS: readonly PreviewOption[] = [
  { id: "preview-clear", label: "Preview: Clear", detail: "Restore actual lifecycle status labels", preview: null },
  { id: "preview-queued", label: "Preview: Queued", detail: "Render all subagent rows as queued", preview: "queued" },
  { id: "preview-running", label: "Preview: Running", detail: "Render all subagent rows as running", preview: "running" },
  { id: "preview-done", label: "Preview: Done", detail: "Render all subagent rows as done", preview: "completed" },
  { id: "preview-turn-limit", label: "Preview: Turn limit", detail: "Render all subagent rows at the turn limit", preview: "turn_limited" },
  { id: "preview-aborted", label: "Preview: Aborted", detail: "Render all subagent rows as aborted", preview: "aborted" },
  { id: "preview-stopped", label: "Preview: Stopped", detail: "Render all subagent rows as stopped", preview: "stopped" },
  { id: "preview-error", label: "Preview: Error", detail: "Render all subagent rows as errors", preview: "error" },
];

interface FaultOption {
  id: string;
  label: string;
  detail: string;
  fault: DebugFault | null;
}

const FAULT_OPTIONS: readonly FaultOption[] = [
  { id: "arm-blocked", label: "Arm: blocked", detail: "Fail the next real child session after setup", fault: "output_blocked" },
  { id: "arm-provider", label: "Arm: provider error", detail: "Fail the next real child session after setup", fault: "provider_error" },
  { id: "arm-clear", label: "Arm: Clear", detail: "Clear the pending one-shot fault", fault: null },
];

/** Preview target for a row id; null clears, undefined means not a preview row. */
export function previewForRow(id: string): DebugStatusPreview | null | undefined {
  return PREVIEW_OPTIONS.find((option) => option.id === id)?.preview;
}

/** Fault target for a row id; null clears, undefined means not a fault row. */
export function faultForRow(id: string): DebugFault | null | undefined {
  return FAULT_OPTIONS.find((option) => option.id === id)?.fault;
}

export function previewNotice(preview: DebugStatusPreview | null, label: string): string {
  return preview ? `Status preview set to ${label.slice("Preview: ".length)}` : "Status preview cleared";
}

export function previewLabel(id: string): string {
  return PREVIEW_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

export function buildDebugRows(view: DebugSettingsView): SettingsRow[] {
  return [
    {
      id: "agentTypes",
      kind: "action",
      label: "Agent types",
      detail: "List available agent types and their configs",
      choices: ["Show"],
    },
    {
      id: "runtimeDiagnostics",
      kind: "action",
      label: "Runtime diagnostics",
      detail: "Inspect live sessions, errors, result delivery, and armed faults",
      choices: ["Show"],
    },
    ...PREVIEW_OPTIONS.map((option): SettingsRow => ({
      id: option.id,
      kind: "action",
      label: option.label,
      detail: option.detail,
      choices: ["Apply"],
    })),
    ...FAULT_OPTIONS.map((option): SettingsRow => ({
      id: option.id,
      kind: "action",
      label: option.fault !== null && option.fault === view.armedFault
        ? `${option.label} (armed)`
        : option.label,
      detail: option.detail,
      choices: [option.fault ? "Arm" : "Clear"],
    })),
  ];
}

export function formatAgentTypesReport(types: DebugAgentType[]): string {
  if (types.length === 0) return "No agent types available";
  const lines: string[] = ["Available agent types:\n"];
  for (const type of types) {
    const hidden = type.hidden ? " [HIDDEN]" : "";
    lines.push(`  ${type.name}${hidden}`);
    lines.push(`    ${type.description}`);
    lines.push(type.tools ? `  Tools: ${type.tools.join(", ")}` : "  Tools: all built-in tools");
    if (type.source) lines.push(`  Source: ${type.source}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatDiagnosticsReport(diagnostics: DebugDiagnosticsView): string {
  const lines = ["Subagent runtime diagnostics:\n"];
  if (diagnostics.armedFault) {
    lines.push(`Armed fault: ${diagnostics.armedFault} · next started Agent`);
    lines.push("");
  }
  if (diagnostics.agents.length === 0) {
    lines.push("No agents.");
  }
  for (const agent of diagnostics.agents) {
    lines.push(`${agent.id.slice(0, 8)} (${agent.type}) ${agent.status}`);
    lines.push(`  Session: ${agent.session} · Settled: ${agent.settled ? "yes" : "no"} · Persisted: ${agent.resultPersisted ? "yes" : "no"} · Consumed: ${agent.resultConsumed ? "yes" : "no"}`);
    if (agent.debugFaultKind) lines.push(`  Debug fault: ${agent.debugFaultKind}`);
    if (agent.error) lines.push(`  Error: ${agent.error}`);
    lines.push("");
  }
  return lines.join("\n");
}
