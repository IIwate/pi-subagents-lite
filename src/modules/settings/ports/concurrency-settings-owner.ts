import type {
  ConcurrencyLimitUpdate,
  ConcurrencySettingsView,
  SettingsUpdateResult,
} from "../contracts/settings-contracts.js";

/**
 * Owner facade for the concurrency limits fragment. `read` supplies both the
 * saved overrides and the active provider/model inventory (registry, scope,
 * and running-agent keys are composition concerns). `update` must persist the
 * fragment before republishing runtime limits; on failure the previous limits
 * stay in force.
 */
export interface ConcurrencySettingsOwner {
  read(): ConcurrencySettingsView;
  update(update: ConcurrencyLimitUpdate): SettingsUpdateResult;
}
