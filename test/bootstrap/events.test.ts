import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagerAndNavigator, setupEventListeners } from "../../src/bootstrap/events.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../../src/bootstrap/extension-runtime.js";
import { ChildScreenHost } from "../../src/bootstrap/child-screen.js";
import {
  createBackgroundDelivery,
  type BackgroundResultRecord,
} from "../../src/modules/background-result-delivery/public.js";
import { createMockExtensionAPI, fakeCtx, fakePi } from "../fixtures.ts";

// The navigator seed values flow from the persisted document through the real
// bootstrap seams (configuration -> agent-settings -> navigator). vi.hoisted
// runs before the module imports above, so HOME points at a temp directory
// with a known document when the bootstrap modules resolve the config root.
await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "events-test-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi", "agent", "subagents-lite.json"),
    JSON.stringify({ agent: { expandListByDefault: false, showTurns: false } }),
  );
  process.env.HOME = home;
});

describe("ensureManagerAndNavigator", () => {
  let runtime: ExtensionRuntime;
  let ctx: any;

  beforeEach(() => {
    ctx = fakeCtx();
    runtime = createExtensionRuntime(fakePi() as any);
    // Production order: session_start stores the context before wiring.
    runtime.sessionCtx = ctx;
  });

  it("wires manager, delivery, and a real navigator host once", () => {
    ensureManagerAndNavigator(runtime, ctx);

    expect(runtime.manager).not.toBeNull();
    expect(runtime.delivery).not.toBeNull();
    expect(runtime.navigator).toBeInstanceOf(ChildScreenHost);

    const firstNavigator = runtime.navigator;
    ensureManagerAndNavigator(runtime, ctx);
    expect(runtime.navigator).toBe(firstNavigator);
  });

  it("passes the persisted list expansion default to a new navigator", () => {
    ensureManagerAndNavigator(runtime, ctx);

    expect(runtime.navigator!.inspectState()?.listExpanded).toBe(false);
  });

  it("seeds the new navigator's stats visibility from the persisted display settings", () => {
    ensureManagerAndNavigator(runtime, ctx);

    expect(runtime.navigator!.inspectState()?.statsVisibility).toMatchObject({
      showTurns: false,
      showTools: true,
    });
  });
});

describe("before_agent_start delivery ordering", () => {
  it("injects pending results without assembling guidance when Agent is inactive", () => {
    const api = createMockExtensionAPI();
    const runtime = createExtensionRuntime(api.api as any);
    runtime.manager = {
      listSnapshots: () => [],
      markResult: vi.fn(),
    } as any;
    const snapshot = {
      parentSessionId: "parent-session",
      parentRunPhase: "idle" as const,
      parentWakeActive: false,
      lastWakeFailed: false,
      pending: [],
      fallback: [],
    };
    const execute = vi.fn((command: { kind: string }) => command.kind === "parent-preflight"
      ? {
          ok: true as const,
          snapshot,
          events: [],
          injection: {
            customType: "subagent-result",
            content: "pending result",
            display: false as const,
          },
        }
      : { ok: true as const, snapshot, events: [] });
    runtime.delivery = { execute, pendingResultCount: () => undefined };
    const catalogueRead = vi.spyOn(runtime.agents, "availableTypes");
    setupEventListeners(runtime);
    const beforeStart = api.listeners.find((listener) => listener.event === "before_agent_start")!.handler;

    expect(beforeStart({
      systemPrompt: "base",
      systemPromptOptions: { selectedTools: ["read"] },
    }, {})).toEqual({
      message: {
        customType: "subagent-result",
        content: "pending result",
        display: false,
      },
    });
    expect(catalogueRead).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({ kind: "parent-preflight" });
  });

  it("keeps a pending result when guidance assembly rejects the run", async () => {
    const api = createMockExtensionAPI();
    const runtime = createExtensionRuntime(api.api as any);
    const stored: BackgroundResultRecord = {
      deliveryId: "delivery-1",
      parentSessionId: "parent-session",
      originEntryId: "origin-entry",
      agentId: "agent-1",
      type: "reviewer",
      status: "completed",
      result: "durable result",
      error: null,
      createdAt: 1,
    };
    const pending = [stored];
    const latest = [stored];
    const acknowledge = vi.fn((_sessionId: string, ids: readonly string[]) => {
      for (const id of ids) {
        const index = pending.findIndex((item) => item.deliveryId === id);
        if (index >= 0) pending.splice(index, 1);
      }
      return true;
    });
    runtime.manager = {
      listSnapshots: () => [],
      markResult: vi.fn(),
    } as any;
    runtime.delivery = createBackgroundDelivery({
      repository: {
        read: () => ({ pending: [...pending], latest: [...latest] }),
        find: ({ agentId, deliveryId }) => latest.find((item) =>
          item.agentId === agentId && (!deliveryId || item.deliveryId === deliveryId)),
        append: (record) => {
          pending.push(record);
          latest.push(record);
          return true;
        },
        acknowledge,
      },
      messenger: { send: () => true },
      context: {
        parentSessionId: () => "parent-session",
        activeBranchIds: () => ["origin-entry"],
        isIdle: () => false,
      },
      fallback: { take: () => [], save: () => {} },
    });
    setupEventListeners(runtime);
    const beforeStart = api.listeners.find((listener) => listener.event === "before_agent_start")!.handler;
    const parentEnd = api.listeners.find((listener) => listener.event === "agent_end")!.handler;
    const parentSettled = api.listeners.find((listener) => listener.event === "agent_settled")!.handler;
    const ctx = {
      model: { provider: "test", id: "parent", reasoning: false },
      thinkingLevel: "off",
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
      hasUI: false,
    };
    const types = vi.spyOn(runtime.agents, "availableTypes").mockReturnValue(["broken"]);
    const config = vi.spyOn(runtime.agents, "agentConfig").mockReturnValue({
      name: "broken",
      description: "Broken test definition",
      maxTurns: Number.NaN,
      systemPrompt: "test",
    } as any);

    expect(() => beforeStart({
      systemPrompt: "base",
      systemPromptOptions: { selectedTools: ["Agent"] },
    }, ctx)).toThrow("Agent guidance command is invalid");
    parentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    parentSettled();

    expect(pending.map((item) => item.deliveryId)).toEqual(["delivery-1"]);
    expect(acknowledge).not.toHaveBeenCalled();
    types.mockRestore();
    config.mockRestore();
    const nextRun = await beforeStart({
      systemPrompt: "base",
      systemPromptOptions: { selectedTools: ["Agent"] },
    }, ctx);
    expect(nextRun).toMatchObject({
      message: { content: expect.stringContaining("durable result") },
      systemPrompt: expect.stringContaining("[Subagent access]"),
    });
    parentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    parentSettled();
    expect(pending).toEqual([]);
    expect(acknowledge).toHaveBeenCalledWith("parent-session", ["delivery-1"]);
  });
});
