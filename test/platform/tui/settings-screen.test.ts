/**
 * settings-screen.test.ts — Renderer contract for the generic settings host.
 *
 * Drives the real pi-tui components through a scripted ctx.ui.custom, the same
 * seam Pi uses. The settings facade is the real module wired to in-memory
 * owners, so these cases cover translation only: snapshot → widgets and key
 * input → commands.
 */

import { describe, expect, it, vi } from "vitest";
import { runSettingsScreen } from "../../../src/platform/pi/tui/settings-screen.js";
import {
  createSettings,
  type DisplaySettingsOwner,
  type DisplaySettingsView,
} from "../../../src/modules/settings/public.js";

function createRealSettings(options: { failUpdatesWith?: string } = {}) {
  const view: DisplaySettingsView = {
    expandListByDefault: true,
    showTools: true,
    showTurns: true,
    showInput: true,
    showOutput: true,
    showContext: true,
    showCost: false,
    showTime: true,
  };
  const display: DisplaySettingsOwner = {
    read: () => ({ ...view }),
    update(id, value) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      view[id] = value;
      return { ok: true };
    },
  };
  return createSettings({
    summaries: { read: () => ({ modelAccessEnabled: false, concurrencyDefault: 4 }) },
    display,
  });
}

/**
 * ctx whose ui.custom renders the component and hands control to a script.
 * The script drives the component like a keyboard user; resolving happens
 * through the host's done callback exactly as in Pi.
 */
function createScriptedCtx(script: Array<(component: any, done: (value: unknown) => void) => void>) {
  const renders: string[] = [];
  let step = 0;
  const ctx = {
    ui: {
      custom: vi.fn((factory: any) => new Promise((resolve) => {
        const component = factory(
          { terminal: { rows: 40, columns: 120 } },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          null,
          resolve,
        );
        renders.push(component.render(120).join("\n"));
        const driver = script[step++];
        if (!driver) throw new Error("settings screen opened more pages than the script covers");
        driver(component, resolve);
      })),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
  };
  return { ctx: ctx as any, renders, notifications: ctx.ui.notify };
}

const noLegacy = { openLegacyCategory: vi.fn(async () => {}) };

describe("settings screen renderer contract", () => {
  it("renders the root categories with summaries and closes on Escape", async () => {
    const { ctx, renders } = createScriptedCtx([
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(renders[0]).toContain("Agents");
    expect(renders[0]).toContain("Model access");
    expect(renders[0]).toContain("Concurrency settings");
    expect(renders[0]).toContain("Spawn options");
    expect(renders[0]).toContain("System prompt");
    expect(renders[0]).toContain("Display settings");
    expect(renders[0]).toContain("Debug");
    expect(renders[0]).toContain("4 slots per model");
  });

  it("opens the display form, toggles a value in place, and returns to the root", async () => {
    const { ctx, renders, notifications } = createScriptedCtx([
      (component) => {
        // Move down to "Display settings" (5th row) and enter it.
        for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        // Toggle "Expand list by default" from ON to OFF, then leave the form.
        component.handleInput("\r");
        expect(renders[1]).toContain("Display Settings");
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
    expect(renders[1]).toContain("Expand list by default");
    expect(renders[1]).toContain("Show cost");
    expect(notifications).toHaveBeenCalledWith(
      "Expand list by default OFF · /reload to apply now",
      "info",
    );
    expect(renders[2]).toContain("Agents");
  });

  it("reverts the widget to the persisted value when the save fails", async () => {
    let failedFormText = "";
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\r");
        failedFormText = component.render(120).join("\n");
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings({ failUpdatesWith: "disk full" }), noLegacy);

    expect(notifications).toHaveBeenCalledWith("Failed to save setting: disk full", "error");
    // The row shows the saved ON value again instead of the failed OFF attempt.
    expect(failedFormText).toMatch(/Expand list by default\s+ON/);
  });

  it("runs the legacy menu for an un-migrated category and re-renders the root", async () => {
    const openLegacyCategory = vi.fn(async () => {});
    const { ctx, renders } = createScriptedCtx([
      (component) => {
        // "Debug" is the last row; \x1b[A wraps upward to it.
        component.handleInput("\x1b[A");
        component.handleInput("\r");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), { openLegacyCategory });

    expect(openLegacyCategory).toHaveBeenCalledExactlyOnceWith("debug");
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
    expect(renders[1]).toContain("Agents");
  });
});
