import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { runAgent } from "../../src/agents/agent-runner.js";
import { fakeOptions, mockRunResult } from "../agents/manager/manager-test-helpers.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { setupEventListeners } from "../../src/events.js";
import { setCoordinator, setManager, setPiInstance, setSessionCtx } from "../../src/shell.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import {
  buildResultMessage,
  PENDING_RESULT_ENTRY,
  readDurableLogState,
  RESULT_ACK_ENTRY,
  type PendingResult,
} from "../../src/spawn/result-inbox.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));

describe("durable result delivery", () => {
  let directory: string;
  let session: SessionManager;
  let manager: AgentManager;
  let coordinator: SpawnCoordinator;
  let ctx: any;
  let pi: any;
  let rootId: string;
  let originId: string;
  let handlers: Map<string, Function>;

  function result(agentId = "agent-a"): PendingResult {
    return {
      deliveryId: randomUUID(),
      parentSessionId: session.getSessionId(),
      originEntryId: originId,
      agentId,
      type: "Explore",
      status: "completed",
      result: `Result for ${agentId}`,
      error: null,
      createdAt: Date.now(),
    };
  }

  function save(completion: PendingResult): void {
    session.appendCustomEntry(PENDING_RESULT_ENTRY, completion);
  }

  function deliver(completion: PendingResult): void {
    const message = buildResultMessage([completion])!;
    session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  }

  function toolResult(details: unknown, toolName = "AgentStatus") {
    return {
      role: "toolResult" as const,
      toolCallId: "status-call",
      toolName,
      content: [{ type: "text" as const, text: "Stored result" }],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  async function addRecord(completion: PendingResult) {
    vi.mocked(runAgent).mockResolvedValueOnce(mockRunResult({ responseText: completion.result }));
    const id = manager.spawn(pi, ctx, completion.type, completion.result, fakeOptions({
      resultSessionId: completion.parentSessionId,
      resultOriginEntryId: completion.originEntryId,
    }));
    const record = manager.getRecord(id)!;
    await record.execution.promise;
    return record;
  }

  function withUnwritableLog(action: () => void): void {
    const file = session.getSessionFile()!;
    const backup = `${file}.saved`;
    renameSync(file, backup);
    mkdirSync(file);
    try { action(); } finally {
      rmdirSync(file);
      renameSync(backup, file);
    }
  }

  async function state() {
    return (await readDurableLogState(session.getSessionFile(), session.getSessionId()))!;
  }

  function pauseRead() {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const snapshot = readFileSync(session.getSessionFile()!, "utf8");
    vi.mocked(readFile).mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return snapshot;
    });
    return { started: started.promise, release: release.resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.mocked(readFile).mockReset();
    vi.mocked(runAgent).mockReset();
    directory = mkdtempSync(join(tmpdir(), "pi-durable-inbox-"));
    session = SessionManager.create(directory, directory);
    rootId = session.appendMessage({ role: "user", content: "Start", timestamp: Date.now() } as any);
    originId = session.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Ready" }], stopReason: "stop", timestamp: Date.now(),
    } as any);
    handlers = new Map();
    pi = {
      on: (name: string, handler: Function) => handlers.set(name, handler),
      sendMessage: vi.fn(),
      appendEntry: vi.fn((customType: string, data: unknown) => { session.appendCustomEntry(customType, data); }),
    };
    ctx = { sessionManager: session, isIdle: () => true, hasUI: false };
    setSessionCtx(ctx);
    setPiInstance(pi);
    manager = new AgentManager(record => coordinator.onAgentComplete(record));
    setManager(manager);
    coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    setupEventListeners(pi);
  });

  afterEach(async () => {
    await manager.dispose();
    await coordinator.reconcileDeliveryState();
    coordinator.dispose();
    setCoordinator(null);
    setManager(null);
    setSessionCtx(null as any);
    setPiInstance(null as any);
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps queued messages unacknowledged", async () => {
    const completion = result();
    save(completion);
    await coordinator.restorePending();
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    await coordinator.onParentSettled();
    expect((await state()).acknowledgedIds.size).toBe(0);
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it.each(["error", "aborted"])("acknowledges persisted delivery after a parent %s", async stopReason => {
    const completion = result();
    save(completion);
    deliver(completion);
    await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason }] }, ctx);
    await handlers.get("agent_settled")!({}, ctx);
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("repairs a missing ACK before session restoration can wake the parent", async () => {
    const completion = result();
    save(completion);
    deliver(completion);
    coordinator.dispose();
    session = SessionManager.open(session.getSessionFile()!);
    ctx.sessionManager = session;
    coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    await coordinator.restorePending();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("retries only ACK persistence after Pi leaves a failed append in memory", async () => {
    const completion = result();
    save(completion);
    deliver(completion);
    pi.appendEntry.mockImplementationOnce((type: string, data: unknown) => {
      withUnwritableLog(() => session.appendCustomEntry(type, data));
    });
    await coordinator.restorePending();
    expect((await state()).acknowledgedIds.size).toBe(0);
    expect(session.getEntries().some(entry => entry.type === "custom" && entry.customType === RESULT_ACK_ENTRY)).toBe(true);
    coordinator.dispose();
    coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    await coordinator.restorePending();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not acknowledge a receipt left only in Pi memory after a failed write", async () => {
    const completion = result();
    save(completion);
    expect(() => withUnwritableLog(() => deliver(completion))).toThrow();
    await coordinator.reconcileDeliveryState();
    expect((await state()).acknowledgedIds.size).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(coordinator.getStoredResult(completion.agentId)?.result).toBe(completion.result);
  });

  it("keeps an explicit lookup unacknowledged until its tool result is persisted", async () => {
    const completion = result();
    save(completion);
    await coordinator.reconcileDeliveryState();
    const response = await executeAgentStatusTool("status-call", { agent_id: completion.agentId }, undefined, undefined, ctx);
    expect(response.details.deliveryIds).toEqual([completion.deliveryId]);
    await coordinator.onParentSettled();
    expect((await state()).acknowledgedIds.size).toBe(0);
    session.appendMessage({ ...toolResult(response.details), content: response.content });
    await coordinator.reconcileDeliveryState();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("keeps each continuation's acknowledgement independent", async () => {
    const first = result();
    const second = result();
    save(first);
    save(second);
    deliver(first);
    await coordinator.reconcileDeliveryState();
    expect([...((await state()).acknowledgedIds)]).toEqual([first.deliveryId]);
    deliver(second);
    await coordinator.reconcileDeliveryState();
    expect((await state()).acknowledgedIds).toEqual(new Set([first.deliveryId, second.deliveryId]));
  });

  it("reads and acknowledges a result after GC removes its execution record", async () => {
    const record = await addRecord(result());
    const completion = coordinator.getStoredResult(record.id)!;
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(completion.agentId)).toBeUndefined();
    await coordinator.reconcileDeliveryState();
    const response = await executeAgentStatusTool("status-call", { agent_id: completion.agentId }, undefined, undefined, ctx);
    expect(response.content[0].text).toContain(completion.result);
    session.appendMessage({ ...toolResult(response.details), content: response.content });
    await coordinator.reconcileDeliveryState();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("delivers completed results across later foreground turns without age expiry", async () => {
    const completion = { ...result(), createdAt: Date.now() - 60 * 60_000 };
    save(completion);
    session.appendMessage({ role: "user", content: "Continue another task", timestamp: Date.now() } as any);
    const message = await coordinator.prepareBeforeAgentStart();
    expect(message?.details.deliveryIds).toEqual([completion.deliveryId]);
    expect(message?.display).toBe(false);
    deliver(completion);
    await coordinator.onParentSettled();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("waits outside the origin subtree and reconciles before returning delivery", async () => {
    const completion = result();
    save(completion);
    session.branch(rootId);
    await coordinator.onSessionTree();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    session.branch(originId);
    await coordinator.onSessionTree();
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    deliver(completion);
    await coordinator.onSessionTree();
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("does not inject a persisted receipt during natural prompt preparation", async () => {
    const completion = result();
    save(completion);
    deliver(completion);
    expect(await coordinator.prepareBeforeAgentStart()).toBeUndefined();
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });

  it("does not use memory receipts when the session has no durable file", async () => {
    const completion = result();
    save(completion);
    deliver(completion);
    coordinator.dispose();
    vi.spyOn(session, "getSessionFile").mockReturnValue(undefined);
    coordinator = new SpawnCoordinator(manager);
    expect(await coordinator.reconcileDeliveryState()).toBe(false);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("rejects an unterminated receipt and leaves the log untouched", async () => {
    const completion = result();
    save(completion);
    appendFileSync(session.getSessionFile()!, JSON.stringify({
      ...buildResultMessage([completion]), type: "custom_message", id: "partial", parentId: originId,
      timestamp: new Date().toISOString(),
    }));
    expect(await coordinator.reconcileDeliveryState()).toBe(false);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it.each(["foreign tool", "failed lookup", "missing content", "invalid IDs", "unknown ID"])(
    "rejects an invalid delivery receipt: %s", async kind => {
      const completion = result();
      save(completion);
      const receipt = toolResult({ parentSessionId: completion.parentSessionId, deliveryIds: [completion.deliveryId] });
      if (kind === "foreign tool") receipt.toolName = "read";
      if (kind === "failed lookup") receipt.isError = true;
      if (kind === "missing content") receipt.content = [];
      if (kind === "invalid IDs") (receipt.details as any).deliveryIds.push(null);
      if (kind === "unknown ID") (receipt.details as any).deliveryIds = ["unknown"];
      session.appendMessage(receipt);
      await coordinator.reconcileDeliveryState();
      expect((await state()).acknowledgedIds.size).toBe(0);
      expect(pi.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("keeps acknowledgements terminal across repeated result entries", async () => {
    const completion = result();
    save(completion);
    session.appendCustomEntry(RESULT_ACK_ENTRY, { parentSessionId: completion.parentSessionId, deliveryIds: [completion.deliveryId] });
    save(completion);
    await coordinator.restorePending();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(coordinator.getStoredResult(completion.agentId)?.result).toBe(completion.result);
  });

  it("preserves a completion persisted during an older disk snapshot", async () => {
    const read = pauseRead();
    const reconciliation = coordinator.reconcileDeliveryState();
    await read.started;
    const record = await addRecord(result("agent-new"));
    read.release();
    await reconciliation;
    await Promise.resolve();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Result for agent-new") }),
      expect.anything(),
    );
    expect((await state()).saved.has(record.execution.resultDeliveryId!)).toBe(true);
  });

  it("performs a trailing read when a receipt arrives during reconciliation", async () => {
    const completion = result();
    save(completion);
    const read = pauseRead();
    const first = coordinator.reconcileDeliveryState();
    await read.started;
    deliver(completion);
    const second = coordinator.reconcileDeliveryState();
    read.release();
    await Promise.all([first, second]);
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
    expect(pi.appendEntry).toHaveBeenCalledOnce();
  });

  it.each(["session", "file"])("rejects a stale reconciliation after its %s changes", async changed => {
    const completion = result();
    save(completion);
    deliver(completion);
    const read = pauseRead();
    const reconciliation = coordinator.reconcileDeliveryState();
    await read.started;
    if (changed === "session") {
      ctx.sessionManager = SessionManager.create(directory, directory);
    } else {
      vi.spyOn(session, "getSessionFile").mockReturnValue(join(directory, "another.jsonl"));
    }
    read.release();
    expect(await reconciliation).toBe(false);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("ignores copied result and receipt entries in a new parent session", async () => {
    const completion = result();
    coordinator.dispose();
    session = SessionManager.create(directory, directory);
    ctx.sessionManager = session;
    session.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as any);
    save(completion);
    deliver(completion);
    coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    await coordinator.restorePending();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("waits until the message_end handler returns before checking the log", async () => {
    const completion = result();
    save(completion);
    const message = { ...buildResultMessage([completion])!, role: "custom", timestamp: Date.now() };
    const reconcile = vi.spyOn(coordinator, "reconcileDeliveryState");
    handlers.get("message_end")!({ message }, ctx);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    deliver(completion);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledOnce();
    await reconcile.mock.results[0].value;
    expect((await state()).acknowledgedIds.has(completion.deliveryId)).toBe(true);
  });
});
