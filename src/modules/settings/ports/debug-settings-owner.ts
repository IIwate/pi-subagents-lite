import type {
  DebugAgentType,
  DebugDiagnosticsView,
  DebugFault,
  DebugSettingsView,
  DebugStatusPreview,
  SettingsUpdateResult,
} from "../contracts/settings-contracts.js";

/**
 * Owner facade for the debug page. Nothing here persists: the one-shot fault
 * and the status preview are session-local (REQ-RUNTIME-007), so failures
 * mean the runtime or child screen is unavailable in this session, not that
 * a save was lost. `diagnostics` reports unavailability the same way instead
 * of returning an empty report that would read as "no agents".
 */
export interface DebugSettingsOwner {
  read(): DebugSettingsView;
  agentTypes(): DebugAgentType[];
  diagnostics(): { ok: true; diagnostics: DebugDiagnosticsView } | { ok: false; message: string };
  setStatusPreview(preview: DebugStatusPreview | null): SettingsUpdateResult;
  armFault(fault: DebugFault | null): SettingsUpdateResult;
}
