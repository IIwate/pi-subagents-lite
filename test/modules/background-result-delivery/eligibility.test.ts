import { describe, expect, it } from "vitest";
import { buildResultMessage } from "../../../src/modules/background-result-delivery/core/eligibility.js";
import type { BackgroundResultRecord } from "../../../src/modules/background-result-delivery/public.js";

function record(overrides: Partial<BackgroundResultRecord> = {}): BackgroundResultRecord {
  return {
    deliveryId: "d1",
    parentSessionId: "session-a",
    originEntryId: "origin-a",
    agentId: "agent-1",
    type: "reviewer",
    status: "completed",
    result: "done",
    error: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("buildResultMessage parent injection", () => {
  it("leaves a short result intact without a truncation note", () => {
    const message = buildResultMessage([record({ result: "done" })]);

    expect(message).toEqual({
      customType: "subagent-result",
      content: '[Subagent "reviewer" agent-1 completed]\n\ndone',
      display: false,
    });
  });

  it("clips one long result body to 4000 characters and names AgentStatus for that agentId", () => {
    const body = `${"a".repeat(4000)}Z`;
    const message = buildResultMessage([record({ agentId: "agent-long", result: body })]);

    expect(message?.content).toContain("a".repeat(4000));
    expect(message?.content).not.toContain(body);
    expect(message?.content).toContain('… (truncated; use AgentStatus({ agent_id: "agent-long" }) to read the full result)');
  });

  it("applies the 4000-character limit to each result in a merged wake", () => {
    const first = `${"a".repeat(4000)}X`;
    const second = `${"b".repeat(4000)}Y`;
    const message = buildResultMessage([
      record({ deliveryId: "d1", agentId: "a1", result: first }),
      record({ deliveryId: "d2", agentId: "a2", result: second }),
    ]);

    expect(message?.content).toContain("a".repeat(4000));
    expect(message?.content).toContain("b".repeat(4000));
    expect(message?.content).not.toContain(first);
    expect(message?.content).not.toContain(second);
    expect(message?.content).toContain('AgentStatus({ agent_id: "a1" })');
    expect(message?.content).toContain('AgentStatus({ agent_id: "a2" })');
  });

  it("does not mutate the record that persist and AgentStatus still read", () => {
    const body = "z".repeat(5000);
    const item = record({ result: body });

    buildResultMessage([item]);

    expect(item.result).toBe(body);
  });
});
