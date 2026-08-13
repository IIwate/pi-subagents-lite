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

const {
  mockListAgents,
  mockGetRecord,
  mockGetStoredResult,
  mockMarkResultPresented,
} = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockGetRecord: vi.fn(),
  mockGetStoredResult: vi.fn(),
  mockMarkResultPresented: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("../../src/shell.js", () => shellMock({
  manager: {
    listSnapshots: mockListAgents,
    getSnapshot: mockGetRecord,
  },
  delivery: {
    getStoredResult: mockGetStoredResult,
    execute: (command: { kind?: string; deliveryId?: string }) => {
      if (command.kind === "mark-presented" && command.deliveryId) {
        mockMarkResultPresented(command.deliveryId);
      }
      return { ok: true };
    },
  },
}));

// Load the module graph during collection; the per-test dynamic imports then
// hit the cache instead of charging the first test's timeout with it.
import "../../src/agents/agent-status.js";

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
      type: "reviewer",
      invocation: { providerName: "openai", modelName: "gpt-test" },
      status: "completed",
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
  });

  it("rejects an ID prefix instead of resolving it", async () => {
    mockGetRecord.mockImplementation((id: string) => id === "agent-12345678" ? {
      id,
      type: "reviewer",
      invocation: {},
      status: "completed",
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
      type: "reviewer",
      invocation: {},
      status: "error",
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
      { id: "abc123def456ghi", type: "builder", status: "running" },
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
      { id: "aaa111bbb222ccc", type: "builder", status: "running" },
      { id: "ddd333eee444fff", type: "reviewer", status: "completed" },
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
      type: "builder",
      status: "error",
      debugFaultKind: "output_blocked",
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
  });

  it("renders all status types in the output", async () => {
    mockListAgents.mockReturnValue([
      { id: "id1", type: "a", status: "running" },
      { id: "id2", type: "b", status: "queued" },
      { id: "id3", type: "c", status: "completed" },
      { id: "id4", type: "d", status: "stopped" },
      { id: "id5", type: "e", status: "error" },
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
      { id: "a-very-long-agent-id-that-exceeds-short-length", type: "reviewer", status: "completed" },
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
