/**
 * agent-navigator.ts — Keyboard-driven main/subagent view switching.
 *
 * The selector is rendered below the editor. Selecting a subagent replaces
 * Pi's root chat/pending/status components with the child transcript while
 * preserving the editor, agent widgets, and footer. The original components
 * remain alive off-screen and are restored when Main agent is selected.
 */

import {
  CustomEditor,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteProvider,
  type Component,
  type EditorComponent,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentManager, InteractionResult } from "../agents/agent-manager.js";
import type { AgentRecord } from "../types.js";
import { extractDeliverableMessages } from "../prompt/subagent-delivery.js";
import { getCoordinator, getSessionCtx } from "../shell.js";
import { DeliverySelectorComponent } from "./delivery-selector.js";
import {
  buildStatsParts,
  displayText,
  formatModelIdentity,
  getDisplayName,
  STATS_SEP,
  summarizeToolArgs,
  type StatsVisibility,
} from "./format.js";
import { errorMessage } from "../utils.js";
import type { Theme } from "./types.js";

const SELECTOR_WIDGET_KEY = "agent-navigator-selector";
const STATUS_KEY = "subagents-lite";
const REFRESH_INTERVAL_MS = 1000;
const TOOL_RESULT_CHAR_LIMIT = 4000;
const PI_ROOT_CHILDREN = 7;
const PI_DOCUMENT_CHILDREN = 3;
const CLEAR_SCROLLBACK_SEQUENCE = "\x1b[3J";
const STATUS_COLUMN_GAP = 2;
const MIN_LEFT_COLUMN_WIDTH = 18;
const MIN_STATS_COLUMN_WIDTH = 12;
const DESIRED_DESCRIPTION_WIDTH = 40;

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

type NavigationEntry = { id: string | null; record?: AgentRecord };

function pendingLabel(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"} pending`;
}

/** UI-only preview values exposed through /agents → Debug. */
export type DebugStatusPreview = AgentRecord["lifecycle"]["status"];

type MessageLike = {
  role: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  summary?: string;
};

interface ScreenSwapState {
  tui: TUI;
  documentChildren: Component[];
  chatIndex: number;
  originalChat: Component;
  pendingContainer: Component;
  statusContainer: Component;
  footerContainer: Component & { children: Component[] };
  originalPendingRender: Component["render"];
  originalStatusRender: Component["render"];
  originalFooterRender: Component["render"];
  emptyRender: Component["render"];
  childFooterRender: Component["render"];
  transcript: Component;
  active: boolean;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return displayText(content);
  if (!Array.isArray(content)) return "";
  return displayText(content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object"
      && item !== null
      && (item as { type?: string }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    )
    .map(item => item.text)
    .join(""));
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(item =>
    typeof item === "object"
    && item !== null
    && (item as { type?: string }).type === "image"
  ).length;
}

function appendWrapped(lines: string[], text: string, width: number): void {
  const wrapWidth = Math.max(1, width - 2);
  const sourceLines = text.split("\n");
  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(sourceLine, wrapWidth);
    lines.push(...wrapped.map(line => `  ${line}`));
  }
}

function renderAgentRow(
  leftPrefix: string,
  description: string,
  stats: string,
  width: number,
  prefixWidth: number,
  theme: Theme,
): string {
  const statsWidth = Math.max(0, width - Math.max(MIN_LEFT_COLUMN_WIDTH, prefixWidth) - STATUS_COLUMN_GAP);
  const statsText = statsWidth > 0 ? truncateToWidth(stats, statsWidth, "…") : "";
  const leftWidth = statsText
    ? Math.max(0, width - visibleWidth(statsText) - STATUS_COLUMN_GAP)
    : width;
  if (leftWidth < prefixWidth) return truncateToWidth(leftPrefix, leftWidth, "…");

  const descriptionWidth = Math.max(0, leftWidth - prefixWidth - STATUS_COLUMN_GAP);
  const renderedDescription = descriptionWidth > 0 && description
    ? `  ${theme.fg("dim", truncateToWidth(description, descriptionWidth, "…"))}`
    : "";
  const leftText = `${leftPrefix}${renderedDescription}`;
  if (!statsText) return leftText;
  const padding = Math.max(0, width - visibleWidth(leftText) - visibleWidth(statsText));
  return `${leftText}${" ".repeat(padding)}${statsText}`;
}

function applySelectedBackground(line: string, width: number, theme: Theme): string {
  if (!theme.bg) return line;
  const padding = Math.max(0, width - visibleWidth(line));
  const paddedLine = `${line}${" ".repeat(padding)}`;
  const sample = theme.bg("selectedBg", "");
  const bgMatch = sample.match(/^\x1b\[[0-9;]*m/);
  if (!bgMatch) return theme.bg("selectedBg", paddedLine);
  const bgCode = bgMatch[0];
  const restored = paddedLine.replace(/\x1b\[0?m/g, (match) => `${match}${bgCode}`);
  return theme.bg("selectedBg", restored);
}

function agentStatusValue(record: AgentRecord, preview?: DebugStatusPreview): DebugStatusPreview {
  return preview ?? record.lifecycle.status;
}

function agentStatusLabel(status: DebugStatusPreview): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Done";
    case "turn_limited": return "Turn limit";
    case "aborted": return "Aborted";
    case "stopped": return "Stopped";
    case "error": return "Error";
  }
}

function plainAgentStatus(record: AgentRecord, preview?: DebugStatusPreview): string {
  return agentStatusLabel(agentStatusValue(record, preview));
}

function renderAgentStatus(
  record: AgentRecord,
  theme: Theme,
  preview?: DebugStatusPreview,
): string {
  const statusValue = agentStatusValue(record, preview);
  const color = statusValue === "turn_limited" || statusValue === "aborted"
    ? "warning"
    : statusValue === "running"
      ? "accent"
      : statusValue === "completed"
        ? "success"
        : statusValue === "error"
          ? "error"
          : "dim";
  return theme.fg(color, agentStatusLabel(statusValue));
}

function renderDebugBadge(record: AgentRecord, theme: Theme): string {
  return record.execution.debugFaultKind
    ? theme.bold(theme.fg("accent", "[DEBUG]"))
    : "";
}

