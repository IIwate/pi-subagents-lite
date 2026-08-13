import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagerAndNavigator } from "../src/events.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../src/bootstrap/extension-runtime.js";
import { ChildScreenHost } from "../src/bootstrap/child-screen.js";
import { fakeCtx, fakePi } from "./fixtures.ts";

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
