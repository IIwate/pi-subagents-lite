import {
  CustomEditor,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { getConfig } from "../../../agents/agent-types.js";
import { errorMessage } from "../../../utils.js";
import type {
  AgentSnapshot,
  InteractionResult,
  SubagentRuntime,
} from "../../../modules/subagent-runtime/public.js";
import {
  createChildScreen,
  type ChildRecordSummary,
  type ChildScreen,
  type ChildStatus,
  type NavigatorKey,
  type StatsVisibility,
} from "../../../modules/child-screen/public.js";
import { ChildNavigationEditor } from "./editor.js";
import {
  CLEAR_SCROLLBACK_SEQUENCE,
  restoreMain,
  swapToChild,
  validateChildLayout,
  renderChildFooter,
  type ScreenSwapState,
} from "./layout.js";
import { paintLines, paintParts } from "./paint.js";

const SELECTOR_WIDGET_KEY = "agent-navigator-selector";
const STATUS_KEY = "subagents-lite";
const REFRESH_INTERVAL_MS = 1000;

export type DebugStatusPreview = ChildStatus;

type NavigatorUICtx = Pick<
  ExtensionUIContext,
  | "getEditorComponent"
  | "getEditorText"
  | "notify"
  | "setEditorComponent"
  | "setEditorText"
  | "setStatus"
  | "setWidget"
  | "theme"
>;

function piTextLayout() {
  return {
    visibleWidth,
    truncate: truncateToWidth,
    wrap(text: string, width: number): string[] {
      const wrapWidth = Math.max(1, width);
      const lines: string[] = [];
      for (const source of text.split("\n")) {
        if (!source) {
          lines.push("");
          continue;
        }
        lines.push(...wrapTextWithAnsi(source, wrapWidth));
      }
      return lines;
    },
  };
}

function toKey(data: string): NavigatorKey | undefined {
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape)) return "escape";
  if (matchesKey(data, Key.ctrl("d"))) return "ctrl-d";
  if (matchesKey(data, Key.ctrl("c"))) return "ctrl-c";
  if (data === " ") return "space";
  if (data.length === 1 && data.charCodeAt(0) >= 32) return "printable";
  return undefined;
}

export class ChildScreenHost {
  private uiCtx: NavigatorUICtx | undefined;
  private readonly screen: ChildScreen;
  private footerStatus: string | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastRenderSig = "";
  private shrinkClearingTui: TUI | undefined;
  private previousClearOnShrink: boolean | undefined;
  private lastAgentStatus = new Map<string, AgentSnapshot["status"]>();
  private selectorRegistered = false;
  private selectorTui: TUI | undefined;
  private hostTui: TUI | undefined;
  private screenSwap: ScreenSwapState | undefined;
  private layoutWarningShown = false;
  private errorWarningShown = false;
  private restoreEditor: (() => void) | undefined;
  private navigationEditor: ChildNavigationEditor | undefined;

  constructor(
    private manager: SubagentRuntime,
    private routeInput?: (agentId: string, text: string) => Promise<InteractionResult>,
    private getPendingResultCount?: () => number | undefined,
    initialListExpanded = true,
  ) {
    this.screen = createChildScreen({
      initialListExpanded,
      textLayout: piTextLayout(),
    });
  }

  private pendingResultState(): number | undefined {
    const count = this.getPendingResultCount?.();
    return count && count > 0 ? count : undefined;
  }

  private presentationRecords(): ChildRecordSummary[] {
    return this.manager.listSnapshots().map((record) => {
      const session = this.manager.inspectSession(record.id);
      return {
        id: record.id,
        status: record.status,
        type: record.type,
        description: record.description ?? "",
        pinned: record.pinnedAt != null,
        displayName: getConfig(record.type).displayName,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        debugFaultKind: record.debugFaultKind,
        error: record.error,
        invocation: record.invocation
          ? {
            providerName: record.invocation.providerName,
            modelName: record.invocation.modelName,
            thinkingLevel: record.invocation.thinkingLevel,
          }
          : undefined,
        stats: {
          toolUses: record.stats.toolUses,
          turnCount: record.stats.turnCount,
          maxTurns: record.stats.maxTurns,
          input: record.stats.lifetimeUsage.input,
          output: record.stats.lifetimeUsage.output,
          cost: record.stats.lifetimeUsage.cost,
          contextPercent: record.stats.contextPercent,
          compactionCount: record.stats.compactionCount,
        },
        session: {
          found: session.found,
          live: session.live,
          streaming: session.streaming,
          modelId: session.modelId,
          provider: session.provider,
          thinkingLevel: session.thinkingLevel,
          contextPercent: session.contextPercent,
          messages: session.messages,
          streamingMessage: session.streamingMessage,
        },
      };
    });
  }