function isComponent(value: unknown): value is Component {
  return typeof value === "object"
    && value !== null
    && typeof (value as Component).render === "function"
    && typeof (value as Component).invalidate === "function";
}

function isContainerLike(value: unknown): value is Component & { children: Component[] } {
  return isComponent(value)
    && Array.isArray((value as { children?: unknown }).children);
}

function isBuiltinFooter(value: Component): boolean {
  const footer = value as Component & {
    session?: { getContextUsage?: unknown; sessionManager?: { getCwd?: unknown; getEntries?: unknown } };
    footerData?: { getGitBranch?: unknown; getExtensionStatuses?: unknown };
    setSession?: unknown;
    setAutoCompactEnabled?: unknown;
  };
  return typeof footer.setSession === "function"
    && typeof footer.setAutoCompactEnabled === "function"
    && typeof footer.session?.getContextUsage === "function"
    && typeof footer.session?.sessionManager?.getCwd === "function"
    && typeof footer.session?.sessionManager?.getEntries === "function"
    && typeof footer.footerData?.getGitBranch === "function"
    && typeof footer.footerData?.getExtensionStatuses === "function";
}

function containsComponent(root: Component & { children: Component[] }, target: Component): boolean {
  for (const child of root.children) {
    if (child === target) return true;
    if (isContainerLike(child) && containsComponent(child, target)) return true;
  }
  return false;
}

/** Visible list window, capped near six rows and scrolled around the focused row. */
function computeListWindow(
  entryCount: number,
  focusIndex: number,
  rows: number,
): { start: number; end: number; visibleCount: number } {
  const maxVisible = Math.min(6, Math.max(3, Math.floor(rows / 5)));
  const visibleCount = Math.min(entryCount, maxVisible);
  const maxStart = Math.max(0, entryCount - visibleCount);
  const start = Math.min(maxStart, Math.max(0, focusIndex - Math.floor(visibleCount / 2)));
  return { start, end: start + visibleCount, visibleCount };
}

class ForwardingActionMap extends Map<string, () => void> {
  constructor(
    private base: Map<string, () => void>,
    private wrapFollowUp: (handler: () => void) => () => void,
  ) {
    super();
  }

  override set(action: string, handler: () => void): this {
    this.base.set(
      action,
      action === "app.message.followUp" ? this.wrapFollowUp(handler) : handler,
    );
    return this;
  }
}

/** Editor decorator that receives navigation keys only while the editor is focused. */
class AgentNavigationEditor implements EditorComponent, Focusable {
  private parentOnSubmit: ((text: string) => void) | undefined;
  private parentOnEscape: (() => void) | undefined;
  private forwardedActions: ForwardingActionMap | undefined;

  constructor(
    private base: EditorComponent,
    private navigator: AgentNavigator,
  ) {}

  get focused(): boolean {
    return (this.base as Partial<Focusable>).focused ?? false;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.base.wantsKeyRelease;
  }

  set focused(value: boolean) {
    if ("focused" in this.base) {
      (this.base as EditorComponent & Focusable).focused = value;
    }
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.parentOnSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.parentOnSubmit = handler;
    this.base.onSubmit = (text) => {
      if (this.navigator.handleEditorSubmit(text)) {
        this.base.addToHistory?.(text);
        return;
      }
      handler?.(text);
    };
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.base.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.base.onChange = handler;
  }

  get borderColor(): ((text: string) => string) | undefined {
    return this.base.borderColor;
  }

  set borderColor(color: ((text: string) => string) | undefined) {
    this.base.borderColor = color;
  }

  get actionHandlers(): Map<string, () => void> | undefined {
    const baseActions = (this.base as unknown as { actionHandlers?: Map<string, () => void> }).actionHandlers;
    if (!baseActions) return undefined;
    this.forwardedActions ??= new ForwardingActionMap(
      baseActions,
      (parentHandler) => () => {
        const text = this.base.getExpandedText?.() ?? this.base.getText();
        if (this.navigator.handleEditorSubmit(text)) {
          this.base.addToHistory?.(text.trim());
          this.base.setText("");
          return;
        }
        parentHandler();
      },
    );
    return this.forwardedActions;
  }

  get onEscape(): (() => void) | undefined {
    return this.parentOnEscape;
  }

  set onEscape(handler: (() => void) | undefined) {
    this.parentOnEscape = handler;
    (this.base as unknown as { onEscape?: () => void }).onEscape = () => {
      if (this.navigator.abortActiveSubagent()) {
        return;
      }
      handler?.();
    };
  }

  get onCtrlD(): (() => void) | undefined {
    return (this.base as unknown as { onCtrlD?: () => void }).onCtrlD;
  }

  set onCtrlD(handler: (() => void) | undefined) {
    (this.base as unknown as { onCtrlD?: () => void }).onCtrlD = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return (this.base as unknown as { onPasteImage?: () => void }).onPasteImage;
  }

  set onPasteImage(handler: (() => void) | undefined) {
    (this.base as unknown as { onPasteImage?: () => void }).onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => void) | undefined {
    return (this.base as unknown as { onExtensionShortcut?: (data: string) => void }).onExtensionShortcut;
  }

  set onExtensionShortcut(handler: ((data: string) => void) | undefined) {
    (this.base as unknown as { onExtensionShortcut?: (data: string) => void }).onExtensionShortcut = handler;
  }

  render(width: number): string[] {
    const lines = this.base.render(width);
    return this.navigator.isListFocused()
      ? lines.map(line => line.replaceAll(CURSOR_MARKER, ""))
      : lines;
  }

  handleInput(data: string): void {
    const result = this.navigator.handleTerminalInput(data);
    if (!result?.consume) this.base.handleInput(data);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }
}

