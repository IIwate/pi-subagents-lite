import { describe, expect, it } from "vitest";
import {
  renderChildFooter,
  restoreMain,
  swapToChild,
  validateChildLayout,
  type ScreenSwapState,
} from "../../../src/platform/pi/tui/layout.js";

function component(children?: unknown[], lines: string[] = []) {
  return {
    render: () => lines,
    invalidate() {},
    ...(children ? { children } : {}),
  };
}

/** The verified Pi 0.84 shape: 7 root children and a 3-child document. */
function verifiedLayout() {
  const selector = component();
  const editor = component();
  const chat = component([component()]);
  const documentContainer = component([component(), component(), chat]);
  const pending = component([]);
  const status = component([]);
  const above = component([]);
  const editorContainer = component([editor]);
  const below = component([selector]);
  const footer = component([component()]);
  const tui = {
    children: [documentContainer, pending, status, above, editorContainer, below, footer],
  } as any;
  return { tui, selector, editor, chat, documentContainer, pending, status, below, footer };
}

describe("REQ-CHILD-003 Pi child-screen layout contract", () => {
  it("accepts the verified Pi 0.84 layout and extracts the swap regions", () => {
    const layout = verifiedLayout();
    const validated = validateChildLayout(layout.tui, layout.selector, layout.editor);
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) return;
    expect(validated.documentChildren).toBe(layout.documentContainer.children);
    expect(validated.originalChat).toBe(layout.chat);
    expect(validated.pendingContainer).toBe(layout.pending);
    expect(validated.statusContainer).toBe(layout.status);
    expect(validated.footerContainer).toBe(layout.footer);
  });

  it("fails closed when the root child count is not the verified Pi 0.84 layout", () => {
    const selector = component();
    const editor = component();
    const tui = {
      children: [component([component(), component(), component([component()])])],
    } as any;
    expect(validateChildLayout(tui, selector, editor)).toEqual({ ok: false });
  });

  it("fails closed when an unknown region changes the root child count", () => {
    const layout = verifiedLayout();
    layout.tui.children.splice(3, 0, component([]));
    expect(validateChildLayout(layout.tui, layout.selector, layout.editor)).toEqual({ ok: false });
  });

  it("fails closed when the document child count is unexpected", () => {
    const layout = verifiedLayout();
    layout.documentContainer.children!.push(component([]));
    expect(validateChildLayout(layout.tui, layout.selector, layout.editor)).toEqual({ ok: false });
  });

  it("fails closed when the chat child is not a container", () => {
    const layout = verifiedLayout();
    layout.documentContainer.children![2] = component();
    expect(validateChildLayout(layout.tui, layout.selector, layout.editor)).toEqual({ ok: false });
  });

  it("fails closed when the selector is not mounted below the editor", () => {
    const layout = verifiedLayout();
    layout.below.children!.length = 0;
    expect(validateChildLayout(layout.tui, layout.selector, layout.editor)).toEqual({ ok: false });
  });

  it("fails closed when the navigation editor is absent or foreign", () => {
    const layout = verifiedLayout();
    expect(validateChildLayout(layout.tui, layout.selector, undefined)).toEqual({ ok: false });
    expect(validateChildLayout(layout.tui, layout.selector, component())).toEqual({ ok: false });
  });
});

function swapFixture() {
  const layout = verifiedLayout();
  const transcript = component(undefined, ["child transcript"]);
  const originalPendingRender = layout.pending.render;
  const originalStatusRender = layout.status.render;
  const originalFooterRender = layout.footer.render;
  const emptyRender = () => [] as string[];
  const childFooterRender = () => ["child footer"];
  const state: ScreenSwapState = {
    tui: layout.tui,
    documentChildren: layout.documentContainer.children as any,
    chatIndex: 2,
    originalChat: layout.chat as any,
    pendingContainer: layout.pending as any,
    statusContainer: layout.status as any,
    footerContainer: layout.footer as any,
    originalPendingRender,
    originalStatusRender,
    originalFooterRender,
    emptyRender,
    childFooterRender,
    transcript: transcript as any,
    active: false,
  };
  return { ...layout, transcript, state, emptyRender, childFooterRender };
}

