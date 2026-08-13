import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  NavigatorCommandResultSchema,
  createChildScreen,
  lineText,
  type ChildRecordSummary,
} from "../../../src/modules/child-screen/public.js";

function record(overrides: Partial<ChildRecordSummary> = {}): ChildRecordSummary {
  return {
    id: "agent-1",
    status: "running",
    type: "reviewer",
    description: "Inspect the project",
    pinned: false,
    ...overrides,
  };
}

describe("REQ-CHILD-001 Main and Child navigation", () => {
  it("selects a Child and returns to Main without changing fold state", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    const selected = screen.execute({ kind: "select", agentId: "agent-1" });
    expect(Check(NavigatorCommandResultSchema, JSON.parse(JSON.stringify(selected)))).toBe(true);
    expect(selected).toMatchObject({
      ok: true,
      snapshot: {
        selectedAgentId: "agent-1",
        highlightedAgentId: "agent-1",
        listExpanded: true,
        visible: true,
      },
    });

    const main = screen.execute({ kind: "select", agentId: null });
    expect(main).toMatchObject({
      ok: true,
      snapshot: {
        selectedAgentId: null,
        highlightedAgentId: null,
        listExpanded: true,
      },
    });
  });

  it("rejects selecting a Subagent that is not in the current list", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    expect(screen.execute({ kind: "select", agentId: "missing" })).toEqual({
      ok: false,
      error: { code: "not-found", message: "Selected Subagent is not in the current list." },
    });
  });

  it("returns to Main when the selected record disappears", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-1" });
    const cleared = screen.execute({ kind: "replace-records", records: [] });
    expect(cleared).toMatchObject({
      ok: true,
      snapshot: {
        selectedAgentId: null,
        highlightedAgentId: null,
        visible: false,
      },
    });
  });

  it("returns to Main when only the active record disappears", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-active" }), record({ id: "agent-remaining", status: "completed" })],
    });
    screen.execute({ kind: "select", agentId: "agent-active" });

    const shrunk = screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-remaining", status: "completed" })],
    });
    expect(shrunk).toMatchObject({
      ok: true,
      snapshot: {
        selectedAgentId: null,
        highlightedAgentId: null,
        visible: true,
      },
    });
  });

  it("requires Enter before changing the active Child", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    const highlighted = screen.execute({ kind: "key", key: "down", editorEmpty: true });
    expect(highlighted).toMatchObject({
      ok: true,
      snapshot: { selectedAgentId: null, highlightedAgentId: "agent-1" },
    });

    expect(screen.execute({ kind: "key", key: "enter", editorEmpty: true })).toMatchObject({
      ok: true,
      snapshot: { selectedAgentId: "agent-1" },
    });
  });

  it("keeps list focus after confirmation so Up navigates without re-entering", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "enter", editorEmpty: true });

    const moved = screen.execute({ kind: "key", key: "up", editorEmpty: true });
    expect(moved).toMatchObject({
      ok: true,
      consume: true,
      snapshot: {
        selectedAgentId: "agent-1",
        highlightedAgentId: null,
        listFocused: true,
      },
    });
  });

  it("Escape cancels a highlighted candidate without switching", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });

    const cancelled = screen.execute({ kind: "key", key: "escape", editorEmpty: true });
    expect(cancelled).toMatchObject({
      ok: true,
      consume: true,
      snapshot: { selectedAgentId: null, listFocused: false },
    });
  });

  it("does not enter the list while the editor contains text", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });

    expect(screen.execute({ kind: "key", key: "down", editorEmpty: false })).toMatchObject({
      ok: true,
      consume: false,
      snapshot: { listFocused: false, selectedAgentId: null },
    });
  });

  it("returns focus to the editor on printable input without consuming it", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });

    expect(screen.execute({ kind: "key", key: "printable", editorEmpty: true })).toMatchObject({
      ok: true,
      consume: false,
      snapshot: { listFocused: false },
    });
  });

  it("switches views without mutating record lifecycle state", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ status: "error", error: "content was flagged" })],
    });
    screen.execute({ kind: "select", agentId: "agent-1" });
    const back = screen.execute({ kind: "select", agentId: null });
    expect(back.ok && back.snapshot.records[0]!.status).toBe("error");
  });
});

describe("REQ-CHILD-001 clear confirmation", () => {
  function focusedScreen() {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [
        record({ id: "agent-11111111", description: "Inspect the project" }),
        record({ id: "agent-22222222", description: "Second task" }),
      ],
    });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    return screen;
  }

  it("Ctrl+D then Enter emits a clear effect and the follow-up highlight index", () => {
    const screen = focusedScreen();
    const confirming = screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true });
    expect(confirming).toMatchObject({
      ok: true,
      consume: true,
      snapshot: { confirmingClearId: "agent-11111111" },
    });

    const cleared = screen.execute({ kind: "key", key: "enter", editorEmpty: true });
    expect(cleared).toMatchObject({
      ok: true,
      consume: true,
      effect: { type: "clear", agentId: "agent-11111111", index: 1 },
    });

    const moved = screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-22222222", description: "Second task" })],
      highlightIndex: 1,
    });
    expect(moved).toMatchObject({
      ok: true,
      snapshot: { highlightedAgentId: "agent-22222222", confirmingClearId: null },
    });
  });

  it("Ctrl+C cancels the confirmation and passes the key upward", () => {
    const screen = focusedScreen();
    screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true });

    const cancelled = screen.execute({ kind: "key", key: "ctrl-c", editorEmpty: true });
    expect(cancelled).toMatchObject({
      ok: true,
      consume: false,
      snapshot: { confirmingClearId: null },
    });
  });

  it("consumes unrelated keys while the confirmation is open", () => {
    const screen = focusedScreen();
    screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true });

    expect(screen.execute({ kind: "key", key: "down", editorEmpty: true })).toMatchObject({
      ok: true,
      consume: true,
      snapshot: { confirmingClearId: "agent-11111111", highlightedAgentId: "agent-11111111" },
    });
  });

  it("refuses to clear the active Child before returning to Main", () => {
    const screen = focusedScreen();
    screen.execute({ kind: "key", key: "enter", editorEmpty: true });

    expect(screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true })).toMatchObject({
      ok: true,
      consume: true,
      notify: {
        message: "Cannot clear the active subagent — switch to Main first",
        level: "warning",
      },
    });
  });
});

