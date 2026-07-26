/**
 * agent-widget.ts — 状态栏中的子代理计数徽标。
 *
 * 本 fork 已移除编辑器上方的树状渲染（进度列表由 agent-navigator
 * 的下方列表承担），此模块只负责 setStatus 的 "N agents" 徽标：
 * 定时轮询 running/queued 计数，计数归零时清除徽标并停表。
 */

import type { AgentManager } from "../agents/agent-manager.js";

/** Braille spinner frames（agent-navigator 的运行图标复用此帧表）。 */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Status bar key used with setStatus(). */
const STATUS_KEY = "subagents";

/** 状态栏轮询间隔（毫秒）。 */
const STATUS_REFRESH_INTERVAL = 1000;

/** 状态栏所需的最小 UI 上下文。 */
export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
};

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private statusInterval: ReturnType<typeof setInterval> | undefined;
  /** 上次写入的状态文本，避免重复调用 setStatus 触发无谓重绘。 */
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
    // 无 UI 时不建表：update() 会在 uiCtx 缺失时早退，走不到停表分支，
    // headless 会话里定时器会 1Hz 空转到会话结束。
    if (!this.uiCtx) return;
    if (!this.statusInterval) {
      this.statusInterval = setInterval(() => this.update(), STATUS_REFRESH_INTERVAL);
    }
    this.update();
  }

  /** 刷新状态栏计数；无 running/queued 代理时清除徽标并停止轮询。 */
  update() {
    if (!this.uiCtx) return;

    let total = 0;
    for (const agent of this.manager.listAgents()) {
      const status = agent.lifecycle.status;
      if (status === "running" || status === "queued") total++;
    }

    // 仅显示计数，不附带实时成本（成本每秒变化会迫使 powerline 持续重绘）
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
