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
