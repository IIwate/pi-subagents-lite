/**
 * Port for the model-access policy owner. Views are precomputed serializable
 * JSON; every mutation verb is one atomic policy transition evaluated by the
 * model-access module (REQ-MODEL-007), committed before it becomes effective
 * (REQ-CONFIG-001). The pages never derive policy from raw rules.
 */

import type {
  ModelAccessAgentDetailView,
  ModelAccessAgentRow,
  ModelAccessModelsView,
  ModelAccessProvidersView,
  ModelAccessRootView,
  ModelAccessThinkingTarget,
  ModelAccessThinkingView,
  SettingsUpdateResult,
} from "../contracts/settings-contracts.js";

export interface ModelAccessSettingsOwner {
  root(): ModelAccessRootView;
  /** Registered plus saved-but-unavailable agent types, with access summaries. */
  agents(): ModelAccessAgentRow[];
  /** Registered agent types only — quick setup cannot target retired types. */
  quickAgents(): ModelAccessAgentRow[];
  agentDetail(type: string): ModelAccessAgentDetailView;
  providers(): ModelAccessProvidersView;
  models(type: string, provider: string): ModelAccessModelsView;
  /** Parent model plus currently routable alternates for one agent type. */
  thinkingTargets(type: string): ModelAccessThinkingTarget[];
  thinking(type: string, modelKey: string): ModelAccessThinkingView;

  setEnabled(enabled: boolean): SettingsUpdateResult;
  setProviderEnabled(provider: string, enabled: boolean): SettingsUpdateResult;
  setParentAccess(type: string, allowed: boolean): SettingsUpdateResult;
  /** Quick mode uses the canonical quick-setup transition (routing/provider enable). */
  toggleAllModels(type: string, provider: string, quick: boolean): SettingsUpdateResult;
  toggleModel(type: string, provider: string, modelId: string, quick: boolean): SettingsUpdateResult;
  toggleThinkingLevel(type: string, modelKey: string, level: string): SettingsUpdateResult;
  setThinkingDefault(type: string, modelKey: string, level: string): SettingsUpdateResult;
  resetThinking(type: string, modelKey: string): SettingsUpdateResult;
  deleteProviderRules(provider: string): SettingsUpdateResult;
  /** Re-reads candidates at confirmation time; stale IDs are never deleted twice. */
  cleanUnavailableRules(): SettingsUpdateResult;
  clearAll(): SettingsUpdateResult;
}
