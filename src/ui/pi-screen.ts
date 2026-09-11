import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type AutocompleteProvider, type Component, type EditorComponent, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "./types.js";

const SELECTOR_WIDGET_KEY = "agent-navigator-selector";
const STATUS_KEY = "subagents-lite";
const PI_ROOT_CHILDREN = 7;
const PI_DOCUMENT_CHILDREN = 3;

export type NavigatorUICtx = Pick<ExtensionUIContext, "getEditorComponent" | "getEditorText" | "notify" | "setEditorComponent" | "setEditorText" | "setStatus" | "setWidget" | "theme"> & Partial<Pick<ExtensionUIContext, "custom">>;

interface NavigationInput {
  handleEditorSubmit(text: string, kind?: "steer" | "followUp"): boolean;
  handleEditorDequeue(): boolean;
  handleTerminalInput(data: string): { consume?: boolean } | undefined;
  abortActiveRetry(): boolean;
  abortActiveSubagent(): boolean;
  isListFocused(): boolean;
  update(): void;
}

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
  childPendingRender: Component["render"];
  childStatusRender: Component["render"];
  childFooterRender: Component["render"];
  transcript: Component;
  active: boolean;
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

class ForwardingActionMap extends Map<string, () => void> {
  constructor(
    private base: Map<string, () => void>,
    private wrapFollowUp: (handler: () => void) => () => void,
    private wrapDequeue: (handler: () => void) => () => void,
  ) {
    super();
    for (const [action, handler] of base.entries()) {
      this.set(action, handler);
    }
  }

  override get(action: string): (() => void) | undefined {
    return this.base.get(action);
  }

  override has(action: string): boolean {
    return this.base.has(action);
  }

