import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: [] as any[],
  manager: undefined as any,
  host: undefined as any,
  session: undefined as any,
  ctx: undefined as any,
  pi: undefined as any,
  runtime: undefined as any,
  runAgent: vi.fn(),
  continueAgentSession: vi.fn(),
  now: 0,
}));

vi.mock("../../src/platform/pi/agent-session.js", () => ({
  runAgent: state.runAgent,
  continueAgentSession: state.continueAgentSession,
}));

import { createAgentStatusToolExecutor } from "../../src/agents/agent-status.js";
import type { ExtensionRuntime } from "../../src/bootstrap/extension-runtime.js";
import { createPiResultRepository } from "../../src/platform/pi/result-repository.js";
import {
  applyDeliveryCommand,
  createHostDelivery,
  interactAgent,
  isParentRunSuccessful,
  recordTerminalResult,
  spawnAgent,
} from "../../src/bootstrap/session-host.js";
import { acceptedRunPolicy, fakeExtensionRuntime } from "../fixtures.js";
import { createTestSubagentRuntime } from "../runtime-harness.js";

function storedPending() {
  return createPiResultRepository(state.pi, state.ctx).read();
}

function createHost(runtime: ExtensionRuntime) {
  const delivery = createHostDelivery(runtime);
  runtime.delivery = delivery;
  const manager = runtime.manager!;
  const run = (command: Parameters<typeof applyDeliveryCommand>[2]) =>
    applyDeliveryCommand(manager, delivery, command);
  return {
    delivery,
    spawn: (_pi: any, ctx: any, intent: any) => spawnAgent(runtime, ctx, intent),
    interact: (agentId: string, message: string) => interactAgent(runtime, agentId, message),
    markResultPresented: (deliveryId: string) => { run({ kind: "mark-presented", deliveryId }); },
    onParentAgentEnd: (messages: readonly { role: string; stopReason?: string; errorMessage?: string }[]) => {
      run({ kind: "parent-end", succeeded: isParentRunSuccessful(messages) });
    },
    onParentSettled: () => { run({ kind: "parent-settled" }); },
    dispose: () => { run({ kind: "dispose" }); },
    onComplete: (snapshot: any) => recordTerminalResult(manager, delivery, snapshot),
  };
}

describe("durable result delivery integration", () => {
  beforeEach(() => {
    state.entries.length = 0;
    state.runAgent.mockReset();
    state.continueAgentSession.mockReset();
    state.session = {
      model: { provider: "test", id: "model" },
      isStreaming: false,
      messages: [],
      agent: { state: {} },
      extensionRunner: { emit: vi.fn(async () => {}) },
      dispose: vi.fn(),
    };
    state.runAgent.mockResolvedValue({
      responseText: "durable result",
      session: state.session,
      aborted: false,
      turnLimited: false,
    });
    state.ctx = {
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "parent-session",
        getLeafId: () => "origin-a",
        getBranch: () => [{ id: "origin-a" }],
        getEntries: () => state.entries,
      },
    };
    state.pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        state.entries.push({ type: "custom", customType, data });
      }),
      sendMessage: vi.fn(),
    };
    state.now = Date.now();
    state.manager = createTestSubagentRuntime({
      pi: state.pi,
      ctx: state.ctx,
      clock: { now: () => state.now },
    });
    state.runtime = fakeExtensionRuntime({
      pi: state.pi,
      sessionCtx: state.ctx,
      manager: state.manager,
    });
    state.host = createHost(state.runtime);
    state.manager.setOnComplete((record: any) => state.host.onComplete(record));
  });

  afterEach(async () => {
    state.host.dispose();
    await state.manager.dispose();
  });

  it("reads and acknowledges a durable result after TTL cleanup removes the Agent record", async () => {
    const spawned = await state.host.spawn(state.pi, state.ctx, {
      type: "reviewer",
      prompt: "review",
      description: "review",
      acceptedPolicy: acceptedRunPolicy(),
      invocation: { providerName: "test", modelName: "model" },
      runInBackground: true,
    });
    const id = spawned.agentId;
    await state.manager.waitUntilSettled(id);
    expect(state.manager.getSnapshot(id)?.resultPersisted).toBe(true);

    state.now += 20 * 60_000;
    await state.manager.execute({ kind: "expire" });
    expect(state.manager.getSnapshot(id)).toBeUndefined();

    const status = await createAgentStatusToolExecutor(state.runtime)(
      "status-call",
      { agent_id: id },
      undefined,
      undefined,
      state.ctx,
    );
    expect(status.content[0].text).toContain("durable result");
    expect(storedPending().pending).toHaveLength(1);

    state.host.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    state.host.onParentSettled();

    expect(storedPending().pending).toHaveLength(0);
  });

  it.each([
    "quota exhausted",
    "invalid API key",
    "content_filter",
  ])("persists a live-session error immediately: %s", async (errorText) => {
    state.runAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated(state.session);
      throw new Error(errorText);
    });

    const spawned = await state.host.spawn(state.pi, state.ctx, {
      type: "reviewer",
      prompt: "review",
      description: "review",
      acceptedPolicy: acceptedRunPolicy(),
      runInBackground: true,
    });
    const record = await state.manager.waitUntilSettled(spawned.agentId);

    expect(record).toMatchObject({
      status: "error",
      resultPersisted: true,
      settled: true,
      liveSession: true,
      error: errorText,
    });
    const pending = storedPending().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "error", error: errorText });
    expect(pending[0].result).toContain(errorText);
    expect(state.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves background delivery identity and creates a new delivery ID after continuation", async () => {
    const spawned = await state.host.spawn(state.pi, state.ctx, {
      type: "reviewer",
      prompt: "review",
      description: "review",
      acceptedPolicy: acceptedRunPolicy(),
      runInBackground: true,
    });
    const id = spawned.agentId;
    let record = await state.manager.waitUntilSettled(id);
    const firstDeliveryId = record?.resultDeliveryId;

    state.host.markResultPresented(firstDeliveryId!);
    state.host.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    state.host.onParentSettled();
    expect(storedPending().pending).toHaveLength(0);

    state.continueAgentSession.mockResolvedValue({
      responseText: "continued result",
      aborted: false,
      turnLimited: false,
    });
    await expect(state.host.interact(id, "continue")).resolves.toEqual({ accepted: true });
    record = await state.manager.waitUntilSettled(id);

    expect(record).toMatchObject({
      resultSessionId: "parent-session",
      resultOriginEntryId: "origin-a",
    });
    expect(record).not.toHaveProperty("backgroundDelivery");
    expect(record?.resultDeliveryId).not.toBe(firstDeliveryId);
    expect(storedPending().pending.find((item) => item.deliveryId === record!.resultDeliveryId)?.result)
      .toBe("continued result");
  });

  it("keeps foreground continuation results out of the inbox", async () => {
    const spawned = await state.host.spawn(state.pi, state.ctx, {
      type: "reviewer",
      prompt: "review",
      description: "review",
      acceptedPolicy: acceptedRunPolicy(),
      runInBackground: false,
    });
    state.continueAgentSession.mockResolvedValue({
      responseText: "foreground continuation",
      aborted: false,
      turnLimited: false,
    });

    await expect(state.host.interact(spawned.agentId, "continue"))
      .resolves.toEqual({ accepted: true });
    const continued = await state.manager.waitUntilSettled(spawned.agentId);

    expect(continued?.resultSessionId).toBeUndefined();
    expect(continued).not.toHaveProperty("backgroundDelivery");
    expect(storedPending().pending).toHaveLength(0);
  });
});
