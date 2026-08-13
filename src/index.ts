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
 *   - One persisted document (~/.pi/agent/subagents-lite.json), owned by the
 *     configuration module and reloaded at session_start
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
import { setPiInstance } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI) {
  // Subagents re-load this extension under their own pi/runtime. Stay inert so
  // we never overwrite the parent-owned shell (pi, sessionCtx, manager, ...).
  // The completion nudge relies on those still pointing at the parent session.
  if (isInsideSubagentSpawn()) return;
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