  override set(action: string, handler: () => void): this {
    const wrapped = action === "app.message.followUp"
      ? this.wrapFollowUp(handler)
      : action === "app.message.dequeue"
        ? this.wrapDequeue(handler)
        : handler;
    this.base.set(action, wrapped);
    super.set(action, wrapped);
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
    private navigator: NavigationInput,
    private keybindings: { matches?: (data: string, action: "app.message.followUp" | "app.message.dequeue") => boolean },
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
        if (this.navigator.handleEditorSubmit(text, "followUp")) {
          this.base.addToHistory?.(text.trim());
          this.base.setText("");
          return;
        }
        parentHandler();
      },
      (parentHandler) => () => {
        if (this.navigator.handleEditorDequeue()) {
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
      if (this.navigator.abortActiveRetry()) {
        this.navigator.update();
        return;
      }
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
    if (result?.consume) return;
    if (this.keybindings.matches?.(data, "app.message.followUp")) {
      const text = this.base.getExpandedText?.() ?? this.base.getText();
      if (this.navigator.handleEditorSubmit(text, "followUp")) {
        this.base.addToHistory?.(text.trim()); this.base.setText(""); return;
      }
    }
    if (this.keybindings.matches?.(data, "app.message.dequeue") && this.navigator.handleEditorDequeue()) return;
    this.base.handleInput(data);
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

/** Owns host component substitutions and their matching restoration. */
export class PiScreen {
  ui?: NavigatorUICtx;
  private hostTui?: TUI;
  private swap?: ScreenSwapState;
  private editor?: AgentNavigationEditor;
  private restoreEditor?: () => void;
  private previousClearOnShrink?: boolean;
  private shrinkTui?: TUI;
  private registered = false;
  private layoutWarningShown = false;

  constructor(private readonly input: NavigationInput, private readonly content: {
    transcript: (width: number) => string[];
    pending: (width: number) => string[];
    status: (width: number) => string[];
    invalidate: () => void;
  }) {}

  get tui(): TUI | undefined { return this.swap?.tui ?? this.hostTui; }
  get active(): boolean { return this.swap?.active ?? false; }

  setContext(ctx: NavigatorUICtx): void {
    if (ctx === this.ui) return;
    if (this.showMain()) this.clearAndRender();
    this.dispose();
    this.ui = ctx;
    this.layoutWarningShown = false;
    const previousEditor = ctx.getEditorComponent();
    const factory: NonNullable<ReturnType<NavigatorUICtx["getEditorComponent"]>> = (tui, theme, keybindings) => {
      const base = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      this.editor = new AgentNavigationEditor(base, this.input, keybindings);
      return this.editor;
    };
    ctx.setEditorComponent(factory);
    this.restoreEditor = () => {
      if (ctx.getEditorComponent() === factory) ctx.setEditorComponent(previousEditor);
      this.editor = undefined;
    };
  }

  mount(render: (tui: TUI, theme: Theme) => string[], onError: (error: unknown) => void): void {
    if (this.registered || !this.ui) return;
    this.ui.setWidget(SELECTOR_WIDGET_KEY, (tui, theme) => {
      this.hostTui = tui;
      if (this.shrinkTui !== tui) {
        this.restoreShrink();
        this.shrinkTui = tui;
        this.previousClearOnShrink = tui.getClearOnShrink();
        tui.setClearOnShrink(true);
      }
      const selector: Component = {
        render: () => {
          try { this.capture(tui, selector); return render(tui, theme); }
          catch (error) { onError(error); return []; }
        },
        invalidate: () => {},
      };
      return selector;
    }, { placement: "belowEditor" });
    this.registered = true;
  }

  private capture(tui: TUI, selector: Component): void {
    if (this.swap?.tui === tui) return;
    if (this.showMain()) this.clearAndRender();
    const root = tui.children;
    const [document, pending, status, above, editor, below, footer] = root;
    const documentChildren = isContainerLike(document) ? document.children : [];
    const chatIndex = 2;
    const chat = documentChildren[chatIndex];
    if (root.length !== PI_ROOT_CHILDREN || documentChildren.length !== PI_DOCUMENT_CHILDREN
      || !isContainerLike(chat) || !isContainerLike(pending) || !isContainerLike(status) || !isContainerLike(above)
      || !isContainerLike(editor) || !isContainerLike(below) || !containsComponent(below, selector)
      || !this.editor || !containsComponent(editor, this.editor) || !isContainerLike(footer)) {
      this.swap = undefined; this.warnLayout(); return;
    }
    const originalFooterRender = footer.render;
    this.swap = {
      tui, documentChildren, chatIndex, originalChat: chat, pendingContainer: pending, statusContainer: status,
      footerContainer: footer, originalPendingRender: pending.render, originalStatusRender: status.render,
      originalFooterRender, emptyRender: () => [], childPendingRender: this.content.pending, childStatusRender: this.content.status,
      childFooterRender: width => {
        const component = footer.children.length === 1 ? footer.children[0] : undefined;
        const lines = component ? component.render(width) : originalFooterRender.call(footer, width);
        return component && isBuiltinFooter(component) ? lines.slice(2) : lines;
      },
      transcript: { render: this.content.transcript, invalidate: this.content.invalidate }, active: false,
    };
  }

  showChild(): boolean {
    const screen = this.swap;
    if (!screen) { this.warnLayout(); return false; }
    const chat = screen.documentChildren[screen.chatIndex];
    if ((chat !== screen.originalChat && chat !== screen.transcript)
      || ![screen.originalPendingRender, screen.childPendingRender, screen.emptyRender].includes(screen.pendingContainer.render)
      || ![screen.originalStatusRender, screen.childStatusRender, screen.emptyRender].includes(screen.statusContainer.render)
      || ![screen.originalFooterRender, screen.childFooterRender].includes(screen.footerContainer.render)) {
      this.warnLayout(); return false;
    }
    screen.documentChildren[screen.chatIndex] = screen.transcript;
    screen.pendingContainer.render = screen.childPendingRender;
    screen.statusContainer.render = screen.childStatusRender;
    screen.footerContainer.render = screen.childFooterRender;
    screen.active = true;
    return true;
  }

  showMain(): boolean {
    this.content.invalidate();
    const screen = this.swap;
    if (!screen?.active) return false;
    let restored = false;
    if (screen.documentChildren[screen.chatIndex] === screen.transcript) {
      screen.documentChildren[screen.chatIndex] = screen.originalChat; restored = true;
    }
    if ([screen.childPendingRender, screen.emptyRender].includes(screen.pendingContainer.render)) {
      screen.pendingContainer.render = screen.originalPendingRender; restored = true;
    }
    if ([screen.childStatusRender, screen.emptyRender].includes(screen.statusContainer.render)) {
      screen.statusContainer.render = screen.originalStatusRender; restored = true;
    }
    if (screen.footerContainer.render === screen.childFooterRender) {
      screen.footerContainer.render = screen.originalFooterRender; restored = true;
    }
    screen.active = false;
    return restored;
  }

  setStatus(text: string | undefined): void { this.ui?.setStatus(STATUS_KEY, text); }
  requestRender(force = false): void { this.tui?.requestRender(force); }
  clearAndRender(): void {
    try { this.tui?.terminal.write("\x1b[3J"); } catch { /* Terminal teardown can close the output before the last reflow. */ }
    this.requestRender(true);
  }

  private warnLayout(): void {
    if (this.layoutWarningShown) return;
    this.layoutWarningShown = true;
    this.ui?.notify("Subagent screen switching is unavailable: unsupported Pi TUI layout", "warning");
  }

  private restoreShrink(): void {
    if (this.shrinkTui && this.previousClearOnShrink !== undefined) this.shrinkTui.setClearOnShrink(this.previousClearOnShrink);
    this.shrinkTui = undefined; this.previousClearOnShrink = undefined;
  }

  dispose(): void {
    const failures: unknown[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (error) { failures.push(error); } };
    attempt(() => { if (this.showMain()) this.requestRender(); });
    attempt(() => { if (this.registered) this.ui?.setWidget(SELECTOR_WIDGET_KEY, undefined); });
    attempt(() => this.setStatus(undefined));
    attempt(() => this.requestRender(true));
    attempt(() => this.restoreShrink());
    attempt(() => this.restoreEditor?.());
    this.swap = undefined; this.hostTui = undefined; this.registered = false; this.restoreEditor = undefined;
    if (failures.length) {
      try { this.ui?.notify(`Agent screen restoration failed: ${String(failures[0])}`, "warning"); }
      catch { /* Reporting a failed host UI cannot prevent release of the remaining references. */ }
    }
    this.ui = undefined;
  }
}
