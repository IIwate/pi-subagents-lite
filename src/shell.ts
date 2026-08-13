/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the Shell is the single mutable container for all per-session
 * state. Created at session_start, disposed at session_shutdown. Handler
 * modules read from shell via the getter functions — no module-level mutable
 * globals.
 *
 * index.ts populates the shell at session_start; handler modules import
 * getManager() / getNavigator() / etc.
 *
 * Reload-surviving process state (fallback result inbox, child-spawn marker)
 * lives in platform/process/process-state, not here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "./modules/subagent-runtime/public.js";
import type { ChildScreenHost } from "./bootstrap/child-screen.js";
import type { BackgroundDelivery } from "./modules/background-result-delivery/public.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: SubagentRuntime | null;
  delivery: BackgroundDelivery | null;
  navigator: ChildScreenHost | null;
}

// ============================================================================
// Mutable module-level shell (populated by index.ts at session_start)
// ============================================================================

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  delivery: null,
  navigator: null,
};

// ============================================================================
// Getter functions (read current state at call time)
// ============================================================================

/** The PI extension API instance. Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** The current session context. Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** The current Subagent runtime, or null if not yet created. */
export function getManager(): SubagentRuntime | null {
  return shell.manager;
}

/** The current background delivery facade, or null if not yet created. */
export function getDelivery(): BackgroundDelivery | null {
  return shell.delivery;
}

/** The current keyboard-driven agent navigator, or null if not yet created. */
export function getNavigator(): ChildScreenHost | null {
  return shell.navigator;
}

// ============================================================================
// Setter functions (called by index.ts to populate the shell)
// ============================================================================

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: SubagentRuntime | null): void {
  shell.manager = m;
}

export function setDelivery(delivery: BackgroundDelivery | null): void {
  shell.delivery = delivery;
}

export function setNavigator(navigator: ChildScreenHost | null): void {
  shell.navigator = navigator;
}