export class AgentNavigator {
  private uiCtx: NavigatorUICtx | undefined;
  /** Agent whose transcript and input routing are active. Null means parent. */
  private selectedAgentId: string | null = null;
  /** Candidate row moved by Up/Down while the selector has focus. */
  private highlightedAgentId: string | null = null;
  /** Agent id waiting for Ctrl+D → Enter clear confirmation. */
  private confirmingClearId: string | null = null;
  /** Local interaction failure rendered on the sticky Main row instead of Main's notification area. */
  private interactionNotice: string | undefined;
  /** Monotonic request id preventing stale async interaction results from mutating current UI. */
  private interactionRequestId = 0;
  /** Stats visibility, including showCost, injected and synchronized by ConfigStore. */
  private statsVisibility: StatsVisibility = {};
  /** Debug-only display override; never changes agent lifecycle or session state. */
  private debugStatusPreview: DebugStatusPreview | undefined;
  /** User-controlled list visibility for this extension runtime. */
  private listExpanded: boolean;
  private listFocused = false;
  private footerStatus: string | undefined;
  private isDeliverySelectorOpen = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Skip requestRender when list content is unchanged between timer ticks. */
  private lastRenderSig = "";
  /** TUI whose native shrink clearing was enabled for the dynamic selector. */
  private shrinkClearingTui: TUI | undefined;
  private previousClearOnShrink: boolean | undefined;
  /** Previous lifecycle status per agent — terminal transition forces reflow. */
  private lastAgentStatus = new Map<string, AgentRecord["lifecycle"]["status"]>();
  private selectorRegistered = false;
  private selectorTui: TUI | undefined;
  /**
   * Retained after the final selector unmount so agent_end can reflow once Pi removes
   * its Working row. Dropping this with the widget leaves stale editor/footer rows.
   */
  private hostTui: TUI | undefined;
  private screenSwap: ScreenSwapState | undefined;
  /** Keypresses redraw the whole transcript; retain wrapped rows until their messages change. */
  private transcriptCache: {
    session: NonNullable<AgentRecord["execution"]["session"]>;
    messages: MessageLike[];
    theme: Theme;
    width: number;
    lines: WeakMap<MessageLike, string[]>;
    unsubscribe: () => void;
  } | undefined;
  private layoutWarningShown = false;
  private errorWarningShown = false;
  private restoreEditor: (() => void) | undefined;
  private navigationEditor: AgentNavigationEditor | undefined;

  constructor(
    private manager: AgentManager,
    private routeInput?: (agentId: string, text: string) => Promise<InteractionResult>,
    private getPendingResultCount?: () => number | undefined,
    private getParentModelInfo?: () => { providerName?: string; modelName?: string; thinkingLevel?: string } | undefined,
    initialListExpanded = true,
  ) {
    this.listExpanded = initialListExpanded;
  }

  private pendingResultState(): number | undefined {
    const count = this.getPendingResultCount?.();
    return count && count > 0 ? count : undefined;
  }