  private syncRecords(highlightIndex?: number) {
    const pending = this.pendingResultState();
    return this.screen.execute({
      kind: "replace-records",
      records: this.presentationRecords(),
      ...(pending != null ? { pendingResultCount: pending } : {}),
      ...(highlightIndex != null ? { highlightIndex } : {}),
    });
  }

  private snapshot() {
    const inspected = this.screen.execute({ kind: "inspect" });
    return inspected.ok ? inspected.snapshot : undefined;
  }

  setUICtx(ctx: NavigatorUICtx): void {
    if (ctx === this.uiCtx) return;
    if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
    this.restoreShrinkClearing();
    this.restoreEditor?.();
    this.uiCtx?.setStatus(STATUS_KEY, undefined);
    this.footerStatus = undefined;
    this.hostTui = undefined;
    this.uiCtx = ctx;
    this.selectorRegistered = false;
    this.selectorTui = undefined;
    this.screenSwap = undefined;
    this.layoutWarningShown = false;
    this.errorWarningShown = false;

    const previousEditor = ctx.getEditorComponent();
    ctx.setEditorComponent((tui, theme, keybindings) => {
      const base = previousEditor?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      const editor = new ChildNavigationEditor(base, this);
      this.navigationEditor = editor;
      return editor;
    });
    this.restoreEditor = () => {
      ctx.setEditorComponent(previousEditor);
      this.navigationEditor = undefined;
    };
    this.update();
  }

  toggleList(): void {
    this.syncRecords();
    this.screen.execute({ kind: "toggle-fold" });
    this.lastRenderSig = "";
    this.update();
  }

  activateMain(): void {
    const current = this.snapshot();
    if (!current || current.selectedAgentId === null) return;
    if (this.activate(null)) this.update();
  }

  selectedId(): string | null {
    const wasSelected = this.snapshot()?.selectedAgentId ?? null;
    this.syncRecords();
    const selected = this.snapshot()?.selectedAgentId ?? null;
    if (wasSelected && !selected) {
      if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
      this.update();
    }
    return selected;
  }

  setDebugStatusPreview(status: DebugStatusPreview | undefined): void {
    this.screen.execute({ kind: "set-debug-preview", ...(status ? { status } : {}) });
    this.lastRenderSig = "";
    this.requestRender(true);
  }

  setStatsVisibility(visible: StatsVisibility): void {
    this.screen.execute({ kind: "set-stats-visibility", visibility: visible });
    this.lastRenderSig = "";
    this.requestRender();
  }

