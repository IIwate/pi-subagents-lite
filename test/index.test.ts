/**
 * index.test.ts — Tests for the extension entry point.
 *
 * Tests focus on:
 *   - Tool schema shapes (stealth schemas with no description, no promptSnippet/promptGuidelines)
 *   - Agent model/thinking schema fields
 *   - Schema field exclusion (inherit_context, schedule, isolation params)
 *
 * These tests mock ExtensionAPI and verify registration behavior.
 * Full integration testing is manual via pi TUI.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  createMockExtensionAPI,
  hasParam,
  loadExtension,
  type MockExtensionAPI,
} from "./fixtures";

// Everything below runs against the real modules: real typebox schemas, real
// Pi vendor packages, and the real agent registry. The bootstrap import graph
// resolves the config root at module load, so pin HOME to an empty temp
// directory first to keep the developer's real config out of the suite.
await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "index-test-home-"));
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * The first `loadExtension` in a worker transpiles the whole bootstrap graph and
 * the Pi vendor packages behind it. On a warm Vite cache that is under a second;
 * on a cold one it is tens of seconds, and the default 10s hook timeout turned
 * that into a red run that says nothing about the extension. Timing out here
 * should mean the entry point hangs, not that the cache was empty.
 */
const COLD_IMPORT_TIMEOUT_MS = 120_000;

/**
 * Find a tool by name from the mock API.
 */
function findTool(api: MockExtensionAPI, name: string) {
  return api.tools.find((t) => t.name === name);
}

/* ------------------------------------------------------------------ */
/*  Agent tool schema — stealth                                       */
/* ------------------------------------------------------------------ */

