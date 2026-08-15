/**
 * extension-runtime.ts — The explicit composition root record.
 *
 * One ExtensionRuntime is created per extension activation (index.ts) and
 * every registration and lifecycle callback closes over it. No module-level
 * getters expose this state, so constructing a second runtime in the same
 * process shares no ordinary session state. What IS deliberately process-wide:
 * the persisted configuration document (one file on disk) and the two approved
 * reload-surviving responsibilities in platform/process/process-state.
 *
 * This record supersedes the retired shared shell holder (history in
 * docs/architecture/decisions.md). It is not a service locator: nothing can
 * reach it without being handed it explicitly, and its fields are a closed,
 * typed set rather than a keyed registry.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime, WorktreeInspector } from "../modules/subagent-runtime/public.js";
import type { BackgroundDelivery } from "../modules/background-result-delivery/public.js";
import type { ModelAccessFragment } from "../modules/model-access/public.js";
import { createFsWorktreeInspector } from "../platform/fs/worktree-inspector.js";
import { createAgentRegistry, type AgentRegistry } from "./agent-registry.js";
import type { AgentCatalogue } from "../modules/agent-catalogue/public.js";
import { createAgentCatalogueRuntime } from "./agent-catalogue.js";
import type { ChildScreenHost } from "./child-screen.js";
import { configurationSectionIO, type ProjectConfigurationBinding } from "./configuration.js";
import { createAgentSettingsStore, type AgentSettingsStore } from "./agent-settings.js";
import { currentModelAccess } from "./model-access.js";

export interface ExtensionRuntime {
  readonly pi: ExtensionAPI;
  /** Current parent session context; replaced at each session_start. */
  sessionCtx: ExtensionContext | null;
  /** Project configuration handle for this session's cwd; bound at session_start. */
  projectConfig: ProjectConfigurationBinding | null;
  /** The subagent scheduler/runtime; created lazily at session_start. */
  manager: SubagentRuntime | null;
  /** Background result delivery facade; wired together with the manager. */
  delivery: BackgroundDelivery | null;
  /** The below-editor agent list host; created lazily at session_start. */
  navigator: ChildScreenHost | null;
  /** Agent fragment seam bound to this runtime's navigator for stats sync. */
  readonly agentSettings: AgentSettingsStore;
  /** Fresh model-routing policy read; injected so executors never reach the document directly. */
  readonly modelAccess: () => ModelAccessFragment;
  /**
   * The Agent tool owns the only worktree probe. Discovery and lifecycle consume
   * the validated path from that verdict; probing again could let the filesystem
   * change between answers and leave one accepted spawn with two versions of truth.
   */
  readonly worktree: WorktreeInspector;
  /** The activation's live Agent type registry, backed by the catalogue module. */
  readonly agents: AgentRegistry;
  /**
   * The one catalogue instance for this activation. session_start rescans
   * through this object so discovery and the live registry share one wiring
   * rather than a second factory call beside the registry.
   */
  readonly catalogue: AgentCatalogue;
}

export function createExtensionRuntime(pi: ExtensionAPI): ExtensionRuntime {
  const catalogue = createAgentCatalogueRuntime();
  const runtime: ExtensionRuntime = {
    pi,
    sessionCtx: null,
    projectConfig: null,
    manager: null,
    delivery: null,
    navigator: null,
    worktree: createFsWorktreeInspector(pi),
    catalogue,
    agents: createAgentRegistry({ catalogue }),
    // The thunk reads the runtime's own navigator lazily: the store exists
    // from activation, the navigator only after session_start.
    agentSettings: createAgentSettingsStore(configurationSectionIO, () => runtime.navigator),
    modelAccess: currentModelAccess,
  };
  // Built-in types exist from activation, not from the first disk scan: a
  // listener that fires before session_start would otherwise describe a session
  // with no Agent types at all. The persisted policy is honoured here so the
  // pre-scan window cannot offer a type the user disabled.
  runtime.agents.register(new Map(), {
    disableDefaultAgents: runtime.agentSettings.read().disableDefaultAgents,
  });
  return runtime;
}
