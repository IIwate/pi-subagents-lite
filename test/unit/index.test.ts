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

import { describe, it, expect, vi, beforeAll } from "vitest";
import { Value } from "typebox/value";
import {
  createMockExtensionAPI,
  hasParam,
  loadExtension,
  type MockExtensionAPI,
} from "../support/fixtures.js";

// Mock external dependencies before any imports
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  DynamicBorder: class {},
}));

vi.mock("@earendil-works/pi-tui", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-tui")>(),
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

vi.mock("../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class {},
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

  it.each([
    { params: { prompt: "Inspect" }, valid: true },
    { params: { prompt: "Inspect", agent: "Explore", thinking: "off", run_in_background: true }, valid: true },
    { params: {}, valid: false },
    { params: { prompt: 1 }, valid: false },
    { params: { prompt: "Inspect", thinking: "invalid" }, valid: false },
    { params: { prompt: "Inspect", run_in_background: "true" }, valid: false },
    { params: { prompt: "Inspect", unknown: true }, valid: false },
  ])("validates registered Agent parameters with TypeBox: $params", ({ params, valid }) => {
    expect(Value.Check(agentTool()!.parameters, params)).toBe(valid);
  });

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
      expect.objectContaining({
        shortcut: "alt+t",
        description: "Take over the selected subagent",
      }),
    ]);
  });

  it("routes shortcuts to their activation's navigator", async () => {
    const { registerTools } = await import("../../src/registration.js");
    const first = createMockExtensionAPI();
    const second = createMockExtensionAPI();
    const navigator = { toggleList: vi.fn(), activateMain: vi.fn(), takeOverActive: vi.fn() };
    const other = { toggleList: vi.fn(), activateMain: vi.fn(), takeOverActive: vi.fn() };
    registerTools(first.api as any, { active: true, navigator } as any);
    registerTools(second.api as any, { active: true, navigator: other } as any);
    for (const shortcut of first.shortcuts) await shortcut.handler({});
    expect(navigator.toggleList).toHaveBeenCalledOnce();
    expect(navigator.activateMain).toHaveBeenCalledOnce();
    expect(navigator.takeOverActive).toHaveBeenCalledOnce();
    expect(other.toggleList).not.toHaveBeenCalled();
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

  it("registers session lifecycle and automatic guidance listeners", () => {
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_tree")).toBe(true);
    expect(api.listeners.some((l) => l.event === "before_agent_start")).toBe(true);
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
