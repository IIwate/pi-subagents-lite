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

// Mock external dependencies before any imports
vi.mock("typebox", () => {
  const createType = (type: string) => (opts?: any) => ({
    type,
    ...(opts || {}),
  });
  return {
    Type: {
      Object: (properties: Record<string, any>, opts?: any) => ({
        type: "object",
        properties,
        ...(opts || {}),
      }),
      String: createType("string"),
      Number: createType("number"),
      Boolean: createType("boolean"),
      Optional: (schema: any) => ({ ...schema, optional: true }),
      Array: (items: any) => ({ type: "array", items }),
      Record: (keyType: any, valueType: any) => ({
        type: "record",
        keyType,
        valueType,
      }),
      Union: (variants: any[]) => ({ type: "union", variants }),
      Literal: (value: string | number | boolean) => ({
        type: "literal",
        const: value,
      }),
    },
  };
});
vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Container: class {
    children: any[] = [];
    addChild(c: any) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
    invalidate() { /* noop */ }
    render(_width: number): string[] { return []; }
  },
  Input: class {
    onSubmit: (() => void) | null = null;
    focused = false;
    getValue() {
      return "";
    }
    handleInput(_k: string) {}
  },
  Spacer: class {},
  Text: class {},
  Markdown: class {
    text: string;
    constructor(text: string, _w: number, _h: number, _theme: any) {
      this.text = text;
    }
    render(_width: number) {
      return [this.text];
    }
  },
  truncateToWidth: (text: string) => text,
  fuzzyFilter: (items: any[], _query: string, _fn: any) => items,
  getKeybindings: () => ({
    matches: () => false,
  }),
}));

vi.mock("../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class {},
}));

vi.mock("../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue([]),
  mergeAgents: vi.fn().mockReturnValue(new Map()),
  AgentConfigFromMd: {},
}));

vi.mock("../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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
  });

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

  it("includes thinking param (optional, LLM can override thinking level)", () => {
    expect(hasParam(agentTool()!.parameters, "thinking")).toBe(true);
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
  });

  it("registers exactly 3 tools", () => {
    expect(api.tools).toHaveLength(3);
  });

  it("registers Agent, StopAgent, and AgentStatus tools", () => {
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["Agent", "StopAgent", "AgentStatus"]);
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
  });

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
  });

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

  it("routes shortcuts to the current navigator", async () => {
    const shell = await import("../src/shell.js");
    const navigator = { toggleList: vi.fn(), activateMain: vi.fn() };
    shell.setNavigator(navigator as any);
    try {
      await api.shortcuts[0]!.handler({});
      await api.shortcuts[1]!.handler({});
      expect(navigator.toggleList).toHaveBeenCalledOnce();
      expect(navigator.activateMain).toHaveBeenCalledOnce();
    } finally {
      shell.setNavigator(null);
    }
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
  });

  it("registers session_start listener", () => {
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
  });

  it("registers session_shutdown and automatic guidance listeners", () => {
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
    expect(api.listeners.some((l) => l.event === "before_agent_start")).toBe(true);
  });

  it("injects current guidance only while the Agent tool is active", async () => {
    const handler = api.listeners.find((listener) => listener.event === "before_agent_start")!.handler;
    const ctx = {
      model: { provider: "anthropic", id: "sonnet" },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "sonnet" }] },
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
    const shell = await import("../src/shell.js");
    const navigator = { dispose: vi.fn(() => { throw new Error("navigator host disposed"); }) };
    const coordinator = { dispose: vi.fn() };
    const manager = { listAgents: vi.fn(() => []), dispose: vi.fn().mockResolvedValue(undefined) };
    const storeDispose = vi.spyOn(shell.getStore(), "dispose").mockImplementation(() => {});
    shell.setNavigator(navigator as any);
    shell.setCoordinator(coordinator as any);
    shell.setManager(manager as any);

    try {
      const shutdown = api.listeners.find(listener => listener.event === "session_shutdown")?.handler;
      await expect(shutdown?.({}, { hasUI: false, ui: {} })).rejects.toThrow("navigator host disposed");

      expect(coordinator.dispose).toHaveBeenCalledTimes(1);
      expect(storeDispose).toHaveBeenCalledTimes(1);
      expect(manager.dispose).toHaveBeenCalledTimes(1);
      expect(shell.getNavigator()).toBeNull();
      expect(shell.getCoordinator()).toBeNull();
      expect(shell.getManager()).toBeNull();
    } finally {
      storeDispose.mockRestore();
      shell.setNavigator(null);
      shell.setCoordinator(null);
      shell.setManager(null);
    }
  });
});


// worktree_path schema tests (merged from worktree-schema-briefing)
describe("Agent tool schema — worktree_path", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

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
  // The real shell module is used here (index.test.ts does not mock shell.js),
  // so toggling the spawn flag drives the same counter the factory reads.
  let shell: typeof import("../src/shell.js");

  beforeEach(async () => {
    shell = await import("../src/shell.js");
    // Defensive: start every test from a clean depth.
    while (shell.isInsideSubagentSpawn()) shell.exitSubagentSpawn();
  });

  it("registers tools and listeners for the parent session", async () => {
    const api = createMockExtensionAPI();
    await loadExtension(api.api);

    expect(api.tools.length).toBeGreaterThan(0);
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
  });

  it("stays inert when loaded inside a subagent spawn", async () => {
    shell.enterSubagentSpawn();
    try {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);

      // No tools, no event handlers: the subagent must not clobber the parent shell
      // (setPiInstance/setSessionCtx happen via the factory + session_start handler).
      expect(api.tools).toHaveLength(0);
      expect(api.listeners).toHaveLength(0);
      expect(api.shortcuts).toHaveLength(0);
    } finally {
      shell.exitSubagentSpawn();
    }
    expect(shell.isInsideSubagentSpawn()).toBe(false);
  });

  it("is inert for nested spawns and recovers when depth returns to 0", async () => {
    shell.enterSubagentSpawn();
    shell.enterSubagentSpawn(); // nested
    try {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);
      expect(api.tools).toHaveLength(0);
    } finally {
      shell.exitSubagentSpawn();
      shell.exitSubagentSpawn();
    }

    // Parent load works again once no subagent is in flight
    const api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect(api.tools.length).toBeGreaterThan(0);
  });
});