  setUICtx(ctx: NavigatorUICtx): void {
    if (ctx === this.uiCtx) return;
    if (this.restoreMainScreen()) this.clearScrollbackAndRender();
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
      const editor = new AgentNavigationEditor(base, this);
      this.navigationEditor = editor;
      return editor;
    });
    this.restoreEditor = () => {
      ctx.setEditorComponent(previousEditor);
      this.navigationEditor = undefined;
    };
    if (this.manager.listAgents().some(record =>
      record.lifecycle.status === "running"
      || record.lifecycle.status === "queued"
      || record.execution.settled === false
    )) {
      this.ensureTimer();
    } else {
      this.update();
    }
  }

  toggleList(): void {
    if (this.manager.listAgents().length === 0 && !this.pendingResultState()) return;
    this.listExpanded = !this.listExpanded;
    if (!this.listExpanded) {
      this.listFocused = false;
      this.confirmingClearId = null;
      this.highlightedAgentId = this.selectedAgentId;
    }
    this.lastRenderSig = "";
    this.update();
  }

  activateMain(): void {
    if (this.selectedAgentId === null) return;
    if (this.activate(null)) this.update();
  }

  selectedId(): string | null {
    if (this.selectedAgentId && !this.manager.getRecord(this.selectedAgentId)) {
      this.selectedAgentId = null;
      this.highlightedAgentId = null;
      this.interactionRequestId++;
      this.interactionNotice = undefined;
      this.listFocused = false;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
      this.update();
    }
    return this.selectedAgentId;
  }

  /** Current highlighted subagent ID in the list, or null for Main. Pure read, no side-effects. */
  highlightedId(): string | null {
    return this.highlightedAgentId;
  }

  /** Stop the currently selected subagent if it is running. */
  abortActiveSubagent(): boolean {
    const id = this.selectedId();
    if (!id) return false;
    const record = this.manager.getRecord(id);
    if (!record || record.lifecycle.status !== "running") return false;
    return this.manager.abort(id, "user");
  }

  /** Apply or clear a UI-only status preview from /agents → Debug. */
  setDebugStatusPreview(status: DebugStatusPreview | undefined): void {
    this.debugStatusPreview = status;
    this.lastRenderSig = "";
    this.requestRender(true);
  }

  /** Receive stats visibility from ConfigStore and redraw immediately when it changes. */
  setStatsVisibility(visible: StatsVisibility): void {
    this.statsVisibility = visible;
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

  /** Route ordinary editor submissions before Pi can enqueue them on Main. */
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

  /**
   * Enter the list from an empty editor with Down. Up/Down only moves the
   * candidate row; Enter confirms the switch and keeps the active row focused.
   * Space toggles a session-local pin. Ctrl+D clears a non-active subagent
   * (Enter confirms, Esc cancels). Escape or Up above Main returns input to the
   * editor without changing the active agent.
   */
  handleTerminalInput(data: string): { consume?: boolean } | undefined {
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

  beginInteraction(agentId: string): number {
    if (agentId !== this.selectedAgentId) return -1;
    return ++this.interactionRequestId;
  }

  completeInteraction(
    requestId: number,
    agentId: string,
    text: string,
    result: InteractionResult,
  ): boolean {
    if (requestId !== this.interactionRequestId || agentId !== this.selectedAgentId) return false;
    if (result.accepted) {
      this.clearInteractionNotice();
      return true;
    }

    // Do not overwrite a newer draft typed while the async continuation was pending.
    if (this.uiCtx?.getEditorText() === "") this.uiCtx.setEditorText(text);
    this.interactionNotice = result.reason === "concurrency" && result.modelKey
      ? `Blocked: ${result.modelKey} concurrency limit reached`
      : result.reason === "queued"
        ? "Blocked: selected subagent is queued"
        : "Blocked: selected subagent is unavailable";
    this.lastRenderSig = "";
    this.update();
    return true;
  }

  clearInteractionNotice(): void {
    if (!this.interactionNotice) return;
    this.interactionNotice = undefined;
    this.lastRenderSig = "";
    this.update();
  }

  private toggleHighlightedPin(): void {
    const id = this.highlightedAgentId;
    if (id === null) {
      this.uiCtx?.notify("Cannot pin Main agent", "warning");
      return;
    }
    const pinned = this.manager.togglePinned(id);
    if (pinned == null) {
      this.uiCtx?.notify("Agent not found", "warning");
      return;
    }
    this.uiCtx?.notify(pinned ? "Subagent pinned" : "Subagent unpinned", "info");
    this.update();
  }

  /** Ctrl+D target rules: never Main, never the currently selected subagent. */
  private beginClearConfirmation(): void {
    const id = this.highlightedAgentId;
    if (id === null) {
      this.uiCtx?.notify("Cannot clear Main agent", "warning");
      return;
    }
    if (id === this.selectedAgentId) {
      this.uiCtx?.notify("Cannot clear the active subagent — switch to Main first", "warning");
      return;
    }
    if (!this.manager.getRecord(id)) {
      this.uiCtx?.notify("Agent not found", "warning");
      return;
    }
    this.confirmingClearId = id;
    this.update();
  }

  private confirmClear(): void {
    const id = this.confirmingClearId;
    this.confirmingClearId = null;
    if (!id) {
      this.update();
      return;
    }
    if (id === this.selectedAgentId) {
      this.uiCtx?.notify("Cannot clear the active subagent — switch to Main first", "warning");
      this.update();
      return;
    }

    const entries = this.navigationEntries();
    const index = entries.findIndex(entry => entry.id === id);
    const cleared = this.manager.clear(id, "user");
    if (!cleared) {
      this.uiCtx?.notify("Agent not found", "warning");
      this.update();
      return;
    }

    const remaining = this.navigationEntries();
    if (remaining.length <= 1) {
      this.listFocused = false;
      this.highlightedAgentId = null;
    } else {
      const nextIndex = Math.min(Math.max(index, 0), remaining.length - 1);
      // Prefer the row that slid into this slot; fall back to previous neighbor.
      this.highlightedAgentId = remaining[nextIndex]?.id
        ?? remaining[nextIndex - 1]?.id
        ?? null;
    }
    this.update();
  }

  private navigationEntries(): NavigationEntry[] {
    const agents = this.manager.listAgents()
      .map(record => ({ id: record.id, record }));
    return [{ id: null }, ...agents];
  }

  private activate(id: string | null): boolean {
    if (id === this.selectedAgentId) return true;
    if (id && !this.manager.getRecord(id)) return false;

    if (id) {
      if (!this.swapToSubagentScreen()) {
        this.warnUnsupportedLayout();
        return false;
      }
      this.selectedAgentId = id;
    } else {
      this.selectedAgentId = null;
      this.restoreMainScreen();
    }

    this.interactionRequestId++;
    this.interactionNotice = undefined;
    this.highlightedAgentId = this.selectedAgentId;
    this.clearScrollbackAndRender();
    if (id && !this.refreshTimer) this.ensureTimer();
    return true;
  }

  private captureScreen(tui: TUI, selector: Component): void {
    if (this.screenSwap?.tui === tui) return;
    if (this.restoreMainScreen()) this.clearScrollbackAndRender();

    const rootChildren = tui.children;
    const documentContainer = rootChildren[0];
    const pendingContainer = rootChildren[1];
    const statusContainer = rootChildren[2];
    const widgetAbove = rootChildren[3];
    const editorContainer = rootChildren[4];
    const widgetBelow = rootChildren[5];
    const footerContainer = rootChildren[6];
    const documentChildren = isContainerLike(documentContainer) ? documentContainer.children : [];
    const chatIndex = 2;
    const originalChat = documentChildren[chatIndex];
    if (
      rootChildren.length !== PI_ROOT_CHILDREN
      || documentChildren.length !== PI_DOCUMENT_CHILDREN
      || !isContainerLike(originalChat)
      || !isContainerLike(pendingContainer)
      || !isContainerLike(statusContainer)
      || !isContainerLike(widgetAbove)
      || !isContainerLike(editorContainer)
      || !isContainerLike(widgetBelow)
      || !containsComponent(widgetBelow, selector)
      || !this.navigationEditor
      || !containsComponent(editorContainer, this.navigationEditor)
      || !isContainerLike(footerContainer)
    ) {
      this.screenSwap = undefined;
      this.warnUnsupportedLayout();
      return;
    }

    const transcript: Component = {
      render: (width) => this.renderActiveTranscript(width),
      invalidate: () => this.clearTranscriptCache(),
    };
    const originalFooterRender = footerContainer.render;
    this.screenSwap = {
      tui,
      documentChildren,
      chatIndex,
      originalChat,
      pendingContainer,
      statusContainer,
      footerContainer,
      originalPendingRender: pendingContainer.render,
      originalStatusRender: statusContainer.render,
      originalFooterRender,
      emptyRender: () => [],
      childFooterRender: (width) => this.renderChildFooter(
        footerContainer,
        originalFooterRender,
        width,
      ),
      transcript,
      active: false,
    };
  }

  private swapToSubagentScreen(): boolean {
    const screen = this.screenSwap;
    if (!screen) return false;

    const currentChat = screen.documentChildren[screen.chatIndex];
    const chatCompatible = currentChat === screen.originalChat || currentChat === screen.transcript;
    const pendingCompatible = screen.pendingContainer.render === screen.originalPendingRender
      || screen.pendingContainer.render === screen.emptyRender;
    const statusCompatible = screen.statusContainer.render === screen.originalStatusRender
      || screen.statusContainer.render === screen.emptyRender;
    const footerCompatible = screen.footerContainer.render === screen.originalFooterRender
      || screen.footerContainer.render === screen.childFooterRender;
    if (!chatCompatible || !pendingCompatible || !statusCompatible || !footerCompatible) return false;

    screen.documentChildren[screen.chatIndex] = screen.transcript;
    screen.pendingContainer.render = screen.emptyRender;
    screen.statusContainer.render = screen.emptyRender;
    screen.footerContainer.render = screen.childFooterRender;
    screen.active = true;
    return true;
  }

  private restoreMainScreen(): boolean {
    this.clearTranscriptCache();
    const screen = this.screenSwap;
    if (!screen?.active) return false;

    let restored = false;
    if (screen.documentChildren[screen.chatIndex] === screen.transcript) {
      screen.documentChildren[screen.chatIndex] = screen.originalChat;
      restored = true;
    }
    if (screen.pendingContainer.render === screen.emptyRender) {
      screen.pendingContainer.render = screen.originalPendingRender;
      restored = true;
    }
    if (screen.statusContainer.render === screen.emptyRender) {
      screen.statusContainer.render = screen.originalStatusRender;
      restored = true;
    }
    if (screen.footerContainer.render === screen.childFooterRender) {
      screen.footerContainer.render = screen.originalFooterRender;
      restored = true;
    }
    screen.active = false;
    return restored;
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

  private updateFooterStatus(records: AgentRecord[]): void {
    const ctx = this.uiCtx;
    if (!ctx) return;
    const pending = this.pendingResultState();
    if ((records.length === 0 && !pending) || this.listExpanded) {
      if (this.footerStatus !== undefined) ctx.setStatus(STATUS_KEY, undefined);
      this.footerStatus = undefined;
      return;
    }

    const running = records.filter(record => record.lifecycle.status === "running").length;
    const queued = records.filter(record => record.lifecycle.status === "queued").length;
    const title = records.length === 1 ? "Subagent" : "Subagents";
    const separator = ctx.theme.fg("dim", " · ");
    const parts: string[] = [];
    if (this.interactionNotice) {
      parts.push(ctx.theme.bold(ctx.theme.fg("warning", displayText(this.interactionNotice))));
    } else {
      if (running > 0) parts.push(ctx.theme.fg("dim", `${running} running`));
      if (queued > 0) parts.push(ctx.theme.fg("dim", `${queued} queued`));
      parts.push(ctx.theme.fg("dim", `${records.length} total`));
      if (pending) parts.push(ctx.theme.fg("warning", pendingLabel(pending)));
    }
    parts.push(ctx.theme.fg("dim", "Alt+A expand"));
    if (this.selectedAgentId) parts.push(ctx.theme.fg("dim", "Alt+M main"));
    const status = `${ctx.theme.fg("dim", `${title} (`)}${parts.join(separator)}${ctx.theme.fg("dim", ")")}`;
    if (status === this.footerStatus) return;
    this.footerStatus = status;
    ctx.setStatus(STATUS_KEY, status);
  }

  /**
   * Full TUI reflow after main-session Working row drops (agent_end).
   * Clears residual blank lines between editor and below-editor list.
   */
  forceLayoutReflow(): void {
    this.lastRenderSig = "";
    this.requestRender(true);
  }

  isListFocused(): boolean {
    return this.listFocused;
  }

  async openDeliverySelector(customUICtx?: ExtensionUIContext): Promise<void> {
    if (this.isDeliverySelectorOpen) return;
    const entries = this.navigationEntries();
    const highlighted = entries.find(e => e.id === this.highlightedAgentId)?.record;
    if (!highlighted || !this.canDeliverRecord(highlighted)) return;

    const uiCtx = (customUICtx ?? this.uiCtx ?? getSessionCtx()?.ui) as ExtensionUIContext | undefined;
    if (!uiCtx?.custom) return;

    const coordinator = getCoordinator();
    if (!coordinator) return;

    const messages = coordinator.getDeliverableMessages(highlighted.id);
    if (messages.length === 0) return;

    this.isDeliverySelectorOpen = true;
    try {
      await uiCtx.custom<boolean>((tui, theme, _kb, done) => {
        return new DeliverySelectorComponent({
          record: highlighted,
          messages,
          theme,
          tui,
          onConfirm: (selectedIndices) => {
            coordinator.deliverSelectedMessages(highlighted.id, selectedIndices);
            done(true);
          },
          onCancel: () => done(false),
        });
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: "85%",
        },
      });
    } finally {
      this.isDeliverySelectorOpen = false;
      this.listFocused = true;
      this.update();
    }
  }

  canDeliverRecord(record: AgentRecord | undefined): boolean {
    if (!record || !record.lifecycle.takenOver) return false;
    const sessionMessages = record.execution.session?.messages;
    if (sessionMessages && sessionMessages.length > 0) {
      return extractDeliverableMessages(sessionMessages).length > 0;
    }
    return Boolean(record.result && record.result.trim());
  }

  private renderSelector(tui: TUI, theme: Theme): string[] {
    // Keep the registered component stable across idle periods. Removing and re-adding the
    // whole below-editor widget corrupts Pi's differential row cache when the next editor
    // update arrives; an empty render preserves identity while contributing zero height.
    const records = this.manager.listAgents();
    const pending = this.pendingResultState();
    if ((records.length === 0 && !pending) || !this.listExpanded) return [];

    const entries = this.navigationEntries();
    const agentEntries = entries.slice(1);
    const focusId = this.listFocused ? this.highlightedAgentId : this.selectedAgentId;
    const agentFocusIndex = Math.max(0, agentEntries.findIndex(entry => entry.id === focusId));
    const { start, end } = computeListWindow(agentEntries.length, agentFocusIndex, tui.terminal.rows);
    const visibleEntries = agentEntries.slice(start, end);
    const highlightedRecord = entries.find(entry => entry.id === this.highlightedAgentId)?.record;

    // No permanent header chrome; show one contextual command bar while navigating.
    // The two-column prefix aligns it with the row circles, not the focus marker.
    const lines: string[] = [];
    const cols = tui.terminal.columns;
    const commandWidth = Math.max(1, cols - 1);
    if (this.listFocused) {
      if (this.confirmingClearId !== null) {
        const record = this.manager.getRecord(this.confirmingClearId);
        const target = truncateToWidth(displayText(record?.display.description ?? "agent"), 32);
        const confirmation = [
          theme.fg("dim", `Remove “${target}”? · Enter `),
          theme.fg("error", "Remove"),
          theme.fg("dim", " · Esc Cancel"),
        ].join("");
        lines.push(` ${truncateToWidth(confirmation, commandWidth)}`);
      } else {
        let commandText: string;
        if (this.canDeliverRecord(highlightedRecord)) {
          commandText = "↑↓ Move · Enter Open · Space Unpin · Alt+S Deliver · Ctrl+D Remove · Esc Editor";
        } else {
          const pinHint = highlightedRecord
            ? ` · Space ${highlightedRecord.lifecycle.pinnedAt != null ? "Unpin" : "Pin"}`
            : "";
          commandText = `↑↓ Move · Enter Open${pinHint} · Ctrl+D Remove · Esc Editor`;
        }
        lines.push(` ${truncateToWidth(
          theme.fg("dim", commandText),
          commandWidth,
        )}`);
      }
    }
    const mainActive = this.selectedAgentId === null;
    const mainHighlighted = this.listFocused && this.highlightedAgentId === null;
    const mainIndicator = mainActive ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const mainLabel = mainActive || mainHighlighted ? theme.bold("Main") : "Main";
    const running = records.filter(record => record.lifecycle.status === "running").length;
    const queued = records.filter(record => record.lifecycle.status === "queued").length;
    const summaryParts: string[] = [];
    if (this.interactionNotice) {
      summaryParts.push(theme.bold(theme.fg("warning", displayText(this.interactionNotice))));
    } else {
      if (running > 0) summaryParts.push(theme.fg("dim", `${running} running`));
      if (queued > 0) summaryParts.push(theme.fg("dim", `${queued} queued`));
      summaryParts.push(theme.fg("dim", `${records.length} total`));
      if (pending) summaryParts.push(theme.fg("warning", pendingLabel(pending)));
    }
    summaryParts.push(theme.fg("dim", "Alt+A collapse"));
    if (this.selectedAgentId) summaryParts.push(theme.fg("dim", "Alt+M main"));
    const summary = summaryParts.join(theme.fg("dim", " · "));
    const mainText = ` ${mainIndicator} ${mainLabel}${theme.fg("dim", " (")}${summary}${theme.fg("dim", ")")}`;
    let mainLine = truncateToWidth(mainText, tui.terminal.columns);
    if (mainHighlighted) {
      mainLine = applySelectedBackground(mainLine, tui.terminal.columns, theme);
    }
    lines.push(mainLine);

    if (start > 0) {
      lines.push(theme.fg("dim", ` ↑ ${start} hidden`));
    }

    for (const entry of visibleEntries) {
      const record = entry.record!;
      const active = entry.id === this.selectedAgentId;
      const highlighted = this.listFocused && entry.id === this.highlightedAgentId;
      const pinned = record.lifecycle.pinnedAt != null;
      const indicator = active
        ? theme.fg("accent", "●")
        : theme.fg("dim", "○");
      const name = getDisplayName(record.display.type);
      const description = displayText(record.display.description).replace(/\n/g, " ");
      const durationMs = (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt;
      const sessionModel = record.execution.session?.model;
      const invocation = record.display.invocation;
      const modelName = sessionModel?.id ?? invocation?.modelName;
      const providerName = sessionModel?.provider ?? invocation?.providerName;
      const thinkingLevel = record.execution.session?.thinkingLevel ?? invocation?.thinkingLevel;
      const parentModel = this.getParentModelInfo?.();
      const plainStatus = plainAgentStatus(record, this.debugStatusPreview);
      const status = renderAgentStatus(record, theme, this.debugStatusPreview);
      const debugBadge = renderDebugBadge(record, theme);
      const fixedPrefix = ` ${indicator} `;
      const pinBadge = pinned ? ` ${theme.fg("accent", "◆")}` : "";
      const plainPinBadge = pinned ? " ◆" : "";
      const statusSuffix = `${debugBadge ? ` ${debugBadge}` : ""} (${status})${pinBadge}`;
      const plainStatusSuffix = `${debugBadge ? " [DEBUG]" : ""} (${plainStatus})${plainPinBadge}`;
      const identityStr = formatModelIdentity({
        providerName,
        modelName,
        thinkingLevel,
      }, parentModel);
      const reservedStatsWidth = identityStr
        ? Math.max(MIN_STATS_COLUMN_WIDTH, visibleWidth(identityStr))
        : 0;
      const maxNameWidth = Math.max(
        1,
        tui.terminal.columns
          - visibleWidth(fixedPrefix)
          - visibleWidth(plainStatusSuffix)
          - STATUS_COLUMN_GAP
          - reservedStatsWidth,
      );
      const visibleNameText = truncateToWidth(name, maxNameWidth, "…");
      const visibleName = active || highlighted ? theme.bold(visibleNameText) : visibleNameText;
      const leftPrefix = `${fixedPrefix}${visibleName}${statusSuffix}`;
      const prefixWidth = visibleWidth(fixedPrefix)
        + visibleWidth(visibleNameText)
        + visibleWidth(plainStatusSuffix);

      const buildStats = (vis: StatsVisibility): string => {
        const parts = buildStatsParts({
          modelName,
          providerName,
          thinkingLevel,
          parent: parentModel,
          toolUses: record.stats.toolUses,
          turnCount: record.stats.turnCount != null && record.stats.turnCount > 0
            ? record.stats.turnCount
            : undefined,
          maxTurns: record.stats.maxTurns,
          input: record.stats.lifetimeUsage.input,
          output: record.stats.lifetimeUsage.output,
          contextPercent: record.stats.contextPercent ?? null,
          compactions: record.stats.compactionCount,
          cost: record.stats.lifetimeUsage.cost,
          durationMs,
        }, theme, vis);
        return parts.length > 0 ? theme.fg("dim", parts.join(STATS_SEP)) : "";
      };

      let stats = buildStats(this.statsVisibility);
      const targetDescWidth = description
        ? Math.min(DESIRED_DESCRIPTION_WIDTH, visibleWidth(description))
        : 0;
      const getAvailableDescWidth = (statsStr: string) => {
        const statsW = visibleWidth(statsStr);
        return tui.terminal.columns - prefixWidth - (statsW > 0 ? statsW + STATUS_COLUMN_GAP * 2 : 0);
      };

      if (targetDescWidth > 0 && getAvailableDescWidth(stats) < targetDescWidth) {
        // Level 1 degradation: drop token counts and cost
        stats = buildStats({
          ...this.statsVisibility,
          showInput: false,
          showOutput: false,
          showCost: false,
        });

        // Level 2 degradation: drop context percentage and turn counts if still tight
        if (getAvailableDescWidth(stats) < targetDescWidth) {
          stats = buildStats({
            ...this.statsVisibility,
            showInput: false,
            showOutput: false,
            showCost: false,
            showContext: false,
            showTurns: false,
          });
        }
      }

      let agentLine = renderAgentRow(
        leftPrefix,
        description,
        stats,
        tui.terminal.columns,
        prefixWidth,
        theme,
      );
      if (highlighted) {
        agentLine = applySelectedBackground(agentLine, tui.terminal.columns, theme);
      }
      lines.push(agentLine);
    }

    if (end < agentEntries.length) {
      lines.push(theme.fg("dim", ` ↓ ${agentEntries.length - end} hidden`));
    }

    return lines;
  }

  private renderChildFooter(
    footerContainer: Component & { children: Component[] },
    originalRender: Component["render"],
    width: number,
  ): string[] {
    const footer = footerContainer.children.length === 1 ? footerContainer.children[0] : undefined;
    const lines = footer
      ? footer.render(width)
      : originalRender.call(footerContainer, width);
    return footer && isBuiltinFooter(footer) ? lines.slice(2) : lines;
  }

  private renderActiveTranscript(width: number): string[] {
    const record = this.selectedAgentId
      ? this.manager.getRecord(this.selectedAgentId)
      : undefined;
    if (!record) return [];

    const theme = this.uiCtx?.theme;
    if (!theme) return [];
    return this.buildTranscriptLines(record, theme, width);
  }

  private clearTranscriptCache(): void {
    this.transcriptCache?.unsubscribe();
    this.transcriptCache = undefined;
  }

  private buildTranscriptLines(record: AgentRecord, theme: Theme, width: number): string[] {
    const status = plainAgentStatus(record);
    const debugLabel = record.execution.debugFaultKind ? " [DEBUG]" : "";
    const lines = [
      theme.fg("accent", theme.bold(
        `${getDisplayName(record.display.type)}${debugLabel} (${status})`,
      )),
      theme.fg("dim", "─".repeat(Math.max(1, width))),
    ].map(line => truncateToWidth(line, width));

    const session = record.execution.session;
    if (!session) {
      this.clearTranscriptCache();
      if (record.error) {
        lines.push(truncateToWidth(theme.fg("error", `Error: ${displayText(record.error)}`), width));
      } else {
        lines.push(truncateToWidth(
          theme.fg("dim", record.lifecycle.status === "queued" ? "Waiting in queue…" : "Starting agent session…"),
          width,
        ));
      }
      return lines;
    }

    const messages = session.messages as unknown as MessageLike[];
    let cache = this.transcriptCache;
    if (!cache || cache.session !== session || cache.messages !== messages || cache.theme !== theme || cache.width !== width) {
      this.clearTranscriptCache();
      const messageLines = new WeakMap<MessageLike, string[]>();
      cache = {
        session,
        messages,
        theme,
        width,
        lines: messageLines,
        unsubscribe: session.subscribe((event) => {
          // Extension hooks can revise a message after it entered session.messages.
          if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
            messageLines.delete(event.message as MessageLike);
          }
        }),
      };
      this.transcriptCache = cache;
    }

    for (const message of messages) {
      for (const line of this.renderMessageLines(message, theme, width, cache.lines)) lines.push(line);
    }

    const streamingMessage = (session.agent.state as unknown as { streamingMessage?: MessageLike }).streamingMessage;
    if (streamingMessage) {
      for (const line of this.renderMessageLines(streamingMessage, theme, width, cache.lines)) lines.push(line);
    }

    if (record.error) {
      lines.push(truncateToWidth(theme.fg("error", `Error: ${displayText(record.error)}`), width));
    }

    return lines;
  }

  private renderMessageLines(
    message: MessageLike,
    theme: Theme,
    width: number,
    cache: WeakMap<MessageLike, string[]>,
  ): string[] {
    const cached = cache.get(message);
    if (cached) return cached;
    const lines: string[] = [];
    this.appendMessage(lines, message, theme, width);
    const rendered = lines.map(line => truncateToWidth(line, width));
    cache.set(message, rendered);
    return rendered;
  }

  private appendMessage(lines: string[], message: MessageLike, theme: Theme, width: number): void {
    switch (message.role) {
      case "user": {
        const text = textFromContent(message.content);
        const images = imageCount(message.content);
        if (!text && images === 0) return;
        lines.push("");
        lines.push(theme.fg("accent", theme.bold("User")));
        if (text) appendWrapped(lines, text, width);
        if (images > 0) {
          appendWrapped(lines, theme.fg("dim", `[${images} image${images === 1 ? "" : "s"}]`), width);
        }
        return;
      }
      case "assistant": {
        if (!Array.isArray(message.content)) return;
        const assistantLines: string[] = [];
        for (const item of message.content as Array<Record<string, unknown>>) {
          if (item.type === "text" && typeof item.text === "string" && item.text) {
            appendWrapped(assistantLines, displayText(item.text), width);
          } else if (item.type === "thinking" && typeof item.thinking === "string") {
            const thinking = displayText(item.thinking).trim();
            if (thinking) {
              assistantLines.push(theme.fg("dim", "  Thinking"));
              appendWrapped(assistantLines, theme.fg("dim", thinking), width);
            }
          } else if (item.type === "toolCall") {
            const name = typeof item.name === "string" ? displayText(item.name) : "tool";
            const args = item.arguments && typeof item.arguments === "object"
              ? item.arguments as Record<string, unknown>
              : undefined;
            appendWrapped(assistantLines, theme.fg("dim", `▸ ${name}${summarizeToolArgs(name, args)}`), width);
          }
        }
        if (assistantLines.length === 0) return;
        lines.push("");
        lines.push(theme.bold("Assistant"));
        for (const line of assistantLines) lines.push(line);
        return;
      }
      case "toolResult": {
        const text = textFromContent(message.content);
        const clipped = text.length > TOOL_RESULT_CHAR_LIMIT
          ? `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n… (tool result truncated)`
          : text;
        const icon = message.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        lines.push(`${icon} ${theme.fg("dim", displayText(message.toolName ?? "tool"))}`);
        if (clipped) appendWrapped(lines, theme.fg("dim", clipped), width);
        return;
      }
      case "bashExecution": {
        lines.push("");
        lines.push(theme.fg("accent", `$ ${displayText(message.command ?? "")}`));
        if (message.output) appendWrapped(lines, displayText(message.output), width);
        return;
      }
      case "compactionSummary":
      case "branchSummary": {
        lines.push("");
        lines.push(theme.fg("dim", message.role === "compactionSummary" ? "Compaction summary" : "Branch summary"));
        if (message.summary) appendWrapped(lines, displayText(message.summary), width);
        return;
      }
    }
  }

  /** Contain host UI failures from event handlers and polling callbacks. */
  update(): void {
    try {
      this.updateNavigator();
    } catch (error) {
      this.warnOnce("Agent navigator update failed", error);
    }
  }

  private updateNavigator(): void {
    if (!this.uiCtx) return;

    const records = this.manager.listAgents();
    const pending = this.pendingResultState();
    if (records.length === 0 && !pending) {
      this.updateFooterStatus(records);
      this.selectedAgentId = null;
      this.highlightedAgentId = null;
      this.confirmingClearId = null;
      this.interactionRequestId++;
      this.interactionNotice = undefined;
      this.listFocused = false;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
      this.lastRenderSig = "";
      this.lastAgentStatus.clear();
      this.requestRender();
      this.stopRefreshTimer();
      return;
    }

    if (this.selectedAgentId && !records.some(record => record.id === this.selectedAgentId)) {
      this.selectedAgentId = null;
      this.interactionRequestId++;
      this.interactionNotice = undefined;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
    }
    if (this.highlightedAgentId && !records.some(record => record.id === this.highlightedAgentId)) {
      this.highlightedAgentId = this.selectedAgentId;
    }
    if (this.confirmingClearId && !records.some(record => record.id === this.confirmingClearId)) {
      this.confirmingClearId = null;
    }
    this.updateFooterStatus(records);

    if (!this.selectorRegistered) {
      this.uiCtx.setWidget(SELECTOR_WIDGET_KEY, (tui, theme) => {
        this.selectorTui = tui;
        this.hostTui = tui;
        this.enableShrinkClearing(tui);
        const selector: Component = {
          render: () => {
            try {
              this.captureScreen(tui, selector);
              return this.renderSelector(tui, theme);
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
      // Keep status map warm even when signature throttles (elapsed-only ticks).
      this.consumeTerminalTransitions(records);
    }

    if (!this.selectedAgentId && !records.some(record =>
      record.lifecycle.status === "running"
      || record.lifecycle.status === "queued"
      || record.execution.settled === false
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
    // Spawn and interaction events call ensureTimer() again, so stop permanent failure
    // loops while retaining a concrete retry path after a transient host failure.
    this.stopRefreshTimer();
    if (this.errorWarningShown) return;
    this.errorWarningShown = true;
    try {
      this.uiCtx?.notify(`[pi-subagents-lite] ${context}: ${errorMessage(error)}`, "warning");
    } catch { /* Notification failures must not reopen the UI error boundary. */ }
  }

  private isTerminalStatus(status: AgentRecord["lifecycle"]["status"]): boolean {
    return status !== "running" && status !== "queued";
  }

  /** True if any agent newly entered a terminal status since last paint. */
  private consumeTerminalTransitions(records: AgentRecord[]): boolean {
    let terminalTransition = false;
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(record.id);
      const prev = this.lastAgentStatus.get(record.id);
      const next = record.lifecycle.status;
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

  /** Cheap signature so timer ticks without real list changes do not repaint. */
  private listRenderSignature(records: AgentRecord[]): string {
    const parts = records.map((record) => {
      const session = record.execution.session;
      const invocation = record.display.invocation;
      const usage = record.stats.lifetimeUsage;
      const contextPercent = record.stats.contextPercent ?? null;
      const elapsedSec = Math.floor(
        ((record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt) / 1000,
      );
      return [
        record.id,
        record.display.type,
        record.display.description,
        getDisplayName(record.display.type),
        record.lifecycle.status,
        record.lifecycle.completedAt ?? "",
        record.lifecycle.pinnedAt ?? "",
        record.execution.settled ? "1" : "0",
        record.execution.debugFaultKind ?? "",
        record.error ?? "",
        session?.model?.id ?? invocation?.modelName ?? "",
        session?.model?.provider ?? invocation?.providerName ?? "",
        session?.thinkingLevel ?? invocation?.thinkingLevel ?? "",
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
    const pending = this.pendingResultState();
    const parent = this.getParentModelInfo?.();
    const parentSig = parent
      ? `${parent.providerName ?? ""}:${parent.modelName ?? ""}:${parent.thinkingLevel ?? ""}`
      : "";
    const cols = this.selectorTui?.terminal.columns ?? 0;
    return [
      parts.join("|"),
      parentSig,
      String(cols),
      this.selectedAgentId ?? "",
      this.highlightedAgentId ?? "",
      this.listFocused ? "1" : "0",
      this.confirmingClearId ?? "",
      this.interactionNotice ?? "",
      this.listExpanded ? "1" : "0",
      pending ? String(pending) : "",
    ].join("#");
  }

  /**
   * Pi defaults clearOnShrink to off, which leaves removed below-editor rows visible when
   * later footer/editor updates race the final list render. Keep Pi's native whole-layout
   * shrink detection enabled for this navigator's lifetime, then restore the host preference
   * on context replacement or disposal. Revisit if Pi makes widget removal atomic.
   */
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

    // Host UI methods are outside our failure boundary. Complete every restoration step
    // even when one host component was already torn down during reload.
    attempt(() => { if (this.restoreMainScreen()) this.requestRender(); });
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
