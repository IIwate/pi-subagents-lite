import type {
  SettingsUpdateResult,
  SpawnSettingUpdate,
  SpawnSettingsView,
} from "../contracts/settings-contracts.js";

/**
 * Owner facade for the spawn/runtime fragment (forceBackground, graceTurns)
 * and the catalogue availability flag (disableDefaultAgents). `update` must
 * persist before publishing and may run owner-side effects (e.g. the agent
 * registry flag) only after a successful commit.
 */
export interface SpawnSettingsOwner {
  read(): SpawnSettingsView;
  update(update: SpawnSettingUpdate): SettingsUpdateResult;
}
