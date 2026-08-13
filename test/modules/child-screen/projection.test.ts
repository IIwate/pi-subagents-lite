import { describe, expect, it } from "vitest";
import {
  createChildScreen,
  lineText,
  type ChildRecordSummary,
  type ChildScreen,
  type NavigatorSnapshot,
} from "../../../src/modules/child-screen/public.js";

function record(overrides: Partial<ChildRecordSummary> = {}): ChildRecordSummary {
  return {
    id: "agent-12345678",
    status: "running",
    type: "Explore",
    description: "Inspect the project",
    pinned: false,
    ...overrides,
  };
}

function stats(overrides: Partial<NonNullable<ChildRecordSummary["stats"]>> = {}) {
  return {
    toolUses: 0,
    turnCount: 0,
    input: 0,
    output: 0,
    cost: 0,
    compactionCount: 0,
    ...overrides,
  };
}

function identity() {
  return { providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" };
}

function project(
  screen: ChildScreen,
  options: { columns?: number; rows?: number; now?: number } = {},
): NavigatorSnapshot {
  const result = screen.execute({
    kind: "project",
    columns: options.columns ?? 120,
    rows: options.rows ?? 40,
    now: options.now ?? 0,
  });
  if (!result.ok) throw new Error(`projection failed: ${result.error.message}`);
  return result.snapshot;
}

function listTexts(snapshot: NavigatorSnapshot): string[] {
  return (snapshot.listLines ?? []).map(lineText);
}

function footerText(snapshot: NavigatorSnapshot): string | undefined {
  return snapshot.footerStatus?.map((part) => part.text).join("");
}

describe("REQ-CHILD-002 expanded list projection", () => {
  it("projects the Main summary with counts and never leaks record ids", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });

    const snapshot = project(screen);
    const lines = listTexts(snapshot);
    expect(lines[0]).toBe("  ● Main (1 running · 1 total · Alt+A collapse)");
    expect(lines.join("\n")).not.toContain("agent-12345678");
    expect(snapshot.footerStatus).toBeUndefined();
  });

  it("hides zero running and queued counts when only terminal records remain", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [
        record({ id: "done-1", status: "completed" }),
        record({ id: "done-2", status: "completed" }),
      ],
    });

    const lines = listTexts(project(screen));
    expect(lines[0]).toBe("  ● Main (2 total · Alt+A collapse)");
  });

  it("shows nonzero pending results inline and hides zero", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()], pendingResultCount: 3 });
    expect(listTexts(project(screen))[0]).toBe(
      "  ● Main (1 running · 1 total · 3 results pending · Alt+A collapse)",
    );

    screen.execute({ kind: "replace-records", records: [record()] });
    const cleared = listTexts(project(screen)).join("\n");
    expect(cleared).not.toContain("results pending");
    expect(cleared).not.toContain("result pending");
  });

  it("shows an error row and an undelivered result independently", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-needs-input", status: "error", error: "temporary provider failure" })],
      pendingResultCount: 1,
    });

    const lines = listTexts(project(screen));
    expect(lines[0]).toBe("  ● Main (1 total · 1 result pending · Alt+A collapse)");
    expect(lines.join("\n")).toContain("(Error)");
    expect(lines.join("\n")).not.toContain("needs input");
  });

  it("keeps Main sticky with complete counts and six visible rows", () => {
    const records = Array.from({ length: 8 }, (_, index) => record({
      id: `agent-${index}`,
      status: index < 2 ? "running" : index === 2 ? "queued" : "completed",
      description: `Task ${index}`,
    }));
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records });

    let lines = listTexts(project(screen));
    expect(lines[0]).toBe("  ● Main (2 running · 1 queued · 8 total · Alt+A collapse)");
    expect(lines.filter((line) => line.includes("Task "))).toHaveLength(6);

    screen.execute({ kind: "select", agentId: "agent-7" });
    lines = listTexts(project(screen));
    expect(lines[0]).toBe("  ○ Main (2 running · 1 queued · 8 total · Alt+A collapse · Alt+M main)");
    expect(lines).toContain("  ↑ 2 hidden");
    expect(lines.filter((line) => line.includes("Task "))).toHaveLength(6);
  });

  it("preserves record order without moving Main, including pinned rows", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [
        record({ id: "agent-done", status: "completed", description: "Done task", pinned: true }),
        record({ id: "agent-running", status: "running", description: "Running task" }),
        record({ id: "agent-blocked", status: "error", description: "Blocked task" }),
      ],
    });

    const lines = listTexts(project(screen));
    expect(lines[0]).toContain("Main");
    const doneIndex = lines.findIndex((line) => line.includes("Done task"));
    const runningIndex = lines.findIndex((line) => line.includes("Running task"));
    const blockedIndex = lines.findIndex((line) => line.includes("Blocked task"));
    expect(lines[doneIndex]).toContain("◇");
    expect(doneIndex).toBeLessThan(runningIndex);
    expect(runningIndex).toBeLessThan(blockedIndex);
  });

  it("keeps each status label adjacent to its description column", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [
        record({
          id: "agent-running",
          description: "Active task",
          invocation: identity(),
          stats: stats({ toolUses: 1 }),
        }),
        record({
          id: "agent-blocked",
          status: "error",
          description: "Blocked task",
          error: "content was flagged",
          stats: stats({ toolUses: 81 }),
        }),
      ],
    });

    const lines = listTexts(project(screen));
    const runningRow = lines.find((line) => line.includes("Active task"))!;
    const blockedRow = lines.find((line) => line.includes("Blocked task"))!;
    expect(runningRow).toMatch(/Explore \(Running\) {2}Active task/);
    expect(blockedRow).toMatch(/Explore \(Error\) {2}Blocked task/);
    expect(runningRow).toContain("openai-test · gpt-test · high");
  });

  it("keeps the Error label visible when a narrow terminal truncates other columns", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        id: "agent-blocked",
        status: "error",
        error: "content was flagged",
        description: "A very long security audit description",
      })],
    });

    const row = listTexts(project(screen, { columns: 42 })).find((line) => line.includes("Error"))!;
    expect(row).toContain("Error");
    expect(row).not.toContain("security audit description");
  });

  it("preserves status and provider-first identity space for a long display name", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        id: "agent-long",
        displayName: "Extremely Long Custom Agent Display Name",
        invocation: identity(),
      })],
    });

    const text = listTexts(project(screen, { columns: 42 })).join("\n");
    expect(text).toContain("(Running)");
    expect(text).toContain("openai-test");
    expect(text).toContain("gpt-tes");
  });

  it("marks debug-fault records with an accented DEBUG badge", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        id: "agent-debug",
        status: "error",
        debugFaultKind: "output_blocked",
        error: "debug injected: content was flagged",
      })],
    });

    const snapshot = project(screen);
    const text = listTexts(snapshot).join("\n");
    expect(text).toContain("Explore [DEBUG] (Error)");
    expect(text).not.toContain("Error (Debug)");
    const badge = snapshot.listLines!
      .flatMap((line) => line.parts)
      .find((part) => part.text === "[DEBUG]");
    expect(badge).toEqual({ text: "[DEBUG]", color: "accent", bold: true });
  });

  it("renders pinned indicators with the accent color role", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record({ status: "completed", pinned: true })] });
    const inactive = project(screen).listLines!
      .flatMap((line) => line.parts)
      .find((part) => part.text === "◇");
    expect(inactive).toEqual({ text: "◇", color: "accent" });

    screen.execute({ kind: "select", agentId: "agent-12345678" });
    const active = project(screen).listLines!
      .flatMap((line) => line.parts)
      .find((part) => part.text === "◆");
    expect(active).toEqual({ text: "◆", color: "accent" });
  });

  it("shows focus hints that follow the highlighted row's pin state", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    expect(listTexts(project(screen))[0]).toBe(
      "  ↑↓ Move · Enter Open · Ctrl+D Remove · Esc Editor",
    );

    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    expect(listTexts(project(screen))[0]).toBe(
      "  ↑↓ Move · Enter Open · Space Pin · Ctrl+D Remove · Esc Editor",
    );

    screen.execute({ kind: "replace-records", records: [record({ pinned: true })] });
    expect(listTexts(project(screen))[0]).toBe(
      "  ↑↓ Move · Enter Open · Space Unpin · Ctrl+D Remove · Esc Editor",
    );
  });

  it("renders the clear confirmation prompt for the highlighted record", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "down", editorEmpty: true });
    screen.execute({ kind: "key", key: "ctrl-d", editorEmpty: true });

    expect(listTexts(project(screen))[0]).toBe(
      "  Remove “Inspect the project”? · Enter Remove · Esc Cancel",
    );
  });

  it("respects the statsVisibility showCost toggle", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ stats: stats({ cost: 0.05 }) })],
    });
    expect(listTexts(project(screen)).join("\n")).toContain("$0.05");

    screen.execute({ kind: "set-stats-visibility", visibility: { showCost: false } });
    expect(listTexts(project(screen)).join("\n")).not.toContain("$");
  });

  it("right-aligns elapsed time within the full row width", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ startedAt: 85_000, invocation: identity(), stats: stats() })],
    });

    const row = listTexts(project(screen, { now: 100_000 }))[1];
    expect(row).toMatch(/○ Explore \(Running\) {2}Inspect the project/);
    expect(row).toHaveLength(120);
    expect(row).toMatch(/15s$/);
  });

  it.each([
    ["queued", "Queued"],
    ["running", "Running"],
    ["completed", "Done"],
    ["turn_limited", "Turn limit"],
    ["aborted", "Aborted"],
    ["stopped", "Stopped"],
    ["error", "Error"],
  ] as const)("renders %s records with the %s label", (status, label) => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record({ status })] });

    expect(listTexts(project(screen)).join("\n")).toContain(`(${label})`);
  });

  it("previews a debug status without mutating record state", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });

    screen.execute({ kind: "set-debug-preview", status: "error" });
    const previewed = project(screen);
    expect(listTexts(previewed).join("\n")).toContain("(Error)");
    expect(previewed.records[0]!.status).toBe("running");

    screen.execute({ kind: "set-debug-preview" });
    expect(listTexts(project(screen)).join("\n")).toContain("(Running)");
  });
});

