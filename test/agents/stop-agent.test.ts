/**
 * stop-agent.test.ts — Tests for executeStopAgentTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeExtensionRuntime } from "../fixtures.ts";

import { createStopAgentToolExecutor, formatResultContent } from "../../src/agents/tool-execution.js";

const mockAbort = vi.fn(() => false);
const mockGetRecord = vi.fn();
const mockListAgents = vi.fn();

const executeStopAgentTool = createStopAgentToolExecutor(fakeExtensionRuntime({
  manager: {
    stop: mockAbort,
    getSnapshot: mockGetRecord,
    listSnapshots: mockListAgents,
  } as any,
}));

describe("formatResultContent", () => {
  // Only the composition contract lives here: result text, then the note as a
  // parenthetical suffix. The note wording is owned by status-note.test.ts —
  // pinning full sentences in both files meant one reword broke two suites.
  it.each([
    ["completed", undefined, ""],
    ["aborted", undefined, "HARD-STOPPED"],
    ["turn_limited", undefined, "wrapped up at the turn limit"],
    ["stopped", "user", "STOPPED BY THE USER"],
  ])("formats %s results with the status-note contract", (status, stoppedBy, noteFragment) => {
    const content = formatResultContent({
      result: "partial output",
      status,
      startedAt: 0,
      stoppedBy,
    } as any);

    if (!noteFragment) {
      expect(content).toBe("partial output");
      return;
    }
    expect(content).toMatch(/^partial output \(.+\)$/);
    expect(content).toContain(noteFragment);
  });

  it("formats terminal errors with their diagnostic", () => {
    expect(formatResultContent({
      error: "503 service_unavailable",
      status: "error",
      startedAt: 0,
    } as any)).toBe("Agent failed: 503 service_unavailable");
  });
});

describe("executeStopAgentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when agent_id is missing", async () => {
    const result = await executeStopAgentTool("call_1", {}, undefined, undefined, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("agent_id is required");
  });

  it("stops a running agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", status: "running" });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool("call_2", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(mockAbort).toHaveBeenCalledWith("abc123def456ghi", "agent");
    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("stops a queued agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({ id: "xyz789xyz789abc", type: "reviewer", status: "queued" });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool("call_3", { agent_id: "xyz789xyz789abc" }, undefined, undefined, {} as any);

    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("returns error when agent ID not found, with running agents list", async () => {
    mockGetRecord.mockReturnValue(undefined);
    mockAbort.mockReturnValue(false);
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", type: "builder", status: "running" },
      { id: "ddd333eee444fff", type: "reviewer", status: "running" },
    ]);

    const result = await executeStopAgentTool("call_4", { agent_id: "nonexistent-id" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent-id not found");
    expect(result.content[0].text).toContain("Running agents:");
    expect(result.content[0].text).toContain("aaa111bb (builder)");
  });

  it("returns info when agent already completed", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", status: "completed" });
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", type: "explorer", status: "running" },
    ]);

    const result = await executeStopAgentTool("call_5", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
  });

  it("returns info when agent already stopped", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", status: "stopped" });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool("call_6", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already stopped");
  });

  it("returns info when agent already aborted", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", status: "aborted" });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool("call_7", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already aborted");
  });

  it("running agents list shows only running/queued agents", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", status: "completed" });
    mockListAgents.mockReturnValue([
      { id: "r1", type: "builder", status: "running" },
      { id: "r2", type: "reviewer", status: "queued" },
      { id: "r3", type: "explore", status: "completed" },
      { id: "r4", type: "code", status: "stopped" },
    ]);

    const result = await executeStopAgentTool("call_8", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.content[0].text).toContain("r1 (builder)");
    expect(result.content[0].text).toContain("r2 (reviewer)");
    expect(result.content[0].text).not.toContain("r3 (explore)");
    expect(result.content[0].text).not.toContain("r4 (code)");
  });
});
