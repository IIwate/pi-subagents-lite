import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNavigator } from "../../../src/ui/agent-navigator.js";
import type { NavigationReply } from "../../../src/ui/navigation.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { makeSource, makeRecord, makeUI, mountSelector } from "../../support/navigator.js";

describe("Navigation action ownership", () => {
  let resources: TestHarness;
  beforeEach(() => { resources = createTestHarness(); });
  afterEach(() => resources.dispose());

  function mount() {
    const record = makeRecord();
    record.execution.session.getSteeringMessages = () => ["Pending correction"];
    const result = Promise.withResolvers<NavigationReply>();
    const source = makeSource([record]);
    const dispatch = vi.fn(() => result.promise);
    const navigator = new AgentNavigator(source, dispatch);
    resources.onDispose(() => navigator.dispose());
    const ui = makeUI({ value: "" });
    navigator.setUICtx(ui.ctx);
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\r");
    return { record, result, source, dispatch, navigator, ui, selector };
  }

  it("does not restore or resubmit a queued input that was already consumed", async () => {
    const { navigator, result, ui, selector, dispatch } = mount();
    expect(navigator.handleTerminalInput("\x1b[1;3A")).toEqual({ consume: true });
    ui.baseEditor.setText("New draft");
    result.resolve({ accepted: false, reason: "already_consumed" });
    await result.promise;
    expect(ui.baseEditor.getText()).toBe("New draft");
    expect(selector.render(120).join("\n")).toContain("already consumed");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("retains withdrawn input for its original target after the user returns to Main", async () => {
    const { navigator, result, ui, dispatch } = mount();
    navigator.handleEditorDequeue();
    navigator.activateMain();
    ui.baseEditor.setText("Main draft");
    result.resolve({ accepted: true, restored: [{ text: "Withdrawn correction" }] });
    await result.promise;
    expect(ui.baseEditor.getText()).toBe("Main draft");
    ui.baseEditor.setText("");
    navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\r");
    navigator.handleEditorDequeue();
    expect(ui.baseEditor.getText()).toBe("Withdrawn correction");
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
