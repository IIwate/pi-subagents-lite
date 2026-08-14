import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildScreenHost } from "../../../src/platform/pi/tui/child-screen-host.js";
import {
  makeManager,
  makeRecord,
  makeSwitchableTui,
  makeTui,
  makeUI,
  mountSelector,
  stripAnsi,
} from "./fixtures.js";

// Renderer contract for the Pi adapter: widget/status wiring, screen swap and
// restoration, footer preservation, fail-closed layout handling, timers, and
// editor interception. Pure navigation decisions and projection text live in
// test/modules/child-screen and are not re-asserted here.
describe("ChildScreenHost", () => {
  let host: ChildScreenHost | undefined;

  afterEach(() => {
    host?.dispose();
    host = undefined;
    vi.useRealTimers();
  });

  describe("widget and status wiring (REQ-CHILD-002)", () => {
    it("stays hidden before any subagent exists", () => {
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([]));
      host.setUICtx(ui.ctx as any);

      expect(ui.widgets.size).toBe(0);
      expect(ui.statuses.size).toBe(0);
    });

    it("registers a below-editor selector containing Main and subagents", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();

      const { selector } = mountSelector(ui);
      const text = selector.render(120).join("\n");

      expect(text).toContain("● Main");
      expect(text).toMatch(/○ \S+ \(Running\)  Inspect the project/);
      expect(text).toContain("openai-test · gpt-test · high");
      expect(ui.ctx.setWidget).toHaveBeenCalledWith(
        "agent-navigator-selector",
        expect.any(Function),
        { placement: "belowEditor" },
      );
      expect(ui.statuses.has("subagents-lite")).toBe(false);
    });

    it("starts folded when the default expansion setting is off", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]), undefined, undefined, false);
      host.setUICtx(ui.ctx as any);
      const { selector } = mountSelector(ui);

      expect(selector.render(120)).toEqual([]);
      expect(ui.statuses.get("subagents-lite")).toBe(
        "Subagent (1 running · 1 total · Alt+A expand)",
      );

      host.toggleList();
      expect(selector.render(120).join("\n")).toContain("● Main");
      expect(ui.statuses.has("subagents-lite")).toBe(false);
    });

    it("feeds the pending result count callback into the projection", () => {
      let pending = 3;
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]), undefined, () => pending);
      host.setUICtx(ui.ctx as any);
      const { selector } = mountSelector(ui);

      expect(selector.render(120).join("\n")).toContain("3 results pending");

      pending = 0;
      host.update();
      expect(selector.render(120).join("\n")).not.toContain("results pending");
    });

    it("moves the summary between the list and the footer status when folding", () => {
      const records = [makeRecord("agent-1"), makeRecord("agent-2", "queued")];
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager(records));
      host.setUICtx(ui.ctx as any);
      const { selector } = mountSelector(ui);

      host.toggleList();
      expect(selector.render(120)).toEqual([]);
      expect(ui.statuses.get("subagents-lite")).toBe(
        "Subagents (1 running · 1 queued · 2 total · Alt+A expand)",
      );
      expect(host.handleTerminalInput("\x1b[B")).toBeUndefined();

      host.toggleList();
      expect(selector.render(120).join("\n")).toContain("● Main");
      expect(ui.statuses.has("subagents-lite")).toBe(false);
    });

    it("clears the folded footer status while the record list is empty", () => {
      const records = [makeRecord()];
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager(records));
      host.setUICtx(ui.ctx as any);
      const { selector } = mountSelector(ui);
      host.toggleList();
      expect(ui.statuses.has("subagents-lite")).toBe(true);

      records.length = 0;
      host.update();
      expect(ui.statuses.has("subagents-lite")).toBe(false);
      expect(selector.render(120)).toEqual([]);

      records.push(makeRecord("agent-next"));
      host.update();
      expect(selector.render(120)).toEqual([]);
      expect(ui.statuses.get("subagents-lite")).toBe(
        "Subagent (1 running · 1 total · Alt+A expand)",
      );
    });

    it("clears the folded footer status when disposed", () => {
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([makeRecord()]));
      host.setUICtx(ui.ctx as any);
      host.toggleList();
      expect(ui.statuses.has("subagents-lite")).toBe(true);

      host.dispose();
      host = undefined;
      expect(ui.statuses.has("subagents-lite")).toBe(false);
    });

    it("renders the display name supplied by the composition root", () => {
      const record = makeRecord("agent-long", "running");
      record.type = "long-agent";
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(
        makeManager([record]),
        undefined,
        undefined,
        true,
        (type) => (type === "long-agent" ? "Extremely Long Custom Agent Display Name" : type),
      );
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui, selector } = mountSelector(ui);
      tui.terminal.columns = 42;

      // The injected display name replaces the raw type and is truncated
      // ahead of the reserved identity column on a narrow terminal.
      const text = stripAnsi(selector.render(42).join("\n"));
      expect(text).toContain("(Running)");
      expect(text).toContain("Ext…");
      expect(text).not.toContain("long-agent");
      expect(text).toContain("openai-test");
    });

    it("applies the statsVisibility toggle to the rendered list", () => {
      const record = makeRecord();
      record.stats.lifetimeUsage.cost = 0.05;
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);

      expect(selector.render(120).join("\n")).toContain("$");

      host.setStatsVisibility({ showCost: false });
      expect(selector.render(120).join("\n")).not.toContain("$");
    });

    it("previews a debug status without mutating the manager record", () => {
      const record = makeRecord("agent-running", "running");
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);

      host.setDebugStatusPreview("error");
      expect(selector.render(120).join("\n")).toContain("Error");
      expect(record.status).toBe("running");

      host.setDebugStatusPreview(undefined);
      expect(selector.render(120).join("\n")).toContain("Running");
    });

    it("routes pin toggles to the manager and reports the outcome", () => {
      const done = makeRecord("agent-done", "completed");
      const records = [done];
      const ui = makeUI({ value: "" });
      const manager = makeManager(records) as any;
      host = new ChildScreenHost(manager);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B"); // Focus Main.
      host.handleTerminalInput(" ");
      expect(ui.ctx.notify).toHaveBeenCalledWith("Cannot pin Main agent", "warning");

      host.handleTerminalInput("\x1b[B"); // Highlight the record.
      host.handleTerminalInput(" ");
      expect(manager.togglePinned).toHaveBeenCalledWith(done.id);
      expect(ui.ctx.notify).toHaveBeenCalledWith("Subagent pinned", "info");
      expect(selector.render(120).join("\n")).toContain("◇");

      host.handleTerminalInput(" ");
      expect(ui.ctx.notify).toHaveBeenCalledWith("Subagent unpinned", "info");
    });

    it("Ctrl+D then Enter clears through the manager and moves the highlight", () => {
      const r1 = makeRecord("agent-11111111");
      const r2 = makeRecord("agent-22222222");
      const records = [r1, r2];
      const ui = makeUI({ value: "" });
      const manager = makeManager(records) as any;
      manager.clear = vi.fn((id: string) => {
        const index = records.findIndex(record => record.id === id);
        if (index < 0) return false;
        records.splice(index, 1);
        return true;
      });
      host = new ChildScreenHost(manager);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B"); // Empty editor + Down enters the list at Main.
      host.handleTerminalInput("\x1b[B"); // Highlight the first subagent.
      host.handleTerminalInput("\x04");   // Ctrl+D enters confirmation.
      expect(selector.render(120)[0]).toBe('  Remove “Inspect the project”? · Enter Remove · Esc Cancel');

      host.handleTerminalInput("\r");     // Enter confirms.
      expect(manager.clear).toHaveBeenCalledWith("agent-11111111", "user");
      const lines = selector.render(120);
      expect(lines.join("\n")).not.toContain("Remove “Inspect the project”?");
      expect(lines[0]).toMatch(/^  ↑↓ Move/);
    });

    it("passes through Ctrl+C while cancelling clear confirmation", () => {
      const record = makeRecord("agent-11111111");
      const secondRecord = makeRecord("agent-22222222");
      const ui = makeUI({ value: "" });
      const manager = makeManager([record, secondRecord]) as any;
      manager.clear = vi.fn(() => true);
      host = new ChildScreenHost(manager);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x04");
      expect(selector.render(120).join("\n")).toContain("Remove “Inspect the project”?");

      const result = host.handleTerminalInput("\x03");
      expect(result?.consume).toBeFalsy();
      expect(manager.clear).not.toHaveBeenCalled();
      expect(selector.render(120).join("\n")).not.toContain("Remove “Inspect the project”?");
    });

    it("keeps navigation keys out of the list while the editor contains text", () => {
      const record = makeRecord();
      const editorText = { value: "draft" };
      const ui = makeUI(editorText);
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      mountSelector(ui);

      expect(host.handleTerminalInput("\x1b[B")).toBeUndefined();
      expect(host.selectedId()).toBeNull();
    });
  });

  describe("screen swap and restoration (REQ-CHILD-003)", () => {
    it("requires Enter before swapping and silences parent regions on the child screen", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");

      expect(host.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);

      host.handleTerminalInput("\r");

      expect(host.selectedId()).toBe(record.id);
      expect(tui.document.children[tui.chatIndex]).not.toBe(tui.originalChat);
      const transcript = stripAnsi(tui.document.children[tui.chatIndex].render(120).join("\n"));
      expect(transcript).toContain("Explore (Running)");
      expect(transcript).toContain("Inspect the project");
      expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
      expect(tui.children[tui.pendingIndex].render(120)).toEqual([]);
      expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
      expect(tui.children[tui.statusIndex].render(120)).toEqual([]);
      expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
      expect(tui.children[tui.footerIndex].render(120)).toEqual([]);
      expect(tui.terminal.write).toHaveBeenCalledWith("\x1b[3J");
    });

    it("restores the parent chat, pending, and status regions after confirmation", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      expect(host.selectedId()).toBe(record.id);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[A");
      expect(host.selectedId()).toBe(record.id);
      host.handleTerminalInput("\r");

      expect(host.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
      expect(tui.children[tui.pendingIndex].render(120)).toEqual(["parent pending"]);
      expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
      expect(tui.children[tui.statusIndex].render(120)).toEqual(["parent status"]);
      expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
      expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
    });

    it("returns to Main idempotently without extra renders or status writes", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      expect(host.selectedId()).toBe(record.id);

      host.activateMain();
      expect(host.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);

      tui.requestRender.mockClear();
      ui.ctx.setStatus.mockClear();
      host.activateMain();
      expect(tui.requestRender).not.toHaveBeenCalled();
      expect(ui.ctx.setStatus).not.toHaveBeenCalled();
    });

    it("falls back to the main screen when the selected record disappears", () => {
      const records = [makeRecord()];
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager(records));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui, selector } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      expect(host.selectedId()).not.toBeNull();

      records.length = 0;
      host.update();

      expect(host.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(ui.widgets.size).toBe(1);
      expect(selector.render(120)).toEqual([]);
    });

    it("restores root components without writing to the terminal during dispose", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      tui.terminal.write.mockClear();
      tui.requestRender.mockClear();

      host.dispose();
      host = undefined;

      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
      expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
      expect(tui.terminal.write).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalledWith(true);
    });

    it("rebinds to a fresh UI context and restores the previous screen", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      host.toggleList();
      expect(ui.statuses.has("subagents-lite")).toBe(true);

      const nextUi = makeUI({ value: "" });
      host.setUICtx(nextUi.ctx as any);

      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(ui.statuses.has("subagents-lite")).toBe(false);
      expect(ui.editorFactory(tui, {}, {})).toBe(ui.baseEditor);
      expect(nextUi.ctx.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
      expect(nextUi.widgets.has("agent-navigator-selector")).toBe(true);
    });

    it("keeps the active child and dynamic footer across Pi 0.84 renderer switches", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const fixture = makeSwitchableTui();
      mountSelector(ui, fixture.tui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      expect(host.selectedId()).toBe(record.id);
      let text = fixture.renderCurrent().join("\n");
      expect(text).toContain("Explore (Running)");
      expect(text).not.toContain("parent chat");
      expect(text).not.toContain("parent pending");
      expect(text).not.toContain("parent status");
      expect(text).not.toContain("parent cwd");
      expect(text).not.toContain("parent stats");

      fixture.switchMode("fullscreen");
      expect(fixture.tui.mode).toBe("fullscreen");
      text = fixture.renderCurrent().join("\n");
      expect(text).toContain("Explore (Running)");
      expect(text).not.toContain("parent pending");
      expect(text).not.toContain("parent status");
      expect(text).not.toContain("parent cwd");
      expect(text).not.toContain("parent stats");

      const replacementFooter = {
        render: () => ["replacement footer"],
        invalidate: vi.fn(),
      };
      fixture.tui.footerContainer.children = [replacementFooter];
      expect(fixture.renderCurrent().join("\n")).toContain("replacement footer");

      fixture.switchMode("regular");
      expect(fixture.tui.mode).toBe("regular");
      expect(fixture.renderCurrent().join("\n")).toContain("replacement footer");
      expect(host.selectedId()).toBe(record.id);

      host.handleTerminalInput("\x1b[A");
      host.handleTerminalInput("\r");

      expect(host.selectedId()).toBeNull();
      text = fixture.renderCurrent().join("\n");
      expect(text).toContain("parent chat");
      expect(text).toContain("parent pending");
      expect(text).toContain("parent status");
      expect(text).toContain("replacement footer");
      expect(fixture.regular.children).toHaveLength(7);
      expect(fixture.fullscreen.children).toHaveLength(0);
    });
  });

  describe("footer replacement (REQ-CHILD-003)", () => {
    it("removes built-in Main footer data while preserving extension statuses", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const tui = makeTui();
      tui.originalFooter.render = () => [
        "parent cwd",
        "parent stats",
        "Subagent (Alt+A collapse · Alt+M main)",
      ];
      mountSelector(ui, tui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      expect(tui.footerContainer.render(120)).toEqual([
        "Subagent (Alt+A collapse · Alt+M main)",
      ]);
    });

    it("preserves a same-named custom footer while a subagent is selected", () => {
      class FooterComponent {
        render(): string[] {
          return ["custom row 1", "custom row 2", "custom row 3"];
        }
        invalidate(): void {}
      }

      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const tui = makeTui();
      tui.footerContainer.children = [new FooterComponent()];
      mountSelector(ui, tui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      expect(tui.footerContainer.render(120)).toEqual([
        "custom row 1",
        "custom row 2",
        "custom row 3",
      ]);
    });

    it("keeps a footer replaced by another extension while Main is selected", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);
      const replacementFooter = {
        render: () => ["replacement cwd", "replacement stats"],
        invalidate: vi.fn(),
      };
      tui.footerContainer.children = [replacementFooter];

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[A");
      host.handleTerminalInput("\r");

      expect(tui.footerContainer.children).toEqual([replacementFooter]);
      expect(tui.footerContainer.render(120)).toEqual(["replacement cwd", "replacement stats"]);
    });

    it("renders a footer replaced by another extension on the child screen", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      const replacementFooter = {
        render: () => ["replacement cwd", "replacement stats"],
        invalidate: vi.fn(),
      };
      tui.footerContainer.children = [replacementFooter];

      expect(tui.footerContainer.render(120)).toEqual(["replacement cwd", "replacement stats"]);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[A");
      host.handleTerminalInput("\r");
      expect(tui.footerContainer.children).toEqual([replacementFooter]);
    });
  });

  describe("fail-closed layout handling (REQ-CHILD-003)", () => {
    it("rejects a document container with an unexpected child count", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const tui = makeTui();
      tui.document.children.push({ children: [], render: () => [], invalidate: vi.fn() });
      mountSelector(ui, tui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      expect(host.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(ui.ctx.notify).toHaveBeenCalledWith(
        "Subagent screen switching is unavailable: unsupported Pi TUI layout",
        "warning",
      );
      expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
    });

    it.each(["pending", "status", "footer"] as const)(
      "rejects switching after another extension replaces the %s render method",
      (region) => {
        const record = makeRecord();
        const ui = makeUI({ value: "" });
        host = new ChildScreenHost(makeManager([record]));
        host.setUICtx(ui.ctx as any);
        host.ensureTimer();
        const tui = makeTui();
        mountSelector(ui, tui);
        const originalPendingRender = tui.originalPending.render;
        const originalStatusRender = tui.originalStatus.render;
        const originalFooterRender = tui.footerContainer.render;
        const container = region === "pending"
          ? tui.originalPending
          : region === "status"
            ? tui.originalStatus
            : tui.footerContainer;
        const replacementRender = () => [`replacement ${region}`];
        container.render = replacementRender;

        host.handleTerminalInput("\x1b[B");
        host.handleTerminalInput("\x1b[B");
        host.handleTerminalInput("\r");

        expect(host.selectedId()).toBeNull();
        expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
        expect(tui.originalPending.render).toBe(
          region === "pending" ? replacementRender : originalPendingRender,
        );
        expect(tui.originalStatus.render).toBe(
          region === "status" ? replacementRender : originalStatusRender,
        );
        expect(tui.footerContainer.render).toBe(
          region === "footer" ? replacementRender : originalFooterRender,
        );
        expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
        expect(ui.ctx.notify).toHaveBeenCalledWith(
          "Subagent screen switching is unavailable: unsupported Pi TUI layout",
          "warning",
        );
      },
    );

    it("uses native shrink clearing while the selector is mounted", () => {
      const records = [makeRecord("agent-11111111"), makeRecord("agent-22222222")];
      const ui = makeUI({ value: "" });
      const tui = makeTui();
      host = new ChildScreenHost(makeManager(records));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui, tui);

      expect(tui.getClearOnShrink()).toBe(true);
      tui.requestRender.mockClear();

      records.splice(0, 1);
      host.update();

      // Pi detects the exact whole-layout shrink during its normal render pass.
      expect(tui.requestRender).toHaveBeenCalledWith(false);
      expect(tui.requestRender).not.toHaveBeenCalledWith(true);

      records.length = 0;
      host.update();

      // Keep the component identity stable while contributing no visible rows.
      expect(ui.widgets.get("agent-navigator-selector")).toBeTypeOf("function");
      expect(tui.getClearOnShrink()).toBe(true);
      expect(tui.requestRender).toHaveBeenCalledWith(false);
      expect(selector.render(120)).toEqual([]);

      tui.requestRender.mockClear();
      host.forceLayoutReflow();
      expect(tui.requestRender).toHaveBeenCalledWith(true);

      host.dispose();
      host = undefined;
      expect(tui.getClearOnShrink()).toBe(false);
    });
  });

  describe("refresh and error containment (REQ-CHILD-004)", () => {
    it("does not start a refresh timer before a TUI context is attached", () => {
      host = new ChildScreenHost(makeManager([makeRecord()]));

      host.ensureTimer();

      expect((host as any).refreshTimer).toBeUndefined();
    });

    it("keeps footer reconciliation active while a completed child is selected", () => {
      vi.useFakeTimers();
      const record = makeRecord("agent-12345678", "completed");
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      expect((host as any).refreshTimer).toBeUndefined();
      mountSelector(ui);

      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      expect((host as any).refreshTimer).toBeDefined();
      const update = vi.spyOn(host, "update");
      update.mockClear();
      vi.advanceTimersByTime(999);
      expect(update).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(update).toHaveBeenCalled();
    });

    it("requests a redraw when the displayed model changes", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const tui = makeTui();
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      mountSelector(ui, tui);
      tui.requestRender.mockClear();

      record._session.modelId = "gpt-updated";
      host.update();

      expect(tui.requestRender).toHaveBeenCalledWith(false);
    });

    it("requests a redraw when displayed usage changes", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const tui = makeTui();
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      mountSelector(ui, tui);
      tui.requestRender.mockClear();

      record.stats.compactionCount = 1;
      record.stats.lifetimeUsage.cost = 0.25;
      host.update();

      expect(tui.requestRender).toHaveBeenCalledWith(false);
    });

    it("refreshes the elapsed time column once per second", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const record = makeRecord();
      record.startedAt = Date.now() - 15_000;
      record.stats.toolUses = 0;
      record.stats.turnCount = 0;
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui, selector } = mountSelector(ui);

      const row0 = selector.render(120)[1];
      expect(row0).toHaveLength(120);
      expect(row0).toMatch(/15s$/);

      vi.advanceTimersByTime(1000);
      const row1 = selector.render(120)[1];
      expect(row1).toMatch(/16s$/);
      expect(tui.requestRender).toHaveBeenCalled();
    });

    it("stops refresh polling after an update failure and warns once", () => {
      vi.useFakeTimers();
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const manager = makeManager([record]) as any;
      host = new ChildScreenHost(manager);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      manager.listSnapshots = vi.fn(() => { throw new Error("navigator state unavailable"); });

      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();

      expect(vi.getTimerCount()).toBe(0);
      expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
      expect(ui.ctx.notify).toHaveBeenCalledWith(
        expect.stringContaining("navigator state unavailable"),
        "warning",
      );
    });

    it("contains repeated selector render failures and warns once", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const manager = makeManager([record]) as any;
      host = new ChildScreenHost(manager);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);
      manager.listSnapshots = vi.fn(() => { throw new Error("selector state unavailable"); });

      expect(selector.render(120)).toEqual([]);
      expect((host as any).refreshTimer).toBeUndefined();
      expect(selector.render(120)).toEqual([]);

      expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
      expect(ui.ctx.notify).toHaveBeenCalledWith(
        expect.stringContaining("selector state unavailable"),
        "warning",
      );
    });

    it("finishes disposal when a stale host widget rejects removal", () => {
      vi.useFakeTimers();
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { tui } = mountSelector(ui);
      ui.ctx.setWidget.mockImplementation((_key: string, content: unknown) => {
        if (content === undefined) throw new Error("widget host disposed");
      });

      expect(() => host?.dispose()).not.toThrow();

      expect((host as any).refreshTimer).toBeUndefined();
      expect((host as any).uiCtx).toBeUndefined();
      expect(tui.getClearOnShrink()).toBe(false);
      expect(ui.ctx.notify).toHaveBeenCalledWith(
        expect.stringContaining("widget host disposed"),
        "warning",
      );
      host = undefined;
    });
  });

  describe("editor interception and interaction routing (REQ-CHILD-004)", () => {
    it("decorates the editor and forwards printable input after leaving the list", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      host = new ChildScreenHost(makeManager([record]));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      mountSelector(ui);

      const editor = ui.editorFactory(makeTui(), {}, {});
      expect(editor.wantsKeyRelease).toBe(true);
      editor.handleInput("\x1b[B");
      expect(ui.baseEditor.handleInput).not.toHaveBeenCalled();

      editor.handleInput("x");
      expect(ui.baseEditor.handleInput).toHaveBeenCalledWith("x");
    });

    it("routes ordinary editor submits before Pi can queue them on Main", () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const routeInput = vi.fn().mockResolvedValue({ accepted: true });
      host = new ChildScreenHost(makeManager([record]), routeInput);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");

      const editor = ui.editorFactory(makeTui(), {}, {});
      const parentSubmit = vi.fn();
      editor.onSubmit = parentSubmit;
      (ui.baseEditor as any).onSubmit("continue the child");

      expect(routeInput).toHaveBeenCalledWith(record.id, "continue the child");
      expect(ui.baseEditor.addToHistory).toHaveBeenCalledWith("continue the child");
      expect(parentSubmit).not.toHaveBeenCalled();

      const parentFollowUp = vi.fn();
      editor.actionHandlers.set("app.message.followUp", parentFollowUp);
      ui.baseEditor.setText("follow up the child");
      ui.baseEditor.actionHandlers.get("app.message.followUp")?.();
      expect(routeInput).toHaveBeenCalledWith(record.id, "follow up the child");
      expect(parentFollowUp).not.toHaveBeenCalled();
      expect(ui.baseEditor.getText()).toBe("");

      (ui.baseEditor as any).onSubmit("/agents");
      expect(parentSubmit).toHaveBeenCalledWith("/agents");
    });

    it("renders interaction blocks on Main and restores counts after a successful retry", async () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const routeInput = vi.fn()
        .mockResolvedValueOnce({
          accepted: false,
          reason: "concurrency",
          concurrencyKey: "cliproxyapi/gpt-5.6-sol",
        })
        .mockResolvedValueOnce({ accepted: true });
      host = new ChildScreenHost(makeManager([record]), routeInput);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      const editor = ui.editorFactory(makeTui(), {}, {});
      editor.onSubmit = vi.fn();

      (ui.baseEditor as any).onSubmit("continue the child");
      await vi.waitFor(() => {
        expect(selector.render(120).join("\n")).toContain(
          "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
        );
      });
      expect(ui.ctx.setEditorText).toHaveBeenCalledWith("continue the child");
      expect(ui.ctx.notify).not.toHaveBeenCalledWith(
        "Selected subagent is not available for interaction",
        "warning",
      );

      (ui.baseEditor as any).onSubmit("retry");
      await vi.waitFor(() => {
        expect(selector.render(120).join("\n")).toContain("1 running · 1 total");
      });
    });

    it("renders interaction blocks in the footer while the list is folded", async () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      const routeInput = vi.fn()
        .mockResolvedValueOnce({
          accepted: false,
          reason: "concurrency",
          concurrencyKey: "cliproxyapi/gpt-5.6-sol",
        })
        .mockResolvedValueOnce({ accepted: true });
      host = new ChildScreenHost(makeManager([record]), routeInput);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      host.toggleList();
      const editor = ui.editorFactory(makeTui(), {}, {});
      editor.onSubmit = vi.fn();

      (ui.baseEditor as any).onSubmit("continue the child");
      await vi.waitFor(() => {
        expect(ui.statuses.get("subagents-lite")).toContain(
          "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
        );
      });
      expect(selector.render(120)).toEqual([]);
      expect(ui.statuses.get("subagents-lite")).toContain("Alt+A expand");
      expect(ui.statuses.get("subagents-lite")).toContain("Alt+M main");

      (ui.baseEditor as any).onSubmit("retry");
      await vi.waitFor(() => {
        expect(ui.statuses.get("subagents-lite")).toBe(
          "Subagent (1 running · 1 total · Alt+A expand · Alt+M main)",
        );
      });
    });

    it("ignores an older failed interaction after a newer success", async () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      let resolveFirst!: (result: any) => void;
      const first = new Promise<any>((resolve) => { resolveFirst = resolve; });
      const routeInput = vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({ accepted: true });
      host = new ChildScreenHost(makeManager([record]), routeInput);
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      const editor = ui.editorFactory(makeTui(), {}, {});
      editor.onSubmit = vi.fn();

      (ui.baseEditor as any).onSubmit("first");
      (ui.baseEditor as any).onSubmit("second");
      await vi.waitFor(() => expect(routeInput).toHaveBeenCalledTimes(2));
      ui.baseEditor.setText("new draft");
      resolveFirst({ accepted: false, reason: "concurrency", modelKey: "test/model" });
      await Promise.resolve();

      expect(selector.render(120).join("\n")).not.toContain("Blocked:");
      expect(ui.baseEditor.getText()).toBe("new draft");
    });

    it("ignores a failed interaction after switching back to Main", async () => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      let resolveInteraction!: (result: any) => void;
      const pending = new Promise<any>((resolve) => { resolveInteraction = resolve; });
      host = new ChildScreenHost(makeManager([record]), vi.fn(() => pending));
      host.setUICtx(ui.ctx as any);
      host.ensureTimer();
      const { selector } = mountSelector(ui);
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\x1b[B");
      host.handleTerminalInput("\r");
      const editor = ui.editorFactory(makeTui(), {}, {});
      editor.onSubmit = vi.fn();
      (ui.baseEditor as any).onSubmit("continue");

      host.handleTerminalInput("\x1b[A");
      host.handleTerminalInput("\r");
      ui.baseEditor.setText("main draft");
      resolveInteraction({ accepted: false, reason: "concurrency", modelKey: "test/model" });
      await Promise.resolve();

      expect(selector.render(120).join("\n")).not.toContain("Blocked:");
      expect(ui.baseEditor.getText()).toBe("main draft");
    });
  });
});
