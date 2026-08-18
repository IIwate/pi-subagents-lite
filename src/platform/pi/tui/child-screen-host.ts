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
import { errorMessage } from "../../../utils.js";
import type {
  AgentListSnapshot,
  InteractionResult,
  SubagentRuntime,
} from "../../../modules/subagent-runtime/public.js";
import {
  createChildScreen,
  type ChildRecordSummary,
  type ChildScreen,
  type ChildStatus,
  type NavigatorKey,
  type NavigatorSnapshot,
  type StatsVisibility,
} from "../../../modules/child-screen/public.js";
import { ChildNavigationEditor } from "./editor.js";
import {
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

function isLocalNavKey(key: NavigatorKey): boolean {
  return key === "down" || key === "up" || key === "escape" || key === "space" || key === "ctrl-d";
}

export class ChildScreenHost {
  private uiCtx: NavigatorUICtx | undefined;
  private readonly screen: ChildScreen;
  private footerStatus: string | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastRecordsSig = "";
  private lastElapsedSig = "";
  private paintInvalidated = false;
  private cachedSelectedId: string | null = null;
  private shrinkClearingTui: TUI | undefined;
  private previousClearOnShrink: boolean | undefined;
  private lastAgentStatus = new Map<string, AgentListSnapshot["status"]>();
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
    // Injected rather than looked up: the display name belongs to the
    // activation's type registry, and a host that reached for a process-wide
    // one would label rows from another runtime's catalogue.
    private displayNameFor: (type: string) => string = (type) => type,
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

  /**
   * List rows only need identity and stats. Inspecting every live transcript
   * on the 1s refresh — then TypeBox-checking those messages — is how a
   * handful of background agents pinned the parent event loop. The selected
   * child still gets a real inspect for its screen. Revisit if the list
   * starts rendering message previews.
   */
  private presentationRecords(
    snapshots: AgentListSnapshot[],
    selectedId: string | null,
  ): ChildRecordSummary[] {
    return snapshots.map((record) => {
      const session = record.id === selectedId
        ? this.manager.inspectSession(record.id)
        : undefined;
      return {
        id: record.id,
        status: record.status,
        type: record.type,
        description: record.description ?? "",
        pinned: record.pinnedAt != null,
        displayName: this.displayNameFor(record.type),
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
        session: session
          ? {
            found: session.found,
            live: session.live,
            streaming: session.streaming,
            modelId: session.modelId,
            provider: session.provider,
            thinkingLevel: session.thinkingLevel,
            contextPercent: session.contextPercent,
            messages: session.messages,
            streamingMessage: session.streamingMessage,
          }
          : {
            found: record.liveSession,
            live: record.liveSession,
            streaming: false,
            modelId: record.invocation?.modelName,
            provider: record.invocation?.providerName,
            thinkingLevel: record.invocation?.thinkingLevel,
            contextPercent: record.stats.contextPercent,
            messages: [],
          },
      };
    });
  }

  private runScreen(command: unknown) {
    const result = this.screen.execute(command);
    if (result.ok) this.cachedSelectedId = result.snapshot.selectedAgentId;
    return result;
  }

  private syncRecords(highlightIndex?: number, snapshots?: AgentListSnapshot[]) {
    const records = snapshots ?? this.manager.listSnapshots();
    const pending = this.pendingResultState();
    return this.runScreen({
      kind: "replace-records",
      records: this.presentationRecords(records, this.cachedSelectedId),
      ...(pending != null ? { pendingResultCount: pending } : {}),
      ...(highlightIndex != null ? { highlightIndex } : {}),
    });
  }

  private snapshot() {
    const inspected = this.runScreen({ kind: "inspect" });
    return inspected.ok ? inspected.snapshot : undefined;
  }

  /** Refresh the selected stream without rebuilding records or stable history. */
  private refreshSelectedStream(agentId: string): void {
    this.runScreen({
      kind: "refresh-stream",
      agentId,
      stream: this.manager.inspectSessionStream(agentId),
    });
  }

  private invalidatePaint(): void {
    this.paintInvalidated = true;
    this.lastElapsedSig = "";
  }

  /** Schema-defined read-only navigator state (the module's inspect query). */
  inspectState(): NavigatorSnapshot | undefined {
    return this.snapshot();
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
    this.lastRecordsSig = "";
    this.invalidatePaint();

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
    this.runScreen({ kind: "toggle-fold" });
    this.invalidatePaint();
    this.update();
  }

  activateMain(): void {
    const current = this.snapshot();
    if (!current || current.selectedAgentId === null) return;
    if (!this.activate(null)) return;
    this.update();
    this.clearScrollbackAndRender();
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
    this.runScreen({ kind: "set-debug-preview", ...(status ? { status } : {}) });
    this.invalidatePaint();
    this.requestRender(true);
  }

  setStatsVisibility(visible: StatsVisibility): void {
    this.runScreen({ kind: "set-stats-visibility", visibility: visible });
    this.invalidatePaint();
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
    const key = toKey(data);
    if (!key) return undefined;
    // Local motion only changes chrome the screen already holds. Syncing
    // first re-clones every snapshot and TypeBox-checks the table for a
    // key that asked to move a highlight. The 1s tick owns freshness.
    // Space writes pinned from togglePinned's boolean rather than listing
    // again; a pin another writer flipped in the same tick stays hidden
    // until the next list. Revisit if Down must see a spawn that has not
    // been projected yet.
    if (isLocalNavKey(key)) return this.handleLocalNavKey(key);
    this.syncRecords();
    const previousSelected = this.cachedSelectedId;
    const result = this.runScreen({
      kind: "key",
      key,
      editorEmpty: this.uiCtx?.getEditorText() === "",
    });
    if (!result.ok) return undefined;
    if (result.notify) this.uiCtx?.notify(result.notify.message, result.notify.level);
    if (result.effect?.type === "clear") {
      const cleared = this.manager.clear(result.effect.agentId, "user");
      if (!cleared) this.uiCtx?.notify("Agent not found", "warning");
      else this.syncRecords(result.effect.index);
    }
    let screenChanged = false;
    const selected = result.snapshot.selectedAgentId;
    // Confirm-clear and re-Enter on the active row keep selectedId. Main's
    // activate() returns true then without a screen clear; matching that
    // avoids a 2J of the list for a no-op confirmation.
    if (key === "enter" && result.consume && selected !== previousSelected) {
      this.lastRecordsSig = "";
      if (!this.applySelection(selected)) {
        this.runScreen({ kind: "select", agentId: previousSelected });
        this.warnUnsupportedLayout();
      } else {
        if (selected && !this.refreshTimer) this.ensureTimer();
        screenChanged = true;
      }
    }
    if (result.consume || result.notify || result.effect) this.update();
    if (screenChanged) this.clearScrollbackAndRender();
    return result.consume ? { consume: true } : undefined;
  }

  private handleLocalNavKey(key: NavigatorKey): { consume?: boolean } | undefined {
    const result = this.runScreen({
      kind: "key",
      key,
      editorEmpty: this.uiCtx?.getEditorText() === "",
    });
    if (!result.ok || !result.consume) return undefined;
    if (result.notify) this.uiCtx?.notify(result.notify.message, result.notify.level);
    if (result.effect?.type === "toggle-pin") {
      this.applyPinFromToggle(result.effect.agentId, result.snapshot);
    }
    this.paintListFromCurrentRecords();
    return { consume: true };
  }

  private applyPinFromToggle(agentId: string, snapshot: NavigatorSnapshot): void {
    const pinned = this.manager.togglePinned(agentId);
    if (pinned == null) {
      this.uiCtx?.notify("Agent not found", "warning");
      return;
    }
    this.uiCtx?.notify(pinned ? "Subagent pinned" : "Subagent unpinned", "info");
    // togglePinned already returned the diamond. Listing again would
    // re-Check the table; inspecting would drag the selected transcript
    // along for a boolean. We stamp the rows the key just cloned.
    // pendingResultCount must be repeated or replace-records forgets it.
    this.runScreen({
      kind: "replace-records",
      records: snapshot.records.map((record) => (
        record.id === agentId ? { ...record, pinned } : record
      )),
      ...(snapshot.pendingResultCount != null
        ? { pendingResultCount: snapshot.pendingResultCount }
        : {}),
    });
  }

  beginInteraction(agentId: string): number {
    const begun = this.runScreen({ kind: "begin-interaction", agentId });
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
    this.runScreen({ kind: "set-interaction-notice", notice });
    this.invalidatePaint();
    this.update();
    return true;
  }

  clearInteractionNotice(): void {
    if (!this.snapshot()?.interactionNotice) return;
    this.runScreen({ kind: "set-interaction-notice" });
    this.invalidatePaint();
    this.update();
  }

  private activate(id: string | null): boolean {
    const current = this.snapshot()?.selectedAgentId ?? null;
    if (id === current) return true;
    this.syncRecords();
    const selected = this.runScreen({ kind: "select", agentId: id });
    this.lastRecordsSig = "";
    if (!selected.ok) return false;
    if (!this.applySelection(id)) {
      this.runScreen({ kind: "select", agentId: current });
      this.warnUnsupportedLayout();
      return false;
    }
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
    // Main writes CSI 3J here, then force-paints from live list pointers
    // on the next tick. That gap is empty air. Ours spends it on inspect
    // plus a TypeBox project of the selected transcript; 3J has already
    // taken the below-editor rows, and they stay gone until that work
    // finishes. Pi 0.84's force path emits 2J+3J after it has collected
    // every widget line, so the list dies and returns in the same buffer.
    // Revisit if a Pi version stops putting 3J in fullRender.
    tui.requestRender(true);
  }

  private requestRender(force = false): void {
    const tui = this.screenSwap?.tui ?? this.selectorTui ?? this.hostTui;
    tui?.requestRender(force);
  }

  private paintListFromCurrentRecords(): void {
    if (!this.selectorRegistered) {
      this.update();
      return;
    }
    this.invalidatePaint();
    this.requestRender();
  }

  private updateFooterStatus(): void {
    const ctx = this.uiCtx;
    if (!ctx) return;
    const projected = this.runScreen({
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
    this.invalidatePaint();
    this.requestRender(true);
  }

  private renderSelector(tui: TUI): string[] {
    const projected = this.runScreen({
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
    const projected = this.runScreen({
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
    // listSnapshots still walks the outbound gate. Everything after that
    // used to rebuild the screen to learn the cheap fields had not moved.
    // elapsedSec is a paint lie: the clock advances, the records do not.
    // The signature still covers listed fields only. Full transcript copies
    // remain expensive; the selected stream now travels by its narrower path.
    const records = this.manager.listSnapshots();
    const pending = this.pendingResultState();
    const recordsSig = this.listDataSignature(records, pending);
    const elapsedSig = this.listElapsedSignature(records);
    const empty = records.length === 0 && !pending;
    const recordsChanged = recordsSig !== this.lastRecordsSig;

    if (empty) {
      if (recordsChanged || this.paintInvalidated) {
        this.syncRecords(undefined, records);
        this.updateFooterStatus();
        if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
        this.lastAgentStatus.clear();
        this.requestRender();
      }
      this.lastRecordsSig = recordsSig;
      this.lastElapsedSig = elapsedSig;
      this.paintInvalidated = false;
      this.stopRefreshTimer();
      return;
    }

    if (recordsChanged) {
      const wasSelected = this.cachedSelectedId;
      this.syncRecords(undefined, records);
      if (wasSelected && !this.cachedSelectedId) {
        if (restoreMain(this.screenSwap)) this.clearScrollbackAndRender();
      }
    } else if (this.cachedSelectedId) {
      // A long answer can leave the list signature unchanged until message_end.
      // Read one selected stream here; Main and unselected sessions pay nothing.
      this.refreshSelectedStream(this.cachedSelectedId);
    }
    if (recordsChanged || this.paintInvalidated) {
      this.updateFooterStatus();
    }

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
      this.invalidatePaint();
    }

    const elapsedChanged = elapsedSig !== this.lastElapsedSig;
    if (recordsChanged || elapsedChanged || this.paintInvalidated) {
      this.lastRecordsSig = recordsSig;
      this.lastElapsedSig = elapsedSig;
      this.paintInvalidated = false;
      const completed = this.consumeTerminalTransitions(records);
      this.requestRender(completed);
    } else {
      this.consumeTerminalTransitions(records);
    }

    if (!this.cachedSelectedId && !records.some((record) =>
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

  private isTerminalStatus(status: AgentListSnapshot["status"]): boolean {
    return status !== "running" && status !== "queued";
  }

  private consumeTerminalTransitions(records: AgentListSnapshot[]): boolean {
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

  private listDataSignature(records: AgentListSnapshot[], pending: number | undefined): string {
    return JSON.stringify({
      records: records.map((record) => {
        const invocation = record.invocation;
        const usage = record.stats.lifetimeUsage;
        return {
          id: record.id,
          type: record.type,
          description: record.description,
          displayName: this.displayNameFor(record.type),
          status: record.status,
          completedAt: record.completedAt ?? null,
          pinnedAt: record.pinnedAt ?? null,
          settled: record.settled,
          debugFaultKind: record.debugFaultKind ?? null,
          error: record.error ?? null,
          modelName: invocation?.modelName ?? null,
          providerName: invocation?.providerName ?? null,
          thinkingLevel: invocation?.thinkingLevel ?? null,
          toolUses: record.stats.toolUses,
          turnCount: record.stats.turnCount ?? null,
          maxTurns: record.stats.maxTurns ?? null,
          input: usage.input,
          output: usage.output,
          cost: usage.cost,
          contextPercent: record.stats.contextPercent ?? null,
          compactionCount: record.stats.compactionCount,
        };
      }),
      pending: pending ?? null,
    });
  }

  private listElapsedSignature(records: AgentListSnapshot[]): string {
    return records.map((record) => Math.floor(
      ((record.completedAt ?? Date.now()) - record.startedAt) / 1000,
    )).join(",");
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
