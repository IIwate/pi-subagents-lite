/**
 * agent-status-tool.test.ts — Execute behavior tests for the AgentStatus tool.
 *
 * Tests the executeAgentStatusTool handler with a mocked manager.
 * Schema tests live in index.test.ts (which doesn't mock index.js).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Module-level mock variables — defined before vi.mock calls so they  */
/*  are available when hoisted mock factories run.                      */
/* ------------------------------------------------------------------ */

const mockListAgents = vi.fn();
const mockGetRecord = vi.fn();
const mockGetStoredResult = vi.fn();
const mockMarkResultPresented = vi.fn();

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("../../src/shell.js", () => shellMock({
  manager: {
    listAgents: mockListAgents,
    getRecord: mockGetRecord,
  },
  coordinator: {
    getStoredResult: mockGetStoredResult,
    markResultPresented: mockMarkResultPresented,
  },
}));

/* ------------------------------------------------------------------ */
/*  Execute behavior tests                                            */
/* ------------------------------------------------------------------ */

describe("AgentStatus tool execute behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRecord.mockReturnValue(undefined);
    mockGetStoredResult.mockReturnValue(undefined);
  });

  it("looks up one exact result without polling", async () => {
    mockGetRecord.mockReturnValue({
      id: "agent-12345678",
      display: { type: "reviewer", invocation: { providerName: "openai", modelName: "gpt-test" } },
      lifecycle: { status: "completed" },
      execution: {},
      result: "Review-Result: PASS",
    });

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");
    const result = await executeAgentStatusTool(
      "call_exact",
      { agent_id: "agent-12345678" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("Agent agent-12345678: completed");
    expect(result.content[0].text).toContain("Provider: openai");
    expect(result.content[0].text).toContain("Model: gpt-test");
    expect(result.content[0].text).toContain("Review-Result: PASS");
    expect(result.content[0].text).toContain("Needs input: no");
  });

  it("rejects an ID prefix instead of resolving it", async () => {
    mockGetRecord.mockImplementation((id: string) => id === "agent-12345678" ? {
      id,
      display: { type: "reviewer", invocation: {} },
      lifecycle: { status: "completed" },
      execution: {},
      result: "done",
    } : undefined);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");
    const result = await executeAgentStatusTool(
      "call_prefix",
      { agent_id: "agent-1234" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionId: () => "test-session",
          getEntries: () => [],
        },
      } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown agent: agent-1234");
  });

  it("uses the durable result when a live record has no result text", async () => {
    mockGetRecord.mockReturnValue({
      id: "agent-12345678",
      display: { type: "reviewer", invocation: {} },
      lifecycle: { status: "error" },
      execution: {},
      result: undefined,
      error: "temporary failure",
    });
    mockGetStoredResult.mockReturnValue({
      agentId: "agent-12345678",
      type: "reviewer",
      status: "error",
      result: "durable final result",
      error: null,
      provider: "cliproxyapi",
      model: "gpt-test",
      deliveryId: "delivery-1",
      parentSessionId: "test-session",
      originEntryId: "origin-a",
      createdAt: 1,
      delivery: "auto",
    });

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");
    const result = await executeAgentStatusTool(
      "call_durable",
      { agent_id: "agent-12345678" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("durable final result");
    expect(result.content[0].text).toContain("Provider: cliproxyapi");
    expect(mockMarkResultPresented).toHaveBeenCalledWith("delivery-1");
  });

  it("returns empty state message when no agents exist", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_1",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("No agents");
    expect(result.content[0].text).toContain("Don't poll");
    expect(result.isError).toBeUndefined();
  });

  it("formats each agent as {id} ({type}) {status}", async () => {
    mockListAgents.mockReturnValue([
      { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_2",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    expect(text).toContain("abc123def456ghi (builder) running");
    expect(text).toContain("Don't poll");
  });

  it("separates multiple agents with commas", async () => {
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_3",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    expect(text).toContain(
      "aaa111bbb222ccc (builder) running, ddd333eee444fff (reviewer) completed",
    );
    expect(text).toContain("Don't poll");
  });

  it("does not expose Debug diagnostics to the parent LLM", async () => {
    mockListAgents.mockReturnValue([{
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "error" },
      execution: {
        debugFaultKind: "output_blocked",
        recoveryTtlMs: 10_000,
        recoveryExpiryPausedRemainingMs: 8_000,
      },
    }]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");
    const result = await executeAgentStatusTool(
      "call_debug",
      {},
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    const lowerText = text.toLowerCase();
    expect(text).toContain("abc123def456ghi (builder) error");
    expect(lowerText).not.toContain("debug");
    expect(lowerText).not.toContain("output_blocked");
    expect(lowerText).not.toContain("recovery");
  });

  it("renders all status types in the output", async () => {
    mockListAgents.mockReturnValue([
      { id: "id1", display: { type: "a" }, lifecycle: { status: "running" } },
      { id: "id2", display: { type: "b" }, lifecycle: { status: "queued" } },
      { id: "id3", display: { type: "c" }, lifecycle: { status: "completed" } },
      { id: "id4", display: { type: "d" }, lifecycle: { status: "stopped" } },
      { id: "id5", display: { type: "e" }, lifecycle: { status: "error" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_4",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    // Contract: each agent entry matches the format pattern with its status
    expect(text).toMatch(/id1 \(a\) running/);
    expect(text).toMatch(/id2 \(b\) queued/);
    expect(text).toMatch(/id3 \(c\) completed/);
    expect(text).toMatch(/id4 \(d\) stopped/);
    expect(text).toMatch(/id5 \(e\) error/);
    expect(text).toContain("Don't poll");
  });

  it("always includes nudge message", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_5",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("Don't poll, sleep, or timeout-wait — background results are delivered automatically.");
  });

  it("keeps the full internal ID for follow-up tool calls", async () => {
    mockListAgents.mockReturnValue([
      { id: "a-very-long-agent-id-that-exceeds-short-length", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_6",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain(
      "a-very-long-agent-id-that-exceeds-short-length (reviewer) completed",
    );
  });

  it("returns no error flag on success", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_7",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeUndefined();
  });
});
