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
import {

  setManager,
  setPiInstance,
  setSessionCtx,
  takeFallbackResults,
} from "../../src/shell.js";
import { readResultEntries } from "../../src/spawn/result-inbox.js";
import { bindSessionHost, createSessionHost } from "../../src/bootstrap/session-host.js";
import type { SpawnCoordinatorApi } from "../../src/spawn/coordinator-api.js";
import { acceptedRunPolicy } from "../fixtures.js";
import { createTestSubagentRuntime } from "../runtime-harness.js";

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

async function disposeRuntime(manager?: SubagentRuntime, coordinator?: SpawnCoordinatorApi) {
  coordinator?.dispose();
  await manager?.dispose();
  bindSessionHost(null);
  setManager(null);
}

describe("session-keyed coordinator fallback", () => {
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
    let coordinatorA: SpawnCoordinatorApi | undefined;
    let coordinatorB: SpawnCoordinatorApi | undefined;
    let restoredA: SpawnCoordinatorApi | undefined;
    try {
      setSessionCtx(ctxA);
      setPiInstance(piA);
      managerA = createTestSubagentRuntime({ pi: piA, ctx: ctxA });
      setManager(managerA);
      coordinatorA = createSessionHost(managerA);
      bindSessionHost(coordinatorA);
      managerA.setOnComplete(record => coordinatorA!.onAgentComplete(record));

      const spawned = await coordinatorA.spawn(piA, ctxA, {
        type: "reviewer",
        prompt: "review",
        description: "review",
        acceptedPolicy: acceptedRunPolicy(),
        runInBackground: true,
      });
      await managerA.waitUntilSettled(spawned.agentId);
      expect(managerA.getSnapshot(spawned.agentId)?.resultPersisted).toBeUndefined();
      expect(coordinatorA.pendingResultCount()).toBe(1);

      coordinatorA.dispose();
      coordinatorA = undefined;

      setSessionCtx(ctxB);
      setPiInstance(piB);
      managerB = createTestSubagentRuntime({ pi: piB, ctx: ctxB });
      setManager(managerB);
      coordinatorB = createSessionHost(managerB);
      bindSessionHost(coordinatorB);
      coordinatorB.restorePending();

      expect(entriesB).toEqual([]);
      expect(coordinatorB.pendingResultCount()).toBeUndefined();
      expect(piB.sendMessage).not.toHaveBeenCalled();
      coordinatorB.dispose();
      coordinatorB = undefined;

      piA.appendFails = false;
      setSessionCtx(ctxA);
      setPiInstance(piA);
      setManager(managerA);
      restoredA = createSessionHost(managerA);
      bindSessionHost(restoredA);
      managerA.setOnComplete(record => restoredA!.onAgentComplete(record));
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
      expect(readResultEntries(ctxA).pending.size).toBe(0);
      expect(entriesA.filter(entry => entry.customType === "subagents-lite:result-ack")).toHaveLength(1);
      expect(entriesB).toEqual([]);
    } finally {
      await disposeRuntime(managerB, coordinatorB);
      await disposeRuntime(managerA, restoredA ?? coordinatorA);
    }
  });
});