describe("REQ-CHILD-004 interaction requests", () => {
  it("issues increasing request ids only for the selected Child", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-1" });

    const begun = screen.execute({ kind: "begin-interaction", agentId: "agent-1" });
    expect(begun.ok && begun.interactionRequestId).toBeGreaterThan(0);
    expect(begun.ok && begun.snapshot.interactionRequestId).toBe(
      begun.ok ? begun.interactionRequestId : undefined,
    );

    const mismatched = screen.execute({ kind: "begin-interaction", agentId: "agent-other" });
    expect(mismatched.ok && mismatched.interactionRequestId).toBe(-1);
  });

  it("invalidates in-flight interactions when the selection changes", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-1" });
    const begun = screen.execute({ kind: "begin-interaction", agentId: "agent-1" });
    const requestId = begun.ok ? begun.interactionRequestId : -1;

    const back = screen.execute({ kind: "select", agentId: null });
    expect(back.ok && back.snapshot.interactionRequestId).not.toBe(requestId);
  });

  it("stores and clears the interaction notice with the selection", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-1" });
    screen.execute({ kind: "set-interaction-notice", notice: "Blocked: selected subagent is queued" });
    const inspected = screen.execute({ kind: "inspect" });
    expect(inspected.ok && inspected.snapshot.interactionNotice).toBe(
      "Blocked: selected subagent is queued",
    );

    const cleared = screen.execute({ kind: "select", agentId: null });
    expect(cleared.ok && cleared.snapshot.interactionNotice).toBeUndefined();
  });
});

describe("REQ-CHILD-002 expanded and folded presentation", () => {
  it("starts folded when the default expansion setting is off", () => {
    const screen = createChildScreen({ initialListExpanded: false });
    const result = screen.execute({
      kind: "replace-records",
      records: [record()],
    });
    expect(result).toMatchObject({
      ok: true,
      snapshot: { listExpanded: false, visible: true },
    });
  });

  it("projects the expanded Main row without Pi TUI", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ startedAt: 1 })],
    });
    const projected = screen.execute({ kind: "project", columns: 120, rows: 40, now: 1 });
    expect(projected.ok && projected.snapshot.listLines?.map(lineText).some((text) =>
      text.includes("● Main") && text.includes("1 running") && text.includes("Alt+A collapse"),
    )).toBe(true);
  });

  it("preserves the collapsed choice while the record list is empty", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "toggle-fold" });

    const emptied = screen.execute({ kind: "replace-records", records: [] });
    expect(emptied).toMatchObject({
      ok: true,
      snapshot: { listExpanded: false, visible: false },
    });

    const refilled = screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-next" })],
    });
    expect(refilled).toMatchObject({
      ok: true,
      snapshot: { listExpanded: false, visible: true },
    });
  });

  it("toggles fold only while records or pending results exist", () => {
    const screen = createChildScreen();
    expect(screen.execute({ kind: "toggle-fold" })).toMatchObject({
      ok: true,
      snapshot: { listExpanded: true, visible: false },
    });

    screen.execute({ kind: "replace-records", records: [record()] });
    const folded = screen.execute({ kind: "toggle-fold" });
    expect(folded).toMatchObject({
      ok: true,
      snapshot: { listExpanded: false, listFocused: false },
    });
  });

  it("moves highlight with keys and confirms Child selection", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    expect(screen.execute({ kind: "key", key: "down", editorEmpty: true })).toMatchObject({
      ok: true,
      consume: true,
      snapshot: { listFocused: true, highlightedAgentId: null },
    });
    expect(screen.execute({ kind: "key", key: "down", editorEmpty: true })).toMatchObject({
      ok: true,
      snapshot: { highlightedAgentId: "agent-1" },
    });
    expect(screen.execute({ kind: "key", key: "enter", editorEmpty: true })).toMatchObject({
      ok: true,
      snapshot: { selectedAgentId: "agent-1", listFocused: true },
    });
  });

  it("refuses to pin or clear Main", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    expect(screen.execute({ kind: "key", key: "space", editorEmpty: true })).toMatchObject({
      ok: true,
      notify: { message: "Cannot pin Main agent" },
    });
    expect(screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true })).toMatchObject({
      ok: true,
      notify: { message: "Cannot clear Main agent" },
    });
  });

  it("rejects a malformed command at the public seam", () => {
    const screen = createChildScreen();
    expect(screen.execute({ kind: "not-a-command" })).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Navigator command is invalid." },
    });
  });
});
