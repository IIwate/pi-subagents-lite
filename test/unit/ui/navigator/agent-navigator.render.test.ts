/**
 * agent-navigator.render.test.ts — Rendering tests for AgentNavigator.
 *
 * Covers:
 *   - Visibility, folding, expansion, Sticky Main
 *   - Pending results, errors, token/cost degradations
 *   - Column layout, truncation, dynamic model differences
 *   - Pin indicators, Alt+S delivery hints, styling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { registerAgents } from "../../../../src/agents/agent-types.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import {
  makeRecord,
  makeManager,
  makeUI,
  mountSelector,
  stripAnsi,
} from "../../../support/navigator.js";

describe("AgentNavigator — Rendering", () => {
  let navigator: AgentNavigator | undefined;
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
    navigator = undefined;
    harness.onDispose(() => navigator?.dispose());
  });

  afterEach(async () => { await harness.dispose(); });

  it("stays hidden before any subagent exists", () => {
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([]));
    navigator.setUICtx(ui.ctx as any);

    expect(ui.widgets.size).toBe(0);
    expect(ui.statuses.size).toBe(0);
  });

  it("defaults to an expanded list with controls on Main", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain("● Main (1 running · 1 total · Alt+A collapse)");
    expect(rendered).not.toContain(record.id);
    expect(ui.statuses.has("subagents-lite")).toBe(false);
  });

  it("shows nonzero pending results inline and hides zero", () => {
    let pending = 3;
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, () => pending);
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    expect(selector.render(120).join("\n")).toContain("3 results pending");

    pending = 0;
    navigator.update();
    expect(selector.render(120).join("\n")).not.toContain("pending result");
    expect(selector.render(120).join("\n")).not.toContain("results pending");
  });

  it("shows an error and an undelivered result independently", () => {
    const record = makeRecord("agent-needs-input", "error");
    record.execution.settled = true;
    record.error = "temporary provider failure";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, () => 1);
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const text = selector.render(120).join("\n");
    expect(text).toContain("Error");
    expect(text).toContain("1 result pending");
  });

  it("lets the user collapse and expand the list", () => {
    const records = [makeRecord("agent-1"), makeRecord("agent-2", "queued")];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    navigator.toggleList();
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagents (1 running · 1 queued · 2 total · Alt+A expand)",
    );

    navigator.toggleList();
    expect(selector.render(120).join("\n")).toContain(
      "● Main (1 running · 1 queued · 2 total · Alt+A collapse)",
    );
    expect(ui.statuses.has("subagents-lite")).toBe(false);
  });

  it("starts folded when the default expansion setting is off", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, undefined, undefined, false);
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagent (1 running · 1 total · Alt+A expand)",
    );

    navigator.toggleList();
    expect(selector.render(120).join("\n")).toContain(
      "● Main (1 running · 1 total · Alt+A collapse)",
    );
  });

  it.each([true, false])("preserves list expansion when returning to Main: expanded=%s", expanded => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    if (!expanded) navigator.toggleList();

    navigator.activateMain();
    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
    if (expanded) {
      expect(selector.render(120).join("\n")).toContain("● Main");
      expect(ui.statuses.has("subagents-lite")).toBe(false);
    } else {
      expect(selector.render(120)).toEqual([]);
      expect(ui.statuses.get("subagents-lite")).toContain("Alt+A expand");
    }
    expect(selector.render(120).join("\n")).not.toContain("Alt+M main");
    tui.requestRender.mockClear();
    navigator.activateMain();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("preserves the user's collapsed choice while the record list is empty", () => {
    let records = [makeRecord()];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator({
      listAgents: () => records,
      getRecord: (id: string) => records.find(r => r.id === id),
      togglePinned: vi.fn(),
    } as any);
    navigator.setUICtx(ui.ctx as any);
    mountSelector(ui);

    navigator.toggleList();
    expect(ui.statuses.get("subagents-lite")).toContain("Alt+A expand");

    records = [];
    navigator.update();
    expect(ui.statuses.size).toBe(0);

    records = [makeRecord("agent-2")];
    navigator.update();
    expect(ui.statuses.get("subagents-lite")).toContain("Alt+A expand");
  });

  it("registers a below-editor selector containing Main and subagents", () => {
    const records = [makeRecord("agent-1"), makeRecord("agent-2", "queued")];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain("Main");
    expect(rendered).toContain("Inspect the project");
    expect(ui.ctx.setWidget).toHaveBeenCalledWith(
      "agent-navigator-selector", expect.any(Function), { placement: "belowEditor" },
    );
  });

  it.each([{ rows: 10, visible: 3 }, { rows: 40, visible: 6 }])(
    "keeps Main sticky and the list window bounded at $rows rows", ({ rows, visible }) => {
    const records = Array.from({ length: 8 }, (_, i) => {
      const record = makeRecord(`agent-${i + 1}`);
      record.display.description = `Task ${i}`;
      return record;
    });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    const { tui, selector } = mountSelector(ui);
    tui.terminal.rows = rows;

    let lines = selector.render(120);
    expect(lines[0]).toContain("8 running · 8 total");
    expect(lines.filter((line: string) => line.includes("Task "))).toHaveLength(visible);
    expect(lines.join("\n")).toContain("hidden");
    navigator.handleTerminalInput("\x1b[B");
    for (const _record of records) navigator.handleTerminalInput("\x1b[B");
    lines = selector.render(120);
    expect(lines.some((line: string) => line.includes("Main"))).toBe(true);
    expect(lines.some((line: string) => line.includes("Task 7"))).toBe(true);
    expect(lines.filter((line: string) => line.includes("Task "))).toHaveLength(visible);
  });

  it("hides zero running and queued counts when only terminal records remain", () => {
    const record = makeRecord("agent-done", "completed");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain("1 total");
    expect(rendered).not.toContain("running");
    expect(rendered).not.toContain("queued");
  });

  it("omits provider and model stats when subagent matches the parent session model completely", () => {
    const record = makeRecord("agent-same");
    record.execution.session!.model = { id: "model-x", provider: "provider-x" };
    record.execution.session!.thinkingLevel = "high";

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([record]),
      undefined,
      undefined,
      () => ({ providerName: "provider-x", modelName: "model-x", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const line = selector.render(120).find((l: string) => l.includes("Inspect the project"))!;
    expect(line).not.toContain("provider-x");
    expect(line).not.toContain("model-x");
  });

  it("shows only model and thinking when only model differs from parent", () => {
    const record = makeRecord("agent-diff-model");
    record.execution.session!.model = { id: "gpt-other", provider: "openai-test" };
    record.execution.session!.thinkingLevel = "high";

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([record]),
      undefined,
      undefined,
      () => ({ providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const line = selector.render(120).find((l: string) => l.includes("Inspect the project"))!;
    expect(line).not.toContain("openai-test");
    expect(line).toContain("gpt-other(high)");
  });

  it("shows full provider/model(thinking) when provider differs from parent", () => {
    const record = makeRecord("agent-diff-prov");
    record.execution.session!.model = { id: "claude-sonnet", provider: "anthropic-test" };
    record.execution.session!.thinkingLevel = "medium";

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([record]),
      undefined,
      undefined,
      () => ({ providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const line = selector.render(120).find((l: string) => l.includes("Inspect the project"))!;
    expect(line).toContain("anthropic-test/claude-sonnet(medium)");
  });

  it("routes Space to the highlighted agent's pin command", () => {
    const record = makeRecord("agent-pin", "completed");
    const manager = makeManager([record]);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // focus Main
    navigator.handleTerminalInput(" ");
    expect(manager.togglePinned).not.toHaveBeenCalled();
    expect(ui.ctx.notify).toHaveBeenCalledWith("Cannot pin Main agent", "warning");
    navigator.handleTerminalInput("\x1b[B"); // focus agent-pin
    expect(navigator.highlightedId()).toBe(record.id);

    navigator.handleTerminalInput(" ");
    expect(manager.togglePinned).toHaveBeenCalledWith(record.id);
  });

  it("shows Alt+S Deliver when focusing takenOver agent with deliverable messages", () => {
    const record = makeRecord("agent-taken", "completed");
    record.lifecycle.takenOver = true;
    record.lifecycle.pinnedAt = Date.now();
    record.execution.session = {
      messages: [{ role: "assistant", content: "Result text" }],
    } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    const command = stripAnsi(selector.render(120)[0]);
    expect(command).toContain("Alt+S Deliver");
  });

  it("handles Alt+S terminal input by triggering openDeliverySelector", async () => {
    const record = makeRecord("agent-taken", "completed");
    record.lifecycle.takenOver = true;
    record.lifecycle.pinnedAt = Date.now();
    record.execution.session = {
      messages: [{ role: "assistant", content: "Result text" }],
    } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    const openSpy = vi.spyOn(navigator, "openDeliverySelector").mockImplementation(async () => {});
    const res = navigator.handleTerminalInput("\x1bs");
    expect(res?.consume).toBe(true);
    expect(openSpy).toHaveBeenCalled();
  });

  it("renders a debug status preview without mutating agent lifecycle", () => {
    const record = makeRecord("agent-running", "running");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.setDebugStatusPreview("error");
    expect(selector.render(120).join("\n")).toContain("Error");
    expect(record.lifecycle.status).toBe("running");

    navigator.setDebugStatusPreview(undefined);
    expect(selector.render(120).join("\n")).toContain("Running");
  });

  it("marks records created by Debug fault injection", () => {
    const record = makeRecord("agent-debug", "error");
    record.execution.settled = true;
    record.execution.debugFaultKind = "output_blocked";
    record.error = "debug injected: content was flagged";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    const listText = stripAnsi(selector.render(120).join("\n"));
    expect(listText).toContain("Explore [DEBUG] (Error)");
    expect(listText).not.toContain("Error (Debug)");

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = stripAnsi(tui.document.children[tui.chatIndex].render(120).join("\n"));
    expect(transcript).toContain("Explore [DEBUG] (Error)");
    expect(transcript).not.toContain("agent-de");
  });

  it("keeps Error visible when a narrow terminal truncates other columns", () => {
    const record = makeRecord("agent-blocked", "error");
    record.execution.settled = true;
    record.execution.debugFaultKind = "output_blocked";
    record.error = "content was flagged";
    record.display.description = "A very long security audit description";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 42;

    const row = selector.render(42).find((line: string) => line.includes("Error"))!;
    expect(row).toContain("Error");
    expect(row).not.toContain("security audit description");
  });

  it("preserves status and provider-first identity space for a long custom display name", () => {
    registerAgents(new Map([[
      "long-agent",
      {
        name: "long-agent",
        displayName: "Extremely Long Custom Agent Display Name",
        description: "Long name test",
        systemPrompt: "Review the project.",
      } as any,
    ]]));
    const record = makeRecord("agent-long", "running");
    record.display.type = "long-agent";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 42;

    const rows = selector.render(42);
    expect(rows.join("\n")).toContain("(Running)");
    expect(rows.join("\n")).toContain("openai-test");
    expect(rows.join("\n")).toContain("gpt-tes");
  });

  it("drops tokens and cost first when width is constrained, preserving tools, duration, and identity", () => {
    const record = makeRecord("agent-long-stats", "running");
    record.display.description = "A".repeat(40);
    record.stats.toolUses = 15;
    record.stats.turnCount = 10;
    record.stats.lifetimeUsage.input = 15000;
    record.stats.lifetimeUsage.output = 3000;
    record.stats.lifetimeUsage.cost = 0.45;
    record.execution.session!.model = { id: "custom-model", provider: "custom-provider" } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Columns = 95: enough for tools/duration/identity/context, but tight with tokens+cost
    tui.terminal.columns = 95;
    const line = selector.render(95).find((l: string) => l.includes("custom-model"))!;

    // Level 1 dropped tokens (↑/↓) and cost ($)
    expect(line).not.toContain("↑");
    expect(line).not.toContain("↓");
    expect(line).not.toContain("$");
    // Preserved tools, duration, and identity
    expect(line).toContain("custom-provider/custom-model");
    expect(line).toContain("15 calls");
    expect(line).toContain("<1s");
  });

  it("drops context and turns in level 2 degradation under extreme width pressure", () => {
    const record = makeRecord("agent-tight", "running");
    record.display.description = "B".repeat(40);
    record.stats.toolUses = 5;
    record.stats.turnCount = 8;
    record.stats.lifetimeUsage.input = 10000;
    record.stats.lifetimeUsage.output = 2000;
    record.stats.lifetimeUsage.cost = 0.25;
    record.stats.contextPercent = 65;
    record.execution.session!.model = { id: "m", provider: "p" } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Columns = 75: extreme pressure where context % and turns must drop to keep 40 chars
    tui.terminal.columns = 75;
    const line = selector.render(75).find((l: string) => l.includes("p/m"))!;

    expect(line).not.toContain("↑");
    expect(line).not.toContain("$");
    expect(line).not.toContain("65%");
    expect(line).not.toContain("8⟳");
    // Bottom line preserved: identity, tools, and duration
    expect(line).toContain("p/m");
    expect(line).toContain("5 calls");
    expect(line).toContain("<1s");
  });

  it("keeps normal command bar without Alt+S when agent is not taken over", () => {
      const record = makeRecord("agent-normal", "completed");
      record.execution.session = {
        messages: [{ role: "assistant", content: "Result text" }],
      } as any;

      const ui = makeUI({ value: "" });
      navigator = new AgentNavigator(makeManager([record]));
      navigator.setUICtx(ui.ctx as any);
      navigator.ensureTimer();
      const { selector } = mountSelector(ui);

      navigator.handleTerminalInput("\x1b[B");
      navigator.handleTerminalInput("\x1b[B");

      const command = stripAnsi(selector.render(120)[0]);
      expect(command).not.toContain("Alt+S");
      expect(command).toContain("Space Pin");
    });

  it("keeps normal command bar without Alt+S when takenOver agent has no messages", () => {
      const record = makeRecord("agent-empty", "completed");
      record.lifecycle.takenOver = true;
      record.lifecycle.pinnedAt = Date.now();
      record.execution.session = { messages: [] } as any;

      const ui = makeUI({ value: "" });
      navigator = new AgentNavigator(makeManager([record]));
      navigator.setUICtx(ui.ctx as any);
      navigator.ensureTimer();
      const { selector } = mountSelector(ui);

      navigator.handleTerminalInput("\x1b[B");
      navigator.handleTerminalInput("\x1b[B");

      const command = stripAnsi(selector.render(120)[0]);
      expect(command).not.toContain("Alt+S");
      expect(command).toContain("Space Unpin");
    });

  it("does not show Alt+S on Sticky Main or when focusing Main", () => {
      const record = makeRecord("agent-taken", "completed");
      record.lifecycle.takenOver = true;
      record.lifecycle.pinnedAt = Date.now();
      record.execution.session = {
        messages: [{ role: "assistant", content: "Result text" }],
      } as any;

      const ui = makeUI({ value: "" });
      navigator = new AgentNavigator(makeManager([record]));
      navigator.setUICtx(ui.ctx as any);
      navigator.ensureTimer();
      const { selector } = mountSelector(ui);

      navigator.handleTerminalInput("\x1b[B");

      const command = stripAnsi(selector.render(120)[0]);
      expect(command).not.toContain("Alt+S");
      expect(command).toBe(" ↑↓ Move · Enter Open · Ctrl+D Remove · Esc Editor");

      const lines = selector.render(120).map(stripAnsi);
      const stickyMain = lines.find((line: string) => line.includes("Main"));
      expect(stickyMain).not.toContain("Alt+S");
    });

  it("highlights focused rows with selectedBg and renders pin badges cleanly", () => {
    const r1 = makeRecord("agent-1");
    r1.lifecycle.pinnedAt = Date.now();
    const r2 = makeRecord("agent-2");
    const ui = makeUI({ value: "" });
    ui.theme.bg = vi.fn((color: string, text: string) => `[bg:${color}]${text}[/bg]`);
    navigator = new AgentNavigator(makeManager([r1, r2]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // Focus Main
    navigator.handleTerminalInput("\x1b[B");
    let lines = selector.render(120);
    expect(lines.find((l: string) => l.includes("Main"))).toContain("[bg:selectedBg]");

    // Focus agent-1 (pinned)
    navigator.handleTerminalInput("\x1b[B");
    lines = selector.render(120);
    const agent1Line = lines.find((l: string) => l.includes("agent-1") || l.includes("Explore"))!;
    expect(agent1Line).toContain("[bg:selectedBg]");
    expect(agent1Line).toContain("◆");
    expect(agent1Line).not.toContain("›");
  });

  it("preserves selectedBg background color across inner ANSI SGR resets", () => {
    const record = makeRecord("agent-long");
    record.display.description = "A".repeat(200); // Guarantees truncation with ellipsis and SGR reset
    const ui = makeUI({ value: "" });
    ui.theme.bg = vi.fn((_color: string, text: string) => `\x1b[44m${text}\x1b[49m`);
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // Focus Main
    navigator.handleTerminalInput("\x1b[B"); // Focus agent-long
    const lines = selector.render(120);
    const highlightedRow = lines.find((l: string) => l.includes("Explore"))!;
    expect(highlightedRow).toContain("\x1b[44m");
    // Ensure every \x1b[0m has the background code re-asserted immediately
    expect(highlightedRow).not.toMatch(/\x1b\[0m(?!\x1b\[44m)/);
  });
});
