import {
  type AutocompleteProvider,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";

export interface ChildScreenKeyTarget {
  handleTerminalInput(data: string): { consume?: boolean } | undefined;
  handleEditorSubmit(text: string): boolean;
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
export class ChildNavigationEditor implements EditorComponent, Focusable {
  private parentOnSubmit: ((text: string) => void) | undefined;
  private forwardedActions: ForwardingActionMap | undefined;

  constructor(
    private base: EditorComponent,
    private target: ChildScreenKeyTarget,
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
      if (this.target.handleEditorSubmit(text)) {
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
        if (this.target.handleEditorSubmit(text)) {
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
    return (this.base as unknown as { onEscape?: () => void }).onEscape;
  }

  set onEscape(handler: (() => void) | undefined) {
    (this.base as unknown as { onEscape?: () => void }).onEscape = handler;
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
    return this.base.render(width);
  }

  handleInput(data: string): void {
    const result = this.target.handleTerminalInput(data);
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
