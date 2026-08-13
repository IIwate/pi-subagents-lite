import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/platform/pi/agent-session.js", () => ({
  runAgent: state.runAgent,
  continueAgentSession: vi.fn(),
}));

import type { SubagentRuntime } from "../../src/modules/subagent-runtime/public.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { takeFallbackResults } from "../../src/platform/process/process-state.js";
import {
  setDelivery,
  setManager,
  setPiInstance,
  setSessionCtx,
} from "../../src/shell.js";
import { createPiResultRepository } from "../../src/platform/pi/result-repository.js";
import {
  applyDeliveryCommand,
  createHostDelivery,
  isParentRunSuccessful,
  recordTerminalResult,
  spawnAgent,
} from "../../src/bootstrap/session-host.js";
import { acceptedRunPolicy } from "../fixtures.js";
import { createTestSubagentRuntime } from "../runtime-harness.js";

function createHost(runtime: SubagentRuntime) {
  const delivery = createHostDelivery();
  const run = (command: Parameters<typeof applyDeliveryCommand>[2]) =>
    applyDeliveryCommand(runtime, delivery, command);
  return {
    delivery,
    spawn: (ctx: any, intent: any) => spawnAgent(runtime, ctx, intent),
    restorePending: () => { run({ kind: "restore" }); },
    onParentAgentEnd: (messages: readonly { role: string; stopReason?: string; errorMessage?: string }[]) => {
      run({ kind: "parent-end", succeeded: isParentRunSuccessful(messages) });
    },
    onParentSettled: () => { run({ kind: "parent-settled" }); },
    pendingResultCount: () => delivery.pendingResultCount(),
    dispose: () => { run({ kind: "dispose" }); },
    bind: () => {
      setDelivery(delivery);
      runtime.setOnComplete((record) => recordTerminalResult(runtime, delivery, record));
    },
  };
}

function createSession() {
  return {
    model: { provider: "test", id: "model" },
    isStreaming: false,
    extensionRunner: { emit: vi.fn(async () => {}) },
    dispose: vi.fn(),
  } as any;
}

function createContext(sessionId: string, entries: any[]) {
  return {
    cwd: "/tmp/project",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "origin-a",
      getBranch: () => [{ id: "origin-a" }],
      getEntries: () => entries,
    },
  } as any;
}

function createPi(entries: any[], appendFails = false) {
  return {
    appendFails,
    appendEntry: vi.fn(function (this: { appendFails: boolean }, customType: string, data: unknown) {
      if (this.appendFails) throw new Error("stale parent session");
      entries.push({ type: "custom", customType, data });
    }),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
  } as any;
}

async function disposeRuntime(manager?: SubagentRuntime, host?: { dispose(): void }) {
  host?.dispose();
  await manager?.dispose();
  setDelivery(null);
  setManager(null);
}

describe("session-keyed delivery fallback", () => {
  afterEach(() => {
    takeFallbackResults("session-a");
    takeFallbackResults("session-b");
  });

  it("preserves A across B and restores one durable delivery when A returns", async () => {
    const entriesA: any[] = [];
    const entriesB: any[] = [];
    const ctxA = createContext("session-a", entriesA);
    const ctxB = createContext("session-b", entriesB);
    const piA = createPi(entriesA, true);
    const piB = createPi(entriesB);
    const session = createSession();
    state.runAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated(session);
      return { responseText: "result from A", session, aborted: false, turnLimited: false };
    });

    let managerA: SubagentRuntime | undefined;
    let managerB: SubagentRuntime | undefined;
    let hostA: ReturnType<typeof createHost> | undefined;
    let hostB: ReturnType<typeof createHost> | undefined;
    let restoredA: ReturnType<typeof createHost> | undefined;
    try {
      setSessionCtx(ctxA);
      setPiInstance(piA);
      managerA = createTestSubagentRuntime({ pi: piA, ctx: ctxA });
      setManager(managerA);
      hostA = createHost(managerA);
      hostA.bind();

      const spawned = await hostA.spawn(ctxA, {
        type: "reviewer",
        prompt: "review",
        description: "review",
        acceptedPolicy: acceptedRunPolicy(),
        runInBackground: true,
      });
      await managerA.waitUntilSettled(spawned.agentId);
      expect(managerA.getSnapshot(spawned.agentId)?.resultPersisted).toBeUndefined();
      expect(hostA.pendingResultCount()).toBe(1);

      hostA.dispose();
      hostA = undefined;

      setSessionCtx(ctxB);
      setPiInstance(piB);
      managerB = createTestSubagentRuntime({ pi: piB, ctx: ctxB });
      setManager(managerB);
      hostB = createHost(managerB);
      hostB.bind();
      hostB.restorePending();

      expect(entriesB).toEqual([]);
      expect(hostB.pendingResultCount()).toBeUndefined();
      expect(piB.sendMessage).not.toHaveBeenCalled();
      hostB.dispose();
      hostB = undefined;

      piA.appendFails = false;
      setSessionCtx(ctxA);
      setPiInstance(piA);
      setManager(managerA);
      restoredA = createHost(managerA);
      restoredA.bind();
      restoredA.restorePending();

      expect(entriesA.filter(entry => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
      expect(piA.sendMessage).toHaveBeenCalledOnce();
      expect(managerA.getSnapshot(spawned.agentId)?.resultPersisted).toBe(true);

      const status = await executeAgentStatusTool(
        "status",
        { agent_id: spawned.agentId },
        undefined,
        undefined,
        ctxA,
      );
      expect(status.content[0].text).toContain("result from A");

      restoredA.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
      restoredA.onParentSettled();
      expect(createPiResultRepository(piA, ctxA).read().pending).toHaveLength(0);
      expect(entriesA.filter(entry => entry.customType === "subagents-lite:result-ack")).toHaveLength(1);
      expect(entriesB).toEqual([]);
    } finally {
      await disposeRuntime(managerB, hostB);
      await disposeRuntime(managerA, restoredA ?? hostA);
    }
  });
});
