import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureManagerAndNavigator } from "../src/events.js";
import {
  getManager,
  getNavigator,
  setManager,
  setNavigator,
  setCoordinator,
  setSessionCtx,
} from "../src/shell.js";

describe("ensureManagerAndNavigator", () => {
  beforeEach(() => {
    setSessionCtx({
      sessionManager: {
        getSessionId: () => "test-session",
        getEntries: () => [],
        getBranch: () => [],
      },
    } as any);
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
  });

  afterEach(() => {
    getNavigator()?.dispose();
    getManager()?.dispose();
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
    setSessionCtx(null as any);
  });

  it("wires manager stats updates to navigator ensureTimer", () => {
    ensureManagerAndNavigator();

    const manager = getManager();
    const navigator = getNavigator();
    expect(manager).toBeDefined();
    expect(navigator).toBeDefined();

    const ensureTimerSpy = vi.spyOn(navigator!, "ensureTimer").mockImplementation(() => {});

    // Trigger stats update notification on the manager
    const dummyRecord: any = { id: "test-agent" };
    (manager as any).notifyStatsUpdate(dummyRecord);

    expect(ensureTimerSpy).toHaveBeenCalledTimes(1);
  });
});
