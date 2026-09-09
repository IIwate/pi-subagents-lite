import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEventListeners } from "../../src/events.js";
import { setManager, setNavigator, setCoordinator, setSessionCtx } from "../../src/shell.js";

describe("setupEventListeners session_shutdown notification", () => {
  let listeners: Array<{ event: string; handler: Function }>;
  let mockPi: any;
  let mockNotify: ReturnType<typeof vi.fn>;
  let mockCtx: any;

  beforeEach(() => {
    listeners = [];
    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        listeners.push({ event, handler });
      }),
    };
    mockNotify = vi.fn();
    mockCtx = {
      hasUI: true,
      ui: { notify: mockNotify },
    };
    setupEventListeners(mockPi);
  });

  afterEach(() => {
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
    setSessionCtx(null as any);
  });

  it("notifies 'killed by reload' only when reason is reload", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [
        { lifecycle: { status: "running" } },
        { lifecycle: { status: "queued" } },
      ]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "reload" }, mockCtx);

    expect(mockNotify).toHaveBeenCalledWith("2 agent(s) killed by reload", "warning");
  });

  it("notifies 'stopped on session close' when reason is quit or non-reload", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [{ lifecycle: { status: "running" } }]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "quit" }, mockCtx);

    expect(mockNotify).toHaveBeenCalledWith("1 agent(s) stopped on session close", "warning");
  });

  it("does not notify when there are no active agents", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [{ lifecycle: { status: "completed" } }]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "reload" }, mockCtx);

    expect(mockNotify).not.toHaveBeenCalled();
  });
});