describe("Agent tool schema — stealth", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  const agentTool = () => findTool(api, "Agent");

  it("has no description (stealth)", () => {
    expect(agentTool()).toBeDefined();
    expect(agentTool()!.description).toBeUndefined();
  });

  it("has no promptSnippet", () => {
    expect(agentTool()!.promptSnippet).toBeUndefined();
  });

  it("has no promptGuidelines", () => {
    expect(agentTool()!.promptGuidelines).toBeUndefined();
  });

  it("includes model param (optional, LLM can override model)", () => {
    expect(hasParam(agentTool()!.parameters, "model")).toBe(true);
  });

  it("excludes inherit_context param", () => {
    expect(hasParam(agentTool()!.parameters, "inherit_context")).toBe(false);
  });

  it("excludes schedule param", () => {
    expect(hasParam(agentTool()!.parameters, "schedule")).toBe(false);
  });

  it("excludes isolation param", () => {
    expect(hasParam(agentTool()!.parameters, "isolation")).toBe(false);
  });

  it("includes prompt param (no .description())", () => {
    expect(hasParam(agentTool()!.parameters, "prompt")).toBe(true);
    const promptSchema = agentTool()!.parameters?.properties?.prompt;
    expect(promptSchema?.description).toBeUndefined();
  });

  it("includes description param", () => {
    expect(hasParam(agentTool()!.parameters, "description")).toBe(true);
  });

  it("keeps the agent param static and lets per-run guidance list types", () => {
    expect(hasParam(agentTool()!.parameters, "agent")).toBe(true);
    expect(agentTool()!.parameters.properties.agent.description).toBeUndefined();
  });

  it("excludes max_turns from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "max_turns")).toBe(false);
  });

  it("excludes max_tokens from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "max_tokens")).toBe(false);
  });

  it("includes run_in_background param (optional)", () => {
    expect(hasParam(agentTool()!.parameters, "run_in_background")).toBe(true);
  });

  it("restricts thinking to Pi canonical levels", () => {
    expect(hasParam(agentTool()!.parameters, "thinking")).toBe(true);
    const thinking = agentTool()!.parameters.properties.thinking;
    expect(thinking.anyOf.map((variant: any) => variant.const)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("describes worktree_path as a same-repository worktree", () => {
    expect(hasParam(agentTool()!.parameters, "worktree_path")).toBe(true);
    const wtSchema = agentTool()!.parameters?.properties?.worktree_path;
    expect(wtSchema?.description).toContain("parent repository");
    expect(wtSchema?.description).toContain("not an arbitrary cwd");
  });


  it("excludes isolated from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "isolated")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Tool Registration Count                                           */
/* ------------------------------------------------------------------ */

describe("tool registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("registers exactly 3 tools", () => {
    expect(api.tools).toHaveLength(3);
  });

  it("registers Agent, StopAgent, and AgentStatus tools", () => {
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["Agent", "StopAgent", "AgentStatus"]);
  });

  it("allows AgentStatus to look up one exact agent result", () => {
    const tool = findTool(api, "AgentStatus");
    expect(hasParam(tool?.parameters, "agent_id")).toBe(true);
    expect(tool?.parameters.additionalProperties).toBe(false);
  });

  it("keeps every subagent tool out of the chat feed", () => {
    for (const tool of api.tools) {
      expect(tool.renderShell).toBe("self");
      expect(tool.renderCall?.().children).toEqual([]);
      expect(tool.renderResult?.().children).toEqual([]);
    }
  });

  it("rejects unknown parameters for every subagent tool", () => {
    for (const tool of api.tools) {
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Command Registration                                              */
/* ------------------------------------------------------------------ */

describe("command registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("registers /agents command", () => {
    const agentsCmd = api.commands.find((c) => c.name === "agents");
    expect(agentsCmd).toBeDefined();
    expect(agentsCmd!.description).toBeDefined();
  });

  it("registers only /agents command", () => {
    const cmdNames = api.commands.map((c) => c.name).sort();
    expect(cmdNames).toEqual(["agents"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Shortcut Registration                                             */
/* ------------------------------------------------------------------ */

describe("shortcut registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("registers list and Main navigation shortcuts", () => {
    expect(api.shortcuts).toEqual([
      expect.objectContaining({
        shortcut: "alt+a",
        description: "Toggle subagent list",
      }),
      expect.objectContaining({
        shortcut: "alt+m",
        description: "Return to Main agent",
      }),
    ]);
  });

  it("routes shortcuts to the runtime's navigator", async () => {
    const { createExtensionRuntime } = await import("../src/bootstrap/extension-runtime.js");
    const { registerTools } = await import("../src/bootstrap/registration.js");
    const localApi = createMockExtensionAPI();
    const runtime = createExtensionRuntime(localApi.api as any);
    registerTools(runtime);

    const navigator = { toggleList: vi.fn(), activateMain: vi.fn() };
    runtime.navigator = navigator as any;
    await localApi.shortcuts[0]!.handler({});
    await localApi.shortcuts[1]!.handler({});
    expect(navigator.toggleList).toHaveBeenCalledOnce();
    expect(navigator.activateMain).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  Event Listener Registration                                       */
/* ------------------------------------------------------------------ */

describe("event listener registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("registers session_start listener", () => {
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
  });

  it("registers session lifecycle and automatic guidance listeners", () => {
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_tree")).toBe(true);
    expect(api.listeners.some((l) => l.event === "before_agent_start")).toBe(true);
  });

  it("injects current guidance only while the Agent tool is active", async () => {
    // session_start never fires in this suite, so the assertion also pins that
    // the activation-time registry already answers with the built-in types.
    const handler = api.listeners.find((listener) => listener.event === "before_agent_start")!.handler;
    const ctx = {
      model: { provider: "anthropic", id: "sonnet", reasoning: true },
      thinkingLevel: "medium",
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "sonnet", reasoning: true }] },
      scopedModels: [],
    };
    const active = await handler({
      systemPrompt: "base",
      systemPromptOptions: { selectedTools: ["Agent"] },
    }, ctx);
    expect(active.systemPrompt).toContain("base\n\n[Subagent access]");
    expect(active.systemPrompt).toContain("anthropic/sonnet");
    expect(api.api.sendUserMessage).not.toHaveBeenCalled();
    expect(api.api.sendMessage).not.toHaveBeenCalled();

    const inactive = await handler({
      systemPrompt: "base",
      systemPromptOptions: { selectedTools: ["read"] },
    }, ctx);
    expect(inactive).toBeUndefined();
  });

  it("continues shutdown cleanup after a display disposer fails", async () => {
    const { createExtensionRuntime } = await import("../src/bootstrap/extension-runtime.js");
    const { setupEventListeners } = await import("../src/bootstrap/events.js");
    const localApi = createMockExtensionAPI();
    const runtime = createExtensionRuntime(localApi.api as any);
    setupEventListeners(runtime);

    const navigator = { dispose: vi.fn(() => { throw new Error("navigator host disposed"); }) };
    const delivery = { execute: vi.fn() };
    const manager = { listSnapshots: vi.fn(() => []), dispose: vi.fn().mockResolvedValue(undefined) };
    runtime.navigator = navigator as any;
    runtime.delivery = delivery as any;
    runtime.manager = manager as any;

    const shutdown = localApi.listeners.find(listener => listener.event === "session_shutdown")?.handler;
    await expect(shutdown?.({}, { hasUI: false, ui: {} })).rejects.toThrow("navigator host disposed");

    expect(delivery.execute).toHaveBeenCalledWith({ kind: "dispose" });
    expect(manager.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.navigator).toBeNull();
    expect(runtime.delivery).toBeNull();
    expect(runtime.manager).toBeNull();
  });
});


// worktree_path schema tests (merged from worktree-schema-briefing)
describe("Agent tool schema — worktree_path", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("worktree_path is optional in the schema", () => {
    const tool = api.tools.find((t) => t.name === "Agent")!;
    const required = tool.parameters.required ?? [];
    expect(required).not.toContain("worktree_path");
  });

  it("worktree_path is a described string type in the schema", () => {
    const tool = api.tools.find((t) => t.name === "Agent")!;
    const prop = tool.parameters.properties?.worktree_path;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("string");
    expect(prop.description).toContain("linked worktree");
    expect(prop.description).toContain("another repository");
  });
});


/* ------------------------------------------------------------------ */
/*  Subagent spawn guard (prevents shell clobbering)                  */
/* ------------------------------------------------------------------ */

describe("subagent spawn guard", () => {
  // The real process-state module is used here (it is never mocked).
  let processState: typeof import("../src/platform/process/process-state.js");

  beforeEach(async () => {
    processState = await import("../src/platform/process/process-state.js");
  });

  it("registers tools and listeners for the parent session", async () => {
    const api = createMockExtensionAPI();
    await loadExtension(api.api);

    expect(api.tools.length).toBeGreaterThan(0);
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
  });

  it("stays inert when loaded inside a subagent spawn", async () => {
    await processState.withSubagentSpawn(async () => {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);

      // No tools, no event handlers: the subagent must not clobber the parent runtime.
      expect(api.tools).toHaveLength(0);
      expect(api.listeners).toHaveLength(0);
      expect(api.shortcuts).toHaveLength(0);
    });
    expect(processState.isInsideSubagentSpawn()).toBe(false);
  });

  it("is inert for nested spawns and restores the parent async context", async () => {
    await processState.withSubagentSpawn(() => processState.withSubagentSpawn(async () => {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);
      expect(api.tools).toHaveLength(0);
    }));

    const api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect(api.tools.length).toBeGreaterThan(0);
  });

  it("does not make unrelated parent work inert while a child context is active", async () => {
    let release!: () => void;
    const child = processState.withSubagentSpawn(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();

    expect(processState.isInsideSubagentSpawn()).toBe(false);
    const api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect(api.tools.length).toBeGreaterThan(0);

    release();
    await child;
  });
});
