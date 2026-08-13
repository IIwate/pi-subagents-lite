import type {
  DisplaySettingsView,
  DisplayToggleId,
  SettingsUpdateResult,
} from "../contracts/settings-contracts.js";

/**
 * Owner facade for the display fragment. `update` must persist before the new
 * value becomes visible to any consumer and must report failure explicitly;
 * settings never publishes an unpersisted candidate (REQ-CONFIG-001).
 */
export interface DisplaySettingsOwner {
  read(): DisplaySettingsView;
  update(id: DisplayToggleId, value: boolean): SettingsUpdateResult;
}