describe("REQ-CHILD-002 folded footer status", () => {
  it("summarizes a single running record when folded", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "toggle-fold" });

    const snapshot = project(screen);
    expect(footerText(snapshot)).toBe("Subagent (1 running · 1 total · Alt+A expand)");
    expect(snapshot.listLines).toBeUndefined();
  });

  it("pluralizes the title and counts queued records when folded", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ id: "agent-1" }), record({ id: "agent-2", status: "queued" })],
    });
    screen.execute({ kind: "toggle-fold" });

    expect(footerText(project(screen))).toBe(
      "Subagents (1 running · 1 queued · 2 total · Alt+A expand)",
    );
  });

  it("omits count segments for terminal-only records when folded", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({ status: "error", error: "503 service unavailable" })],
    });
    screen.execute({ kind: "toggle-fold" });

    expect(footerText(project(screen))).toBe("Subagent (1 total · Alt+A expand)");
  });

  it("appends the Main shortcut while a Child stays selected", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-12345678" });
    screen.execute({ kind: "toggle-fold" });

    expect(footerText(project(screen))).toBe(
      "Subagent (1 running · 1 total · Alt+A expand · Alt+M main)",
    );
  });

  it("replaces counts with the interaction notice in both presentations", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    screen.execute({ kind: "select", agentId: "agent-12345678" });
    screen.execute({
      kind: "set-interaction-notice",
      notice: "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
    });

    const expanded = project(screen);
    expect(listTexts(expanded)[0]).toBe(
      "  ○ Main (Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached · Alt+A collapse · Alt+M main)",
    );

    screen.execute({ kind: "toggle-fold" });
    const folded = project(screen);
    expect(footerText(folded)).toBe(
      "Subagent (Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached · Alt+A expand · Alt+M main)",
    );
    const notice = folded.footerStatus!.find((part) => part.text.startsWith("Blocked:"));
    expect(notice).toEqual({
      text: "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
      color: "warning",
      bold: true,
    });
  });

  it("omits the footer status while expanded or without visible work", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record()] });
    expect(project(screen).footerStatus).toBeUndefined();

    screen.execute({ kind: "toggle-fold" });
    screen.execute({ kind: "replace-records", records: [] });
    expect(project(screen).footerStatus).toBeUndefined();
  });
});

