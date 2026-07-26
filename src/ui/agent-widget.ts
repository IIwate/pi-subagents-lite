/**
 * agent-widget.ts — Subagent count badge in the status bar.
 *
 * This fork removed the tree above the editor; agent-navigator owns the progress list below it.
 * This module only maintains the setStatus "N agents" badge, polling running/queued counts and
 * clearing both the badge and timer when the count reaches zero.
 */

import type { AgentManager } from "../agents/agent-manager.js";

/** Braille spinner frames shared with agent-navigator's running icon. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Status bar key used with setStatus(). */
const STATUS_KEY = "subagents";

/** Status-bar polling interval in milliseconds. */
const STATUS_REFRESH_INTERVAL = 1000;

/** Minimal UI context required by the status badge. */
export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
};

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private statusInterval: ReturnType<typeof setInterval> | undefined;
  /** Last status text, used to avoid redundant setStatus redraws. */
  private lastStatusText: string | undefined;

  constructor(private manager: AgentManager) {}

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.lastStatusText = undefined;
    }
  }

  /** Ensure the status poll timer is running; refresh once immediately. */
  ensureTimer() {
    // Do not start a timer without UI. update() returns early without uiCtx and cannot stop it,
    // which would leave headless sessions polling at 1 Hz until shutdown.
    if (!this.uiCtx) return;
    if (!this.statusInterval) {
      this.statusInterval = setInterval(() => this.update(), STATUS_REFRESH_INTERVAL);
    }
    this.update();
  }

  /** Refresh the count badge; clear it and stop polling when no agent is running or queued. */
  update() {
    if (!this.uiCtx) return;

    let total = 0;
    for (const agent of this.manager.listAgents()) {
      const status = agent.lifecycle.status;
      if (status === "running" || status === "queued") total++;
    }

    // Show only the count; live cost would force the powerline to redraw every second.
    const statusText = total > 0 ? `${total} agent${total === 1 ? "" : "s"}` : undefined;
    if (statusText !== this.lastStatusText) {
      this.uiCtx.setStatus(STATUS_KEY, statusText);
      this.lastStatusText = statusText;
    }

    if (total === 0 && this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = undefined;
    }
  }

  dispose() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = undefined;
    }
    if (this.lastStatusText !== undefined) {
      this.uiCtx?.setStatus(STATUS_KEY, undefined);
      this.lastStatusText = undefined;
    }
    this.uiCtx = undefined;
  }
}
