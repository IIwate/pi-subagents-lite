import { fakeOptions, disposeManager, mockAgentSession, mockRunResult } from "../../../support/manager.js";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
/**
 * agent-manager.ordering.test.ts — Agent record list sorting and ranking tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi } from "../../../support/fixtures.js";
import { AgentManager } from "../../../../src/agents/agent-manager.js";
import type { AgentStatus } from "../../../../src/types.js";


const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
}));

vi.mock("../../../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: vi.fn(),
}));

describe("AgentManager — List Ordering", () => {
  let harness: TestHarness;
  let manager: AgentManager;

  beforeEach(() => {
    harness = createTestHarness();
    harness.onDispose(() => disposeManager(manager));
    vi.useFakeTimers();
    mockModules.mockRunAgent.mockReset();
    manager = new AgentManager(undefined, { default: 1 });
    mockModules.mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) =>
      new Promise(resolve => options.signal.addEventListener("abort", () => resolve(mockRunResult()), { once: true })));
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queue blocker", fakeOptions({
      description: "queue blocker", modelKey: "fixture/queue",
    }));
  });

  afterEach(async () => { await harness.dispose(); });

  async function addRecord(name: string, status: AgentStatus, startedAt: number, completedAt?: number, pinnedAt?: number) {
    vi.setSystemTime(startedAt);
    if (status !== "queued") {
      mockModules.mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
        const session = mockAgentSession();
        await options.onSessionCreated(session);
        if (status === "running") {
          await new Promise<void>(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (status === "error") throw new Error("Provider failed");
        return mockRunResult({ session, aborted: status === "aborted", turnLimited: status === "turn_limited" });
      });
    }
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", name, fakeOptions({
      description: name, modelKey: status === "queued" ? "fixture/queue" : undefined,
    }));
    if (status !== "running" && status !== "queued") {
      vi.setSystemTime(completedAt ?? startedAt);
      if (status === "stopped") manager.abort(id, "user");
      await manager.getRecord(id)!.execution.promise;
    }
    if (pinnedAt !== undefined) {
      vi.setSystemTime(pinnedAt);
      manager.togglePinned(id);
    }
  }

  function names() {
    return manager.listAgents().map(record => record.display.description).filter(name => name !== "queue blocker");
  }

  it("ranks attention, motion, queue, and archive with their time orders", async () => {
    await addRecord("completed", "completed", 10, 900);
    await addRecord("queued-later", "queued", 900);
    await addRecord("error", "error", 100, 800);
    await addRecord("running-later", "running", 200);
    await addRecord("stopped", "stopped", 300, 700);
    await addRecord("turn-limited", "turn_limited", 500, 600);
    await addRecord("running-earlier", "running", 100);
    await addRecord("queued-earlier", "queued", 100);
    await addRecord("aborted", "aborted", 600, 1000);

    expect(names()).toEqual([
      "aborted", "error", "turn-limited", "running-earlier", "running-later",
      "queued-earlier", "queued-later", "completed", "stopped",
    ]);
  });

  it.each([
    { status: "error", expected: ["pinned-later", "pinned-earlier", "unpinned"] },
    { status: "running", expected: ["pinned-earlier", "pinned-later", "unpinned"] },
    { status: "queued", expected: ["pinned-earlier", "pinned-later", "unpinned"] },
    { status: "completed", expected: ["pinned-later", "pinned-earlier", "unpinned"] },
  ] as const)("elevates pins within $status while preserving time order", async ({ status, expected }) => {
    await addRecord("unpinned", status, 20, 20);
    await addRecord("pinned-earlier", status, 10, 10, 0);
    await addRecord("pinned-later", status, 30, 30, 1);

    expect(names()).toEqual(expected);
  });

  it("keeps pins inside their attention group", async () => {
    await addRecord("pinned-archive", "stopped", 400, 400, 1);
    await addRecord("pinned-queue", "queued", 300, undefined, 1);
    await addRecord("running", "running", 200);
    await addRecord("error", "error", 100, 100);

    expect(names()).toEqual(["error", "running", "pinned-queue", "pinned-archive"]);
  });

  it("uses registration order to break timestamp ties", async () => {
    await addRecord("first-error", "error", 100, 200);
    await addRecord("first-running", "running", 100);
    await addRecord("second-error", "aborted", 100, 200);
    await addRecord("second-running", "running", 100);

    expect(names()).toEqual(["first-error", "second-error", "first-running", "second-running"]);
  });

  it("orders zero completion timestamps with other completed records", async () => {
    await addRecord("zero-completion", "error", 1000, 0);
    await addRecord("later-completion", "aborted", 100);
    await addRecord("completed", "completed", 1000, 200);
    await addRecord("stopped", "stopped", 300);

    expect(names()).toEqual(["later-completion", "zero-completion", "stopped", "completed"]);
  });
});