describe("REQ-CHILD-003 Pi child-screen swap contract", () => {
  it("swaps only the chat region and silences pending, status, and footer", () => {
    const fixture = swapFixture();
    expect(swapToChild(fixture.state)).toBe(true);
    expect(fixture.documentContainer.children![2]).toBe(fixture.transcript);
    expect(fixture.pending.render).toBe(fixture.emptyRender);
    expect(fixture.status.render).toBe(fixture.emptyRender);
    expect(fixture.footer.render).toBe(fixture.childFooterRender);
    expect(fixture.state.active).toBe(true);
  });

  it.each(["pending", "status", "footer"] as const)(
    "fails closed without partial mutation when another extension owns the %s render",
    (region) => {
      const fixture = swapFixture();
      const container = region === "pending"
        ? fixture.pending
        : region === "status"
          ? fixture.status
          : fixture.footer;
      const replacement = () => [`replacement ${region}`];
      container.render = replacement;

      expect(swapToChild(fixture.state)).toBe(false);
      expect(fixture.documentContainer.children![2]).toBe(fixture.chat);
      expect(container.render).toBe(replacement);
      expect(fixture.state.active).toBe(false);
    },
  );

  it("fails closed when another extension replaced the chat region", () => {
    const fixture = swapFixture();
    fixture.documentContainer.children![2] = component([component()]);

    expect(swapToChild(fixture.state)).toBe(false);
    expect(fixture.pending.render).toBe(fixture.state.originalPendingRender);
    expect(fixture.footer.render).toBe(fixture.state.originalFooterRender);
  });

  it("restores every swapped region when returning to Main", () => {
    const fixture = swapFixture();
    swapToChild(fixture.state);

    expect(restoreMain(fixture.state)).toBe(true);
    expect(fixture.documentContainer.children![2]).toBe(fixture.chat);
    expect(fixture.pending.render).toBe(fixture.state.originalPendingRender);
    expect(fixture.status.render).toBe(fixture.state.originalStatusRender);
    expect(fixture.footer.render).toBe(fixture.state.originalFooterRender);
    expect(fixture.state.active).toBe(false);
  });

  it("does nothing before a swap became active", () => {
    const fixture = swapFixture();
    expect(restoreMain(fixture.state)).toBe(false);
    expect(restoreMain(undefined)).toBe(false);
  });

  it("keeps a footer render taken over by another extension after the swap", () => {
    const fixture = swapFixture();
    swapToChild(fixture.state);
    const replacement = () => ["replacement footer"];
    fixture.footer.render = replacement;

    expect(restoreMain(fixture.state)).toBe(true);
    expect(fixture.documentContainer.children![2]).toBe(fixture.chat);
    expect(fixture.footer.render).toBe(replacement);
  });
});

describe("REQ-CHILD-003 Pi child footer contract", () => {
  function builtinFooter() {
    return {
      session: {
        getContextUsage() {},
        sessionManager: { getCwd() {}, getEntries() {} },
      },
      footerData: { getGitBranch() {}, getExtensionStatuses() {} },
      setSession() {},
      setAutoCompactEnabled() {},
      render: () => ["parent cwd", "parent stats", "Subagent (Alt+A collapse)"],
      invalidate() {},
    };
  }

  it("drops the built-in cwd and stats rows while preserving extension statuses", () => {
    const footer = builtinFooter();
    const container = component([footer]) as any;
    expect(renderChildFooter(container, container.render, 120)).toEqual([
      "Subagent (Alt+A collapse)",
    ]);
  });

  it("renders a same-named custom footer unchanged", () => {
    class FooterComponent {
      render(): string[] {
        return ["custom row 1", "custom row 2", "custom row 3"];
      }
      invalidate(): void {}
    }
    const container = component([new FooterComponent()]) as any;
    expect(renderChildFooter(container, container.render, 120)).toEqual([
      "custom row 1",
      "custom row 2",
      "custom row 3",
    ]);
  });

  it("falls back to the container render when the footer is not a single child", () => {
    const container = component(
      [component(undefined, ["a"]), component(undefined, ["b"])],
      ["container fallback"],
    ) as any;
    expect(renderChildFooter(container, container.render, 120)).toEqual(["container fallback"]);
  });
});
