import { describe, expect, it, vi } from "vitest";

// Pin HOME before the bootstrap graph loads: configuration.ts resolves the
// document path once at import time, and this suite must not read or depend
// on a developer's real config document.
await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "extension-runtime-test-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi", "agent", "subagents-lite.json"),
    JSON.stringify({ agent: { showTurns: false } }),
  );
  process.env.HOME = home;
  // Windows homedir() reads USERPROFILE; Pi's getAgentDir derives from it.
  process.env.USERPROFILE = home;
});

import { createExtensionRuntime } from "../../src/bootstrap/extension-runtime.js";

function statsNavigator() {
  return { setStatsVisibility: vi.fn() };
}

// Phase 8 exit condition: one process must be able to hold two runtimes whose
// ordinary session state (ctx, manager, delivery, navigator) never leaks
// across records. Only the persisted document and the process-state platform
// module are deliberately process-wide.
describe("ExtensionRuntime isolation", () => {
  it("keeps ordinary session state private to each runtime record", () => {
    const piA = { registerTool: vi.fn() } as any;
    const piB = { registerTool: vi.fn() } as any;
    const a = createExtensionRuntime(piA);
    const b = createExtensionRuntime(piB);

    a.sessionCtx = { cwd: "/tmp/a" } as any;
    a.manager = { listSnapshots: () => [] } as any;
    a.delivery = { pendingResultCount: () => 0 } as any;
    a.navigator = statsNavigator() as any;

    expect(a.pi).toBe(piA);
    expect(b.pi).toBe(piB);
    expect(b.sessionCtx).toBeNull();
    expect(b.manager).toBeNull();
    expect(b.delivery).toBeNull();
    expect(b.navigator).toBeNull();
  });

  it("routes settings stats sync only to the owning runtime's navigator", () => {
    const a = createExtensionRuntime({} as any);
    const b = createExtensionRuntime({} as any);
    const navigatorA = statsNavigator();
    const navigatorB = statsNavigator();
    a.navigator = navigatorA as any;
    b.navigator = navigatorB as any;

    a.agentSettings.syncNavigatorStats();

    expect(navigatorA.setStatsVisibility).toHaveBeenCalledOnce();
    expect(navigatorB.setStatsVisibility).not.toHaveBeenCalled();
  });

  it("shares only the persisted configuration document between runtimes", () => {
    const a = createExtensionRuntime({} as any);
    const b = createExtensionRuntime({} as any);

    // Both stores read the same document by design: it is one file on disk.
    expect(a.agentSettings.read()).toEqual(b.agentSettings.read());
    expect(a.agentSettings.read().showTurns).toBe(false);
  });
});
