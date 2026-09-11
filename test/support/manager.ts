/**
 * Shared fixtures and helpers for AgentManager tests.
 */

import { vi } from "vitest";
import type { AgentManager, SpawnOptions } from "../../src/agents/agent-manager.js";

export function mockAgentSession(): any {
  return {
    subscribe: vi.fn(() => vi.fn()),
    messages: [],
    agent: { state: {} },
    isStreaming: false,
    dispose: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    extensionRunner: { emit: vi.fn().mockResolvedValue(undefined) },
  };
}

/** Emitted shutdown events for a mock session, in emit order. */
export function shutdownEvents(session: any): any[] {
  return session.extensionRunner.emit.mock.calls
    .map(([event]: [any]) => event)
    .filter((event: any) => event?.type === "session_shutdown");
}

export function mockRunResult(overrides?: Record<string, any>) {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    turnLimited: false,
    ...overrides,
  };
}

export function fakeOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    description: "task",
    acceptedPolicy: {
      definition: { name: "general-purpose", description: "test", systemPrompt: "test" },
      registeredTools: ["read", "bash"],
      restrictToRegisteredTools: false,
      tools: undefined,
      extensions: true,
      skills: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "test/model",
    },
    ...overrides,
  };
}

export async function disposeManager(manager: AgentManager | undefined): Promise<void> {
  const disposed = manager?.dispose();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(15_000);
  await disposed;
}
