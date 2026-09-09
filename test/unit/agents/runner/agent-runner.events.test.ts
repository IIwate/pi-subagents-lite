/**
 * agent-runner.events.test.ts — Usage extraction and notification buffering tests.
 *
 * Covers:
 *   - Token and cost usage extraction from message_end events
 *   - Tool result usage and compaction usage accumulation
 *   - Notification buffering (deferring UI notices until after the turn loop completes)
 */

import { describe, expect, it, vi } from "vitest";
import { asSession, createMockSession } from "../../../support/runner.js";
import { subscribeToSessionEvents } from "../../../../src/agents/agent-runner.js";

describe("AgentRunner — Event Subscriptions & Usage", () => {
  it("extracts u.cost?.total from assistant message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asSession(session), { onAssistantUsage });

    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: 2.5 } },
      },
    } as any);

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cost: 2.5,
    });
    unsub();
  });

  it("includes nested usage reported by tool results", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(asSession(session), { onAssistantUsage });

    session.emit({
      type: "message_end",
      message: {
        role: "toolResult",
        usage: { input: 20, output: 10, cacheWrite: 5, cost: { total: 0.75 } },
      },
    } as any);

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 20,
      output: 10,
      cacheWrite: 5,
      cost: 0.75,
    });
    unsub();
  });

  it("includes usage from successful compactions", () => {
    const onAssistantUsage = vi.fn();
    const onCompaction = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(asSession(session), { onAssistantUsage, onCompaction });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: {
        usage: { input: 30, output: 15, cacheWrite: 0, cost: { total: 1.25 } },
      },
    } as any);

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 30,
      output: 15,
      cacheWrite: 0,
      cost: 1.25,
    });
    expect(onCompaction).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("defaults cost to 0 when message.usage has no cost field", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asSession(session), { onAssistantUsage });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10 },
      },
    } as any);

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cost: 0,
    });
    unsub();
  });

  it("does not fire onAssistantUsage for user message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asSession(session), { onAssistantUsage });
    session.emit({
      type: "message_end",
      message: {
        role: "user",
        content: "Hello",
        usage: { input: 0, output: 0, cacheWrite: 0, cost: { total: 100 } },
      },
    } as any);

    expect(onAssistantUsage).not.toHaveBeenCalled();
    unsub();
  });
});