describe("REQ-CHILD-004 transcript projection", () => {
  const sessionBase = { found: true, live: true, streaming: false } as const;

  it("shows queue waiting text before the child session exists", () => {
    const screen = createChildScreen();
    screen.execute({ kind: "replace-records", records: [record({ status: "queued" })] });
    screen.execute({ kind: "select", agentId: "agent-12345678" });

    const text = project(screen).transcriptLines!.map(lineText).join("\n");
    expect(text).toContain("Explore (Queued)");
    expect(text).toContain("Waiting in queue…");
    expect(text).not.toContain("agent-12");
    expect(text).not.toContain("Starting agent session…");
  });

  it("shows a start failure without a session as an error line", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        status: "error",
        error: "Automatic model override is no longer authorized",
      })],
    });
    screen.execute({ kind: "select", agentId: "agent-12345678" });

    const text = project(screen).transcriptLines!.map(lineText).join("\n");
    expect(text).toContain("Explore (Error)");
    expect(text).toContain("Error: Automatic model override is no longer authorized");
    expect(text).not.toContain("Starting agent session…");
  });

  it("renders the session conversation under the Error status label", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        status: "error",
        error: "503 service unavailable",
        session: {
          ...sessionBase,
          messages: [
            { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "I should inspect files." },
                { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
                { type: "text", text: "I found the project structure." },
              ],
            },
            {
              role: "toolResult",
              toolName: "read",
              isError: false,
              content: [{ type: "text", text: "# Project" }],
            },
          ],
        },
      })],
    });
    screen.execute({ kind: "select", agentId: "agent-12345678" });

    const text = project(screen).transcriptLines!.map(lineText).join("\n");
    expect(text).toContain("Explore (Error)");
    expect(text).not.toContain("agent-12");
    expect(text).toContain("Inspect the project");
    expect(text).toContain("I should inspect files.");
    expect(text).toContain("read");
    expect(text).toContain("I found the project structure.");
    expect(text).toContain("# Project");
    expect(text).toContain("Error: 503 service unavailable");
  });

  it("labels debug-fault transcripts with the DEBUG badge and no id", () => {
    const screen = createChildScreen();
    screen.execute({
      kind: "replace-records",
      records: [record({
        id: "agent-debug",
        status: "error",
        debugFaultKind: "output_blocked",
        error: "debug injected: content was flagged",
      })],
    });
    screen.execute({ kind: "select", agentId: "agent-debug" });

    const lines = project(screen).transcriptLines!.map(lineText);
    expect(lines[0]).toBe("Explore [DEBUG] (Error)");
    expect(lines.join("\n")).not.toContain("agent-de");
  });
});
