import { getMenuRuntime } from "../../../support/menu-mocks.js";
/**
 * menus.test.ts — Tests for the /agents menu dispatcher.
 *
 * After migration: uses SelectList via ctx.ui.custom (not ctx.ui.select).
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetMenuStore } from "../../../support/menu-mocks.js";
import { createMockCtx } from "../../../support/menu-helpers.js";

// Import
import { showAgentsMenu } from "../../../../src/ui/menu/menus.js";

function resetAgentState(): void {
  resetMenuStore({
    modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
    agent: { forceBackground: false },
    concurrency: { default: 4 },
  });
}

function captureMenuFlow(ctx: any, firstChoice: string, cancelKey = "\x1b"): {
  rendered: string[];
  calls: () => number;
} {
  const rendered: string[] = [];
  let calls = 0;
  ctx.ui.custom.mockImplementation(async (factory: any) => {
    calls++;
    return new Promise((resolve) => {
      const component = factory(
        { terminal: { rows: 40, columns: 120 } },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
          italic: (text: string) => text,
        },
        null,
        resolve,
      );
      rendered.push(component.render(120).join("\n"));
      if (calls === 1) resolve(firstChoice);
      else component.handleInput(cancelKey);
    });
  });
  return { rendered, calls: () => calls };
}

describe("showAgentsMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMenu(ctx, getMenuRuntime());
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows all configuration entries directly", async () => {
    const ctx = createMockCtx();
    let rendered = "";
    ctx.ui.custom.mockImplementation(async (factory: any) => {
      const component = factory(
        { terminal: { rows: 40, columns: 120 } },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        null,
        () => {},
      );
      rendered = component.render(120).join("\n");
      return undefined;
    });

    await showAgentsMenu(ctx, getMenuRuntime());

    expect(rendered).not.toContain("Spawn agent");
    expect(rendered).not.toMatch(/^\s+Settings\b/m);
    expect(rendered).toContain("Agents");
    expect(rendered).toContain("Model routing");
    expect(rendered).toContain("Concurrency settings");
    expect(rendered).toContain("Spawn options");
    expect(rendered).toContain("System prompt");
    expect(rendered).toContain("Display settings");
    expect(rendered).not.toContain("Running agents");
  });

  it.each([
    ["routing", "Model Routing"],
    ["concurrency", "Concurrency"],
    ["spawnoptions", "Spawn Options"],
    ["systemprompt", "System Prompt"],
    ["display", "Display Settings"],
  ])("dispatches %s to its submenu", async (choice, title) => {
    const ctx = createMockCtx();
    const flow = captureMenuFlow(ctx, choice);

    await showAgentsMenu(ctx, getMenuRuntime());

    expect(flow.calls()).toBe(3);
    expect(flow.rendered[0]).toContain("Agents");
    expect(flow.rendered[1]).toContain(title);
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    // custom returns undefined = escape
    await showAgentsMenu(ctx, getMenuRuntime());
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("showAgentsMenu — current state", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMenu(ctx, getMenuRuntime());
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows the current fallback value without calling it Default", async () => {
    resetMenuStore({ concurrency: { default: 8 } });
    const ctx = createMockCtx();
    let rendered = "";
    ctx.ui.custom.mockImplementation(async (factory: any) => {
      const component = factory(
        { terminal: { rows: 40, columns: 120 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        null,
        () => {},
      );
      rendered = component.render(120).join("\n");
      return undefined;
    });

    await showAgentsMenu(ctx, getMenuRuntime());

    expect(rendered).toContain("8 slots per model");
    expect(rendered).not.toContain("Default 8");
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    await showAgentsMenu(ctx, getMenuRuntime());
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("Agents menu — submenu navigation", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it.each([
    ["Escape", "\x1b"],
    ["left arrow", "\x1b[D"],
  ])("opens display settings and returns to Agents with %s", async (_label, cancelKey) => {
    const ctx = createMockCtx();
    const flow = captureMenuFlow(ctx, "display", cancelKey);

    await showAgentsMenu(ctx, getMenuRuntime());

    expect(flow.calls()).toBe(3);
    expect(flow.rendered[1]).toContain("Display Settings");
    expect(flow.rendered[2]).toContain("Agents");
  });
});
