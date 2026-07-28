/**
 * stop-agent.test.ts — Tests for executeStopAgentTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "../fixtures.ts";

const { mockAbort, mockGetRecord, mockListAgents } = vi.hoisted(() => ({
  mockAbort: vi.fn(() => false),
  mockGetRecord: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock("../../src/shell.js", () => shellMock({
  manager: {
    abort: mockAbort,
    getRecord: mockGetRecord,
    listAgents: mockListAgents,
  },
}));

// StopAgent does not use the spawn/model path. Stub those imports so this focused
// suite does not pay for tool-execution.ts's unrelated dependency graph.
vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: () => undefined,
  getAgentConfig: () => undefined,
  discoverNewAgents: async () => 0,
}));
vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: async () => ({ ok: false, error: "unused" }),
}));
vi.mock("../../src/utils.js", () => ({
  findModelInRegistry: () => undefined,
  parseThinkingLevel: () => undefined,
  parseModelSpec: () => ({ modelRef: undefined }),
  resolveExactModel: () => undefined,
  unknownModelError: () => "unused",
}));
vi.mock("../../src/models/model-scope.js", () => ({
  getActiveScopedModelKeys: () => null,
  isModelInScope: () => true,
  outOfScopeModelError: () => "unused",
  modelKey: ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`,
}));

import { executeStopAgentTool, formatResultContent } from "../../src/agents/tool-execution.js";

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
      lifecycle: { status, startedAt: 0, stoppedBy },
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
      lifecycle: { status: "error", startedAt: 0 },
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
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" }, execution: {}, stats: {} });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool("call_2", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(mockAbort).toHaveBeenCalledWith("abc123def456ghi", "agent");
    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("stops a queued agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({ id: "xyz789xyz789abc", display: { type: "reviewer" }, lifecycle: { status: "queued" }, execution: {}, stats: {} });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool("call_3", { agent_id: "xyz789xyz789abc" }, undefined, undefined, {} as any);

    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("returns error when agent ID not found, with running agents list", async () => {
    mockGetRecord.mockReturnValue(undefined);
    mockAbort.mockReturnValue(false);
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "running" } },
    ]);

    const result = await executeStopAgentTool("call_4", { agent_id: "nonexistent-id" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent-id not found");
    expect(result.content[0].text).toContain("Running agents:");
    expect(result.content[0].text).toContain("aaa111bb (builder)");
  });

  it("returns info when agent already completed", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "completed" }, execution: {}, stats: {} });
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "explorer" }, lifecycle: { status: "running" } },
    ]);

    const result = await executeStopAgentTool("call_5", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
  });

  it("returns info when agent already stopped", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "stopped" }, execution: {}, stats: {} });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool("call_6", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already stopped");
  });

  it("returns info when agent already aborted", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "aborted" }, execution: {}, stats: {} });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool("call_7", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already aborted");
  });

  it("running agents list shows only running/queued agents", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "completed" }, execution: {}, stats: {} });
    mockListAgents.mockReturnValue([
      { id: "r1", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "r2", display: { type: "reviewer" }, lifecycle: { status: "queued" } },
      { id: "r3", display: { type: "explore" }, lifecycle: { status: "completed" } },
      { id: "r4", display: { type: "code" }, lifecycle: { status: "stopped" } },
    ]);

    const result = await executeStopAgentTool("call_8", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any);

    expect(result.content[0].text).toContain("r1 (builder)");
    expect(result.content[0].text).toContain("r2 (reviewer)");
    expect(result.content[0].text).not.toContain("r3 (explore)");
    expect(result.content[0].text).not.toContain("r4 (code)");
  });
});
