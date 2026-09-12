import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DeliverySelectorComponent } from "./delivery-selector.js";
import type { StatsVisibility } from "./format.js";
import type { TaskInput } from "../engine/contracts.js";
import { PiScreen, type NavigatorUICtx } from "./pi-screen.js";
import { NavigatorView, renderPending, renderRetry } from "./navigator-view.js";
import { TranscriptView } from "./transcript.js";
import type { NavigationAction, NavigationAgent, NavigationReply, NavigationSource, NavigationStatus, NavigatorViewState } from "./navigation.js";

// Note: see .agents/notes/implemented/architecture/2026-09-10-navigator-screen-and-input-ownership.md
export class AgentNavigator {
  private readonly screen: PiScreen;
  private readonly view = new NavigatorView();
  private readonly transcript = new TranscriptView();
  private stopTranscript?: () => void;
  private selectedAgentId: string | null = null;
  private highlightedAgentId: string | null = null;
  private confirmingClearId: string | null = null;
  private interactionNotice?: string;
  private interactionRequestId = 0;
  private statsVisibility: StatsVisibility = {};
  private listExpanded: boolean;
  private listFocused = false;
  private footerStatus?: string;
  private isDeliverySelectorOpen = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastRenderSig = "";
  private readonly lastAgentStatus = new Map<string, NavigationStatus>();
  private readonly withdrawn = new Map<string, readonly TaskInput[]>();
  private errorWarningShown = false;
  private disposed = false;
  private readonly stopSource: () => void;

  constructor(
    private readonly source: NavigationSource,
    private readonly dispatch: (action: NavigationAction) => NavigationReply | Promise<NavigationReply> = action => source.dispatch(action),
    private readonly getPendingResultCount?: () => number | undefined,
    private readonly getParentModelInfo?: () => { providerName?: string; modelName?: string; thinkingLevel?: string } | undefined,
    initialListExpanded = true,
  ) {
    this.listExpanded = initialListExpanded;
    this.screen = new PiScreen(this, {
      transcript: width => {
        const record = this.selectedAgentId ? this.source.getRecord(this.selectedAgentId) : undefined;
        const theme = this.uiCtx?.theme;
        return record && theme ? this.transcript.render(record, this.source.transcript(record.id), theme, width, this.screen.active) : [];
      },
      pending: width => this.uiCtx ? renderPending(this.selectedAgentId ? this.source.getRecord(this.selectedAgentId) : undefined, width, this.uiCtx.theme) : [],
      status: width => this.uiCtx ? renderRetry(this.selectedAgentId ? this.source.getRecord(this.selectedAgentId) : undefined, width, this.uiCtx.theme, Date.now()) : [],
      invalidate: () => this.transcript.invalidate(),
    });
    this.stopSource = source.subscribe(() => this.ensureTimer());
  }

  private get uiCtx(): NavigatorUICtx | undefined { return this.screen.ui; }
  private pendingResultState(): number | undefined { const count = this.getPendingResultCount?.(); return count && count > 0 ? count : undefined; }

  setUICtx(ctx: NavigatorUICtx): void {
    if (ctx === this.uiCtx) return;
    this.stopTranscript?.(); this.stopTranscript = undefined;
    this.selectedAgentId = null; this.highlightedAgentId = null; this.listFocused = false;
    this.interactionRequestId++;
    this.screen.setContext(ctx);
    this.footerStatus = undefined;
    this.errorWarningShown = false;
    this.ensureTimer();
  }

  toggleList(): void {
    if (!this.source.listAgents().length && !this.pendingResultState()) return;
    this.listExpanded = !this.listExpanded;
    if (!this.listExpanded) { this.listFocused = false; this.confirmingClearId = null; this.highlightedAgentId = this.selectedAgentId; }
    this.lastRenderSig = ""; this.update();
  }

  activateMain(): void { if (this.activate(null)) this.update(); }
  selectedId(): string | null {
    if (this.selectedAgentId && !this.source.getRecord(this.selectedAgentId)) this.activate(null);
    return this.selectedAgentId;
  }
  highlightedId(): string | null { return this.highlightedAgentId; }
  isListFocused(): boolean { return this.listFocused; }

