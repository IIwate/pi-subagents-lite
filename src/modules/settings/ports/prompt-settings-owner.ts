import type {
  PromptSettingUpdate,
  PromptSettingsView,
  SettingsUpdateResult,
} from "../contracts/settings-contracts.js";

/**
 * Owner facade for the prompt fragment: mode, context-file inclusion, and
 * implicit skill/extension loading, plus the custom prompt file lifecycle.
 * The file path and existence come from the owner so settings never touches
 * the filesystem.
 */
export interface PromptSettingsOwner {
  read(): PromptSettingsView;
  update(update: PromptSettingUpdate): SettingsUpdateResult;
  createCustomPromptFile(): SettingsUpdateResult;
}