  ensureTimer(): void {
    if (!this.uiCtx) return;
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.update(), REFRESH_INTERVAL_MS);
    }
    this.update();
  }

  handleEditorSubmit(text: string): boolean {
    const agentId = this.selectedId();
    const trimmed = text.trim();
    if (
      !agentId
      || !trimmed
      || trimmed.startsWith("/")
      || trimmed.startsWith("!")
      || !this.routeInput
    ) {
      return false;
    }
    const requestId = this.beginInteraction(agentId);
    void this.routeInput(agentId, trimmed)
      .then((result) => this.completeInteraction(requestId, agentId, text, result))
      .catch(() => this.completeInteraction(
        requestId,
        agentId,
        text,
        { accepted: false, reason: "unavailable" },
      ));
    return true;
  }

  handleTerminalInput(data: string): { consume?: boolean } | undefined {
    this.syncRecords();
    const previousSelected = this.snapshot()?.selectedAgentId ?? null;
    const key = toKey(data);
    if (!key) return undefined;
    const result = this.screen.execute({
      kind: "key",
      key,
      editorEmpty: this.uiCtx?.getEditorText() === "",
    });
    if (!result.ok) return undefined;
    if (result.notify) this.uiCtx?.notify(result.notify.message, result.notify.level);
    if (result.effect?.type === "toggle-pin") {
      const pinned = this.manager.togglePinned(result.effect.agentId);
      if (pinned == null) this.uiCtx?.notify("Agent not found", "warning");
      else this.uiCtx?.notify(pinned ? "Subagent pinned" : "Subagent unpinned", "info");
    }
    if (result.effect?.type === "clear") {
      const cleared = this.manager.clear(result.effect.agentId, "user");
      if (!cleared) this.uiCtx?.notify("Agent not found", "warning");
      else this.syncRecords(result.effect.index);
    }
    if (key === "enter" && result.consume) {
      const selected = result.snapshot.selectedAgentId;
      if (!this.applySelection(selected)) {
        this.screen.execute({ kind: "select", agentId: previousSelected });
        this.warnUnsupportedLayout();
      } else {
        this.clearScrollbackAndRender();
        if (selected && !this.refreshTimer) this.ensureTimer();
      }
    }
    if (result.consume || result.notify || result.effect) this.update();
    return result.consume ? { consume: true } : undefined;
  }

  beginInteraction(agentId: string): number {
    const begun = this.screen.execute({ kind: "begin-interaction", agentId });
    return begun.ok ? begun.interactionRequestId ?? begun.snapshot.interactionRequestId : -1;
  }

  completeInteraction(
    requestId: number,
    agentId: string,
    text: string,
    result: InteractionResult,
  ): boolean {
    const current = this.snapshot();
    if (!current || requestId !== current.interactionRequestId || agentId !== current.selectedAgentId) {
      return false;
    }
    if (result.accepted) {
      this.clearInteractionNotice();
      return true;
    }
    if (this.uiCtx?.getEditorText() === "") this.uiCtx.setEditorText(text);
    const notice = result.reason === "concurrency" && result.concurrencyKey
      ? `Blocked: ${result.concurrencyKey} concurrency limit reached`
      : result.reason === "queued"
        ? "Blocked: selected subagent is queued"
        : "Blocked: selected subagent is unavailable";
    this.screen.execute({ kind: "set-interaction-notice", notice });
    this.lastRenderSig = "";
    this.update();
    return true;
  }

  clearInteractionNotice(): void {
    if (!this.snapshot()?.interactionNotice) return;
    this.screen.execute({ kind: "set-interaction-notice" });
    this.lastRenderSig = "";
    this.update();
  }

  private activate(id: string | null): boolean {
    const current = this.snapshot()?.selectedAgentId ?? null;
    if (id === current) return true;
    this.syncRecords();
    const selected = this.screen.execute({ kind: "select", agentId: id });
    if (!selected.ok) return false;
    if (!this.applySelection(id)) {
      this.screen.execute({ kind: "select", agentId: current });
      this.warnUnsupportedLayout();
      return false;
    }
    this.clearScrollbackAndRender();
    if (id && !this.refreshTimer) this.ensureTimer();
    return true;
  }

  private applySelection(id: string | null): boolean {
    if (id) return this.swapToSubagentScreen();
    restoreMain(this.screenSwap);
    return true;
  }

  private captureScreen(tui: TUI, selector: Component): void {
    if (this.screenSwap?.tui === tui) return;
    if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
    const validated = validateChildLayout(tui, selector, this.navigationEditor);
    if (!validated.ok) {
      this.screenSwap = undefined;
      this.warnUnsupportedLayout();
      return;
    }
    const transcript: Component = {
      render: (width) => this.renderActiveTranscript(width),
      invalidate: () => {},
    };
    const originalFooterRender = validated.footerContainer.render;
    this.screenSwap = {
      tui,
      documentChildren: validated.documentChildren,
      chatIndex: 2,
      originalChat: validated.originalChat,
      pendingContainer: validated.pendingContainer,
      statusContainer: validated.statusContainer,
      footerContainer: validated.footerContainer,
      originalPendingRender: validated.pendingContainer.render,
      originalStatusRender: validated.statusContainer.render,
      originalFooterRender,
      emptyRender: () => [],
      childFooterRender: (width) => renderChildFooter(
        validated.footerContainer,
        originalFooterRender,
        width,
      ),
      transcript,
      active: false,
    };
  }

  private swapToSubagentScreen(): boolean {
    if (!this.screenSwap) return false;
    return swapToChild(this.screenSwap);
  }

  private warnUnsupportedLayout(): void {
    if (this.layoutWarningShown) return;
    this.layoutWarningShown = true;
    this.uiCtx?.notify(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  }

  private clearScrollbackAndRender(): void {
    const tui = this.screenSwap?.tui ?? this.selectorTui ?? this.hostTui;
    if (!tui) return;
    try { tui.terminal.write(CLEAR_SCROLLBACK_SEQUENCE); } catch { /* best effort */ }
    tui.requestRender(true);
  }

  private requestRender(force = false): void {
    const tui = this.screenSwap?.tui ?? this.selectorTui ?? this.hostTui;
    tui?.requestRender(force);
  }

  private updateFooterStatus(): void {
    const ctx = this.uiCtx;
    if (!ctx) return;
    const projected = this.screen.execute({
      kind: "project",
      columns: this.selectorTui?.terminal.columns ?? 120,
      rows: this.selectorTui?.terminal.rows ?? 40,
      now: Date.now(),
    });
    const parts = projected.ok ? projected.snapshot.footerStatus : undefined;
    if (!parts) {
      if (this.footerStatus !== undefined) ctx.setStatus(STATUS_KEY, undefined);
      this.footerStatus = undefined;
      return;
    }
    const status = paintParts(parts, ctx.theme);
    if (status === this.footerStatus) return;
    this.footerStatus = status;
    ctx.setStatus(STATUS_KEY, status);
  }

  forceLayoutReflow(): void {
    this.lastRenderSig = "";
    this.requestRender(true);
  }

  private renderSelector(tui: TUI): string[] {
    this.syncRecords();
    const projected = this.screen.execute({
      kind: "project",
      columns: tui.terminal.columns,
      rows: tui.terminal.rows,
      now: Date.now(),
    });
    if (!projected.ok || !projected.snapshot.listExpanded || !projected.snapshot.visible) return [];
    const theme = this.uiCtx?.theme;
    if (!theme || !projected.snapshot.listLines) return [];
    return paintLines(projected.snapshot.listLines, theme);
  }

  private renderActiveTranscript(width: number): string[] {
    this.syncRecords();
    const projected = this.screen.execute({
      kind: "project",
      columns: width,
      rows: this.selectorTui?.terminal.rows ?? 40,
      now: Date.now(),
    });
    const theme = this.uiCtx?.theme;
    if (!projected.ok || !theme || !projected.snapshot.transcriptLines) return [];
    return paintLines(projected.snapshot.transcriptLines, theme);
  }

  update(): void {
    try {
      this.updateHost();
    } catch (error) {
      this.warnOnce("Agent navigator update failed", error);
    }
  }

  private updateHost(): void {
    if (!this.uiCtx) return;
    const records = this.manager.listSnapshots();
    const pending = this.pendingResultState();
    const wasSelected = this.snapshot()?.selectedAgentId ?? null;
    this.syncRecords();
    const selected = this.snapshot()?.selectedAgentId ?? null;
    if (records.length === 0 && !pending) {
      this.updateFooterStatus();
      if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
      this.lastRenderSig = "";
      this.lastAgentStatus.clear();
      this.requestRender();
      this.stopRefreshTimer();
      return;
    }
    if (wasSelected && !selected) {
      if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
    }
    this.updateFooterStatus();

    if (!this.selectorRegistered) {
      this.uiCtx.setWidget(SELECTOR_WIDGET_KEY, (tui) => {
        this.selectorTui = tui;
        this.hostTui = tui;
        this.enableShrinkClearing(tui);
        const selector: Component = {
          render: () => {
            try {
              this.captureScreen(tui, selector);
              return this.renderSelector(tui);
            } catch (error) {
              this.warnOnce("Agent navigator render failed", error);
              return [];
            }
          },
          invalidate: () => {},
        };
        return selector;
      }, { placement: "belowEditor" });
      this.selectorRegistered = true;
      this.lastRenderSig = "";
    }

    const sig = this.listRenderSignature(records);
    if (sig !== this.lastRenderSig) {
      this.lastRenderSig = sig;
      const completed = this.consumeTerminalTransitions(records);
      this.requestRender(completed);
    } else {
      this.consumeTerminalTransitions(records);
    }

    if (!selected && !records.some((record) =>
      record.status === "running" || record.status === "queued"
    )) {
      this.stopRefreshTimer();
    }
  }

  private stopRefreshTimer(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private warnOnce(context: string, error: unknown): void {
    this.stopRefreshTimer();
    if (this.errorWarningShown) return;
    this.errorWarningShown = true;
    try {
      this.uiCtx?.notify(`[pi-subagents-lite] ${context}: ${errorMessage(error)}`, "warning");
    } catch { /* Notification failures must not reopen the UI error boundary. */ }
  }

  private isTerminalStatus(status: AgentSnapshot["status"]): boolean {
    return status !== "running" && status !== "queued";
  }

  private consumeTerminalTransitions(records: AgentSnapshot[]): boolean {
    let terminalTransition = false;
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(record.id);
      const prev = this.lastAgentStatus.get(record.id);
      const next = record.status;
      if (prev !== undefined && prev !== next && this.isTerminalStatus(next)) {
        terminalTransition = true;
      }
      this.lastAgentStatus.set(record.id, next);
    }
    for (const id of [...this.lastAgentStatus.keys()]) {
      if (!seen.has(id)) this.lastAgentStatus.delete(id);
    }
    return terminalTransition;
  }

  private listRenderSignature(records: AgentSnapshot[]): string {
    const state = this.snapshot();
    const parts = records.map((record) => {
      const session = this.manager.inspectSession(record.id);
      const invocation = record.invocation;
      const usage = record.stats.lifetimeUsage;
      const contextPercent = session.found
        ? session.contextPercent ?? null
        : record.stats.contextPercent ?? null;
      const elapsedSec = Math.floor(
        ((record.completedAt ?? Date.now()) - record.startedAt) / 1000,
      );
      return [
        record.id,
        record.type,
        record.description,
        getConfig(record.type).displayName,
        record.status,
        record.completedAt ?? "",
        record.pinnedAt ?? "",
        record.settled ? "1" : "0",
        record.debugFaultKind ?? "",
        record.error ?? "",
        session.modelId ?? invocation?.modelName ?? "",
        session.provider ?? invocation?.providerName ?? "",
        session.thinkingLevel ?? invocation?.thinkingLevel ?? "",
        record.stats.toolUses,
        record.stats.turnCount,
        record.stats.maxTurns ?? "",
        elapsedSec,
        usage.input,
        usage.output,
        usage.cost,
        contextPercent ?? "",
        record.stats.compactionCount,
      ].join(":");
    });
    return [
      parts.join("|"),
      state?.selectedAgentId ?? "",
      state?.highlightedAgentId ?? "",
      state?.listFocused ? "1" : "0",
      state?.confirmingClearId ?? "",
      state?.interactionNotice ?? "",
      state?.listExpanded ? "1" : "0",
      this.pendingResultState() ? String(this.pendingResultState()) : "",
    ].join("#");
  }

  private enableShrinkClearing(tui: TUI): void {
    if (this.shrinkClearingTui === tui) return;
    this.restoreShrinkClearing();
    this.shrinkClearingTui = tui;
    this.previousClearOnShrink = tui.getClearOnShrink();
    tui.setClearOnShrink(true);
  }

  private restoreShrinkClearing(): void {
    if (this.shrinkClearingTui && this.previousClearOnShrink !== undefined) {
      this.shrinkClearingTui.setClearOnShrink(this.previousClearOnShrink);
    }
    this.shrinkClearingTui = undefined;
    this.previousClearOnShrink = undefined;
  }

  private unregisterWidgets(): void {
    if (this.selectorRegistered) {
      this.uiCtx?.setWidget(SELECTOR_WIDGET_KEY, undefined);
      this.selectorRegistered = false;
      this.selectorTui = undefined;
    }
  }

  dispose(): void {
    this.stopRefreshTimer();
    let firstError: unknown;
    const attempt = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        firstError ??= error;
      }
    };
    const tui = this.screenSwap?.tui ?? this.selectorTui ?? this.hostTui;
    attempt(() => { if (restoreMain(this.screenSwap)) this.requestRender(); });
    attempt(() => this.unregisterWidgets());
    attempt(() => this.uiCtx?.setStatus(STATUS_KEY, undefined));
    this.footerStatus = undefined;
    attempt(() => tui?.requestRender(true));
    attempt(() => this.restoreShrinkClearing());
    this.screenSwap = undefined;
    this.selectorRegistered = false;
    this.selectorTui = undefined;
    this.shrinkClearingTui = undefined;
    this.previousClearOnShrink = undefined;
    this.hostTui = undefined;
    attempt(() => this.restoreEditor?.());
    this.restoreEditor = undefined;
    this.navigationEditor = undefined;
    if (firstError !== undefined) this.warnOnce("Agent navigator disposal failed", firstError);
    this.uiCtx = undefined;
  }
}