  abortActiveRetry(): boolean {
    const record = this.selectedAgentId ? this.source.getRecord(this.selectedAgentId) : undefined;
    if (!record?.execution.retryState) return false;
    this.send({ type: "abortRetry", taskId: record.id, operationId: record.operationId });
    return true;
  }
  abortActiveSubagent(): boolean {
    const record = this.selectedAgentId ? this.source.getRecord(this.selectedAgentId) : undefined;
    if (!record || record.execution.settled) return false;
    this.send({ type: "abort", taskId: record.id, operationId: record.operationId });
    return true;
  }
  takeOverActive(): boolean {
    const id = this.listFocused ? this.highlightedAgentId : this.selectedId();
    const record = id ? this.source.getRecord(id) : undefined;
    if (!record) return false;
    this.send({ type: "takeover", taskId: record.id, operationId: record.operationId });
    return true;
  }

  setStatsVisibility(visible: StatsVisibility): void { this.statsVisibility = { ...visible }; this.lastRenderSig = ""; this.screen.requestRender(); }
  ensureTimer(): void {
    if (!this.uiCtx || this.disposed) return;
    this.refreshTimer ??= setInterval(() => this.update(), 1000);
    this.update();
  }

  handleEditorSubmit(text: string, kind: "steer" | "followUp" = "steer", images?: TaskInput["images"]): boolean {
    const id = this.selectedId();
    const trimmed = text.trim();
    if (!id || !trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
    const record = this.source.getRecord(id);
    if (!record) return false;
    const requestId = this.beginInteraction(id);
    const type = record.execution.settled ? "continue" : kind;
    this.send({ type, taskId: id, operationId: record.operationId, input: { text: trimmed, ...(images ? { images } : {}) } },
      result => queueMicrotask(() => this.completeInteraction(requestId, id, text, result)));
    return true;
  }

  handleEditorDequeue(): boolean {
    const id = this.selectedId();
    if (!id) return false;
    const withdrawn = this.withdrawn.get(id);
    if (withdrawn) { this.withdrawn.delete(id); this.restoreInputs(withdrawn); return true; }
    const record = this.source.getRecord(id);
    if (!record?.queued.length) { this.uiCtx?.notify("No queued messages to restore", "info"); return true; }
    if (record.queued.some(item => item.input.images?.length)) {
      this.uiCtx?.notify("Queued images are retained because this editor cannot restore image attachments", "info");
      return true;
    }
    const requestId = this.beginInteraction(id);
    this.send({ type: "dequeue", taskId: id, operationId: record.operationId, entryIds: record.queued.map(item => item.entryId) }, reply => {
      if (!this.currentRequest(requestId, id) || this.source.getRecord(id)?.operationId !== record.operationId) {
        if (reply.accepted && reply.restored?.length) this.withdrawn.set(id, [...(this.withdrawn.get(id) ?? []), ...reply.restored]);
        return;
      }
      if (!reply.accepted) {
        this.interactionNotice = reply.reason === "already_consumed" ? "Queued input was already consumed" : reply.message ?? "Queued input could not be restored";
      } else if (reply.restored?.length) {
        this.restoreInputs(reply.restored);
      }
      this.lastRenderSig = ""; this.update();
    });
    return true;
  }

  private restoreInputs(inputs: readonly TaskInput[]): void {
    const text = inputs.map(input => input.text).join("\n\n");
    const draft = this.uiCtx?.getEditorText() ?? "";
    this.uiCtx?.setEditorText([text, draft].filter(part => part.trim()).join("\n\n"));
    this.uiCtx?.notify(`Restored ${inputs.length} queued message${inputs.length === 1 ? "" : "s"} to editor`, "info");
    this.interactionNotice = undefined; this.update();
  }

  handleTerminalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, Key.alt("t")) && this.takeOverActive()) return { consume: true };
    if (matchesKey(data, Key.alt("up")) && this.handleEditorDequeue()) return { consume: true };
    if (!this.listExpanded) return undefined;
    const entries = this.navigationEntries();
    if (entries.length <= 1) return undefined;

    if (!this.listFocused) {
      if (matchesKey(data, Key.down) && this.uiCtx?.getEditorText() === "") {
        this.listFocused = true;
        this.confirmingClearId = null;
        this.highlightedAgentId = this.selectedAgentId;
        // Route keyboard changes through update() so lastListPaintHeight tracks every state.
        // This lets shrinking lists force a redraw that clears stale rows; update() already
        // throttles identical signatures.
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Confirming clear: only Enter / Esc, ignore everything else (resume-style).
    if (this.confirmingClearId !== null) {
      if (matchesKey(data, Key.enter)) {
        this.confirmClear();
        return { consume: true };
      }
      if (matchesKey(data, Key.escape)) {
        this.confirmingClearId = null;
        this.update();
        return { consume: true };
      }
      // Do not consume Ctrl+C: cancel confirmation and pass it upward to preserve interrupt/exit handling.
      if (matchesKey(data, Key.ctrl("c"))) {
        this.confirmingClearId = null;
        this.update();
        return undefined;
      }
      return { consume: true };
    }

    if (matchesKey(data, Key.escape)) {
      if (this.selectedAgentId && this.abortActiveRetry()) {
        this.update();
        return { consume: true };
      }
      if (this.selectedAgentId && this.abortActiveSubagent()) {
        this.update();
        return { consume: true };
      }
      this.listFocused = false;
      this.highlightedAgentId = this.selectedAgentId;
      this.update();
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrl("d"))) {
      this.beginClearConfirmation();
      return { consume: true };
    }

    if (data === "\x1bs" || matchesKey(data, Key.alt("s"))) {
      const highlighted = entries.find(e => e.id === this.highlightedAgentId)?.record;
      if (this.canDeliverRecord(highlighted)) {
        void this.openDeliverySelector();
        return { consume: true };
      }
    }

    if (data === " ") {
      this.toggleHighlightedPin();
      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      const candidate = this.highlightedAgentId;
      const hasText = Boolean(this.uiCtx?.getEditorText()?.trim());

      if (candidate === this.selectedAgentId && hasText) {
        this.listFocused = false;
        this.highlightedAgentId = this.selectedAgentId;
        this.update();
        return undefined;
      }

      if (candidate !== this.selectedAgentId) {
        if (!this.activate(candidate)) {
          this.highlightedAgentId = this.selectedAgentId;
        } else if (hasText) {
          this.listFocused = false;
        }
      }
      this.update();
      return { consume: true };
    }

    const highlightedIndex = Math.max(
      0,
      entries.findIndex(entry => entry.id === this.highlightedAgentId),
    );

    if (matchesKey(data, Key.up)) {
      if (highlightedIndex === 0) {
        this.listFocused = false;
        this.highlightedAgentId = this.selectedAgentId;
      } else {
        this.highlightedAgentId = entries[highlightedIndex - 1]?.id ?? null;
      }
      this.update();
      return { consume: true };
    }

    if (matchesKey(data, Key.down)) {
      if (highlightedIndex < entries.length - 1) {
        this.highlightedAgentId = entries[highlightedIndex + 1]?.id ?? null;
      }
      this.update();
      return { consume: true };
    }

    if (
      (data.length === 1 && data.charCodeAt(0) >= 32)
      || (data.length > 1 && !data.startsWith("\x1b"))
      || data.includes("\x1b[200~")
    ) {
      this.listFocused = false;
      this.highlightedAgentId = this.selectedAgentId;
      this.update();
    }
    return undefined;
  }

  beginInteraction(agentId: string): number { return agentId === this.selectedAgentId ? ++this.interactionRequestId : -1; }
  private currentRequest(requestId: number, agentId: string): boolean {
    return !this.disposed && requestId === this.interactionRequestId && agentId === this.selectedAgentId;
  }
  completeInteraction(requestId: number, agentId: string, text: string, result: NavigationReply): boolean {
    if (!this.currentRequest(requestId, agentId)) return false;
    if (result.accepted) this.interactionNotice = result.message;
    else {
      if (this.uiCtx?.getEditorText() === "") this.uiCtx.setEditorText(text);
      this.interactionNotice = result.message ?? (result.reason === "concurrency" && result.modelKey
        ? `Blocked: ${result.modelKey} concurrency limit reached`
        : result.reason === "queued" ? "Blocked: selected subagent is queued" : "Blocked: selected subagent is unavailable");
    }
    this.lastRenderSig = ""; this.update(); return true;
  }
  clearInteractionNotice(): void { this.interactionNotice = undefined; this.lastRenderSig = ""; this.update(); }

  private send(action: NavigationAction, complete?: (reply: NavigationReply) => void): void {
    const received = (reply: NavigationReply) => {
      if (this.disposed) return;
      if (action.type !== "deliver" && action.type !== "remove" && action.type !== "dequeue") {
        const operationId = this.source.getRecord(action.taskId)?.operationId;
        if (operationId !== action.operationId && (!reply.accepted || operationId !== reply.operationId)) return;
      }
      if (complete) complete(reply);
      else { if (!reply.accepted) this.interactionNotice = reply.message ?? "Selected subagent is unavailable"; this.update(); }
    };
    try {
      const reply = this.dispatch(action);
      if (reply instanceof Promise) void reply.then(received, error => received({ accepted: false, reason: "unavailable", message: String(error) }));
      else received(reply);
    } catch (error) { received({ accepted: false, reason: "unavailable", message: String(error) }); }
  }

  private toggleHighlightedPin(): void {
    const record = this.highlightedAgentId ? this.source.getRecord(this.highlightedAgentId) : undefined;
    if (!record) { this.uiCtx?.notify(this.highlightedAgentId ? "Agent not found" : "Cannot pin Main agent", "warning"); return; }
    this.send({ type: "pin", taskId: record.id, operationId: record.operationId }, reply => {
      this.uiCtx?.notify(reply.accepted ? reply.pinned ? "Subagent pinned" : "Subagent unpinned" : "Agent not found", reply.accepted ? "info" : "warning");
      this.update();
    });
  }
  private beginClearConfirmation(): void {
    const id = this.highlightedAgentId;
    if (!id) { this.uiCtx?.notify("Cannot clear Main agent", "warning"); return; }
    if (id === this.selectedAgentId) { this.uiCtx?.notify("Cannot clear the active subagent — switch to Main first", "warning"); return; }
    if (!this.source.getRecord(id)) { this.uiCtx?.notify("Agent not found", "warning"); return; }
    this.confirmingClearId = id; this.update();
  }
  private confirmClear(): void {
    const id = this.confirmingClearId;
    this.confirmingClearId = null;
    const record = id ? this.source.getRecord(id) : undefined;
    if (!record || id === this.selectedAgentId) { this.update(); return; }
    const index = this.navigationEntries().findIndex(entry => entry.id === id);
    this.send({ type: "remove", taskId: record.id, operationId: record.operationId }, reply => {
      if (!reply.accepted) this.uiCtx?.notify("Agent not found", "warning");
      const entries = this.navigationEntries();
      if (entries.length <= 1) { this.listFocused = false; this.highlightedAgentId = null; }
      else this.highlightedAgentId = entries[Math.min(Math.max(index, 0), entries.length - 1)]?.id ?? null;
      this.update();
    });
  }
  private navigationEntries(): Array<{ id: string | null; record?: NavigationAgent }> {
    return [{ id: null }, ...this.source.listAgents().map(record => ({ id: record.id, record }))];
  }
  private activate(id: string | null): boolean {
    if (id === this.selectedAgentId) return true;
    if (id && (!this.source.getRecord(id) || !this.screen.showChild())) return false;
    this.stopTranscript?.(); this.stopTranscript = undefined;
    this.selectedAgentId = id;
    if (!id) this.screen.showMain();
    else this.stopTranscript = this.source.watchTranscript(id, () => { if (!this.disposed) { this.screen.requestRender(); this.update(); } });
    this.transcript.invalidate();
    this.interactionRequestId++; this.interactionNotice = id && this.withdrawn.has(id) ? "Withdrawn input is ready. Alt+Up restores it." : undefined; this.highlightedAgentId = id;
    this.screen.clearAndRender();
    if (id) this.ensureTimer();
    return true;
  }
  forceLayoutReflow(): void { this.lastRenderSig = ""; this.screen.requestRender(true); }
  canDeliverRecord(record: NavigationAgent | undefined): boolean { return record?.canDeliver ?? false; }

  async openDeliverySelector(customUICtx?: ExtensionUIContext): Promise<void> {
    const record = this.highlightedAgentId ? this.source.getRecord(this.highlightedAgentId) : undefined;
    const ui = customUICtx ?? this.uiCtx;
    if (this.isDeliverySelectorOpen || !record?.canDeliver || !ui?.custom) return;
    const messages = this.source.transcript(record.id).messages.filter(message => (message.role === "user" || message.role === "assistant") && message.text.trim());
    if (!messages.length) return;
    const selection = Object.freeze({ taskId: record.id, operationId: record.operationId, messages: Object.freeze([...messages]), createdAt: Date.now(),
      status: record.lifecycle.status === "error" || record.lifecycle.status === "aborted" || record.lifecycle.status === "stopped" || record.lifecycle.status === "turn_limited"
        ? record.lifecycle.status : "completed" as const });
    const generation = this.interactionRequestId;
    this.isDeliverySelectorOpen = true;
    try {
      await ui.custom<boolean>((tui, theme, _kb, done) => {
        let deliveryId: string | undefined;
        let saving = false;
        const selector = new DeliverySelectorComponent({ record, messages: messages.map(message => ({ role: message.role as "user" | "assistant", content: message.text })), theme, tui,
          onConfirm: selected => {
            if (saving || this.disposed) return;
            saving = true;
            this.send({ type: "deliver", selection: { ...selection, messages: selected.map(index => selection.messages[index]) }, deliveryId }, reply => {
              saving = false;
              if (reply.accepted) done(true);
              else {
                deliveryId = reply.deliveryId ?? deliveryId;
                selector.setNotice(reply.reason === "save_failed" ? "Save failed. Selection retained for retry." : reply.message ?? "Agent or parent session is unavailable.", Boolean(deliveryId));
              }
            });
          }, onCancel: () => done(false),
        });
        return selector;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } });
    } finally {
      this.isDeliverySelectorOpen = false;
      if (!this.disposed && generation === this.interactionRequestId && ui === this.uiCtx) { this.listFocused = true; this.update(); }
    }
  }

  private state(): NavigatorViewState {
    return { records: this.source.listAgents(), selectedId: this.selectedAgentId, highlightedId: this.highlightedAgentId,
      confirmingClearId: this.confirmingClearId, listFocused: this.listFocused, listExpanded: this.listExpanded,
      notice: this.interactionNotice, pending: this.pendingResultState(), parentModel: this.getParentModelInfo?.(),
      statsVisibility: this.statsVisibility, theme: this.uiCtx!.theme, now: Date.now() };
  }

  // Note: see .agents/notes/implemented/bug-fix/2026-09-10-navigator-rendering-and-cache.md
  update(): void {
    if (!this.uiCtx || this.disposed) return;
    try {
      const records = this.source.listAgents();
      if (this.selectedAgentId && !records.some(record => record.id === this.selectedAgentId)) this.activate(null);
      if (this.highlightedAgentId && !records.some(record => record.id === this.highlightedAgentId)) this.highlightedAgentId = this.selectedAgentId;
      if (this.confirmingClearId && !records.some(record => record.id === this.confirmingClearId)) this.confirmingClearId = null;
      if (!records.length && !this.pendingResultState()) { this.listFocused = false; this.interactionNotice = undefined; }
      const state = this.state();
      const footer = this.view.collapsed(state);
      if (footer !== this.footerStatus) { this.screen.setStatus(footer); this.footerStatus = footer; }
      if (records.length || state.pending) this.screen.mount((tui, theme) => this.view.render({ ...this.state(), theme }, tui.terminal.columns, tui.terminal.rows), error => this.warn(error));
      const tui = this.screen.tui;
      const signature = [...this.view.render(state, tui?.terminal.columns ?? 120, tui?.terminal.rows ?? 40), footer ?? ""].join("\n");
      const completed = records.some(record => this.lastAgentStatus.has(record.id) && this.lastAgentStatus.get(record.id) !== record.lifecycle.status && record.execution.settled);
      this.lastAgentStatus.clear(); for (const record of records) this.lastAgentStatus.set(record.id, record.lifecycle.status);
      if (signature !== this.lastRenderSig) { this.lastRenderSig = signature; this.screen.requestRender(completed); }
      if (!this.selectedAgentId && !records.some(record => !record.execution.settled)) this.stopTimer();
    } catch (error) { this.warn(error); }
  }
  private warn(error: unknown): void {
    this.stopTimer();
    if (this.errorWarningShown) return;
    this.errorWarningShown = true;
    try { this.uiCtx?.notify(`[pi-subagents-lite] Agent navigator update failed: ${String(error)}`, "warning"); }
    catch { /* A broken host UI must not restart the failed refresh loop. */ }
  }
  private stopTimer(): void { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.interactionRequestId++; this.stopTimer();
    const ui = this.uiCtx;
    const failures: unknown[] = [];
    for (const release of [this.stopSource, this.stopTranscript, () => this.screen.dispose(), () => this.source.dispose(), () => this.transcript.invalidate()]) {
      try { release?.(); } catch (error) { failures.push(error); }
    }
    this.stopTranscript = undefined;
    this.withdrawn.clear();
    if (failures.length) {
      try { ui?.notify(`Agent navigator disposal failed: ${String(failures[0])}`, "warning"); }
      catch { /* A failed UI notification cannot retain disposed execution subscriptions. */ }
    }
  }
}
