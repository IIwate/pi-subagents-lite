import type { Component, TUI } from "@earendil-works/pi-tui";

const PI_ROOT_CHILDREN = 7;
const PI_DOCUMENT_CHILDREN = 3;
export const CLEAR_SCROLLBACK_SEQUENCE = "\x1b[3J";

export interface ScreenSwapState {
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

export function validateChildLayout(
  tui: TUI,
  selector: Component,
  editor: Component | undefined,
): {
  ok: true;
  documentChildren: Component[];
  originalChat: Component;
  pendingContainer: Component & { children: Component[] };
  statusContainer: Component & { children: Component[] };
  footerContainer: Component & { children: Component[] };
} | { ok: false } {
  const rootChildren = tui.children;
  const documentContainer = rootChildren[0];
  const pendingContainer = rootChildren[1];
  const statusContainer = rootChildren[2];
  const widgetAbove = rootChildren[3];
  const editorContainer = rootChildren[4];
  const widgetBelow = rootChildren[5];
  const footerContainer = rootChildren[6];
  const documentChildren = isContainerLike(documentContainer) ? documentContainer.children : [];
  const originalChat = documentChildren[2];
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
    || !editor
    || !containsComponent(editorContainer, editor)
    || !isContainerLike(footerContainer)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    documentChildren,
    originalChat,
    pendingContainer,
    statusContainer,
    footerContainer,
  };
}

export function swapToChild(screen: ScreenSwapState): boolean {
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

export function restoreMain(screen: ScreenSwapState | undefined): boolean {
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

export function renderChildFooter(
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