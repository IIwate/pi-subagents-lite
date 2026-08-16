/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers tools, commands, and event listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - No description, no promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Optional model selection is resolved inside Agent execution
 *
 * Config:
 *   - One persisted document (subagents-lite.json in the Pi agent directory),
 *     owned by the configuration module and reloaded at session_start
 *   - Capabilities own their fragments; commits are atomic with explicit
 *     failure (bootstrap/agent-settings, bootstrap/model-access,
 *     bootstrap/concurrency)
 *
 * Commands:
 *   - /agents: Settings pages (model access, concurrency, spawn, prompt,
 *     display, debug)
 *
 * Shortcuts:
 *   - Alt+A: Toggle the below-editor subagent list
 *   - Alt+M: Return to Main from an active subagent
 *
 * Events:
 *   - session_start: Load config, register agents, initialise manager
 *   - session_shutdown: Abort all, dispose manager
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInsideSubagentSpawn } from "./platform/process/process-state.js";
import { createExtensionRuntime } from "./bootstrap/extension-runtime.js";
import { registerTools } from "./bootstrap/registration.js";
import { setupEventListeners } from "./bootstrap/events.js";

export default function (pi: ExtensionAPI) {
  // Subagents re-load this extension under their own pi instance. Stay inert
  // so the child never registers a second runtime over the parent's session;
  // the completion nudge relies on the parent-owned runtime staying intact.
  if (isInsideSubagentSpawn()) return;
  const runtime = createExtensionRuntime(pi);
  registerTools(runtime);
  setupEventListeners(runtime);
}
