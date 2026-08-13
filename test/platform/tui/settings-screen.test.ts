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
  type ConcurrencySettingsOwner,
  type ConcurrencySettingsView,
  type DisplaySettingsOwner,
  type DisplaySettingsView,
  type PromptSettingsOwner,
  type SpawnSettingsOwner,
  type SpawnSettingsView,
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
  const spawnView: SpawnSettingsView = {
    forceBackground: false,
    graceTurns: 6,
    disableDefaultAgents: false,
  };
  const spawn: SpawnSettingsOwner = {
    read: () => ({ ...spawnView }),
    update(update) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      (spawnView as Record<string, boolean | number>)[update.id] = update.value;
      return { ok: true };
    },
  };
  const promptView = {
    systemPromptMode: "replace" as const,
    includeContextFiles: true,
    loadSkillsImplicitly: true,
    loadExtensionsImplicitly: true,
    customPromptPath: "/home/user/.pi/agent/subagent-prompt.md",
    customPromptFileExists: false,
  };
  const prompt: PromptSettingsOwner = {
    read: () => ({ ...promptView }),
    update(update) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      (promptView as Record<string, boolean | string>)[update.id] = update.value;
      return { ok: true };
    },
    createCustomPromptFile() {
      promptView.customPromptFileExists = true;
      return { ok: true };
    },
  };
  const concurrencyView: ConcurrencySettingsView = {
    defaultLimit: 4,
    factoryDefaultLimit: 4,
    providerLimits: { anthropic: 2 },
    modelLimits: {},
    activeProviders: ["anthropic", "openai"],
    activeModels: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
  };
  const concurrency: ConcurrencySettingsOwner = {
    read: () => structuredClone(concurrencyView),
    update(update) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      if (update.scope === "default") {
        concurrencyView.defaultLimit = update.limit;
      } else if (update.scope === "reset") {
        concurrencyView.defaultLimit = concurrencyView.factoryDefaultLimit;
        concurrencyView.providerLimits = {};
        concurrencyView.modelLimits = {};
      } else {
        const section = update.scope === "provider"
          ? concurrencyView.providerLimits
          : concurrencyView.modelLimits;
        if (update.limit === null) delete section[update.key];
        else section[update.key] = update.limit;
      }
      return { ok: true };
    },
  };
  return createSettings({
    summaries: { read: () => ({ modelAccessEnabled: false, concurrencyDefault: 4 }) },
    display,
    spawn,
    prompt,
    concurrency,
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

  it("edits grace turns through the numeric submenu with one commit per submit", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        // Move down to "Spawn options" (3rd row) and enter it.
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\x1b[B");  // move to Grace turns
        component.handleInput("\r");      // open the numeric submenu
        // The pre-filled Input leaves its cursor at position 0, so clear the
        // "6" with forward-delete before typing the new value.
        component.handleInput("\x1b[3~");
        component.handleInput("9");
        component.handleInput("\r");      // submit
        component.handleInput("\x1b");    // back to root
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    const graceNotifications = notifications.mock.calls.filter(([message]) =>
      String(message).startsWith("Grace turns"));
    expect(graceNotifications).toEqual([["Grace turns set to 9", "info"]]);
  });

  it("rejects invalid numeric input inside the submenu without committing", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\r");     // open the numeric submenu
        component.handleInput("-");
        component.handleInput("1");
        component.handleInput("\r");     // invalid submit keeps the submenu open
        component.handleInput("\x1b");   // leave the submenu
        component.handleInput("\x1b");   // back to root
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(notifications).toHaveBeenCalledWith(expect.stringContaining("Invalid value"), "error");
    expect(notifications).not.toHaveBeenCalledWith(expect.stringContaining("Grace turns set"), "info");
  });

  it("reveals the create-prompt-file action in custom mode and fires it once", async () => {
    let customModeText = "";
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        // Move down to "System prompt" (4th row) and enter it.
        for (let i = 0; i < 3; i++) component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\r"); // replace -> inherit
        component.handleInput("\r"); // inherit -> custom, reveals the action row
        customModeText = component.render(120).join("\n");
        component.handleInput("\x1b[B"); // move to "Create prompt file"
        component.handleInput("\r");     // fire the action
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(customModeText).toContain("Create prompt file");
    expect(notifications).toHaveBeenCalledWith("System prompt mode set to custom", "info");
    expect(notifications).toHaveBeenCalledWith(
      "Created prompt file: /home/user/.pi/agent/subagent-prompt.md",
      "info",
    );
  });

  it("edits a keyed limit through the edit-or-remove submenu", async () => {
    const { ctx, renders, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B"); // move to "Concurrency settings"
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\x1b[B"); // move to "Provider · anthropic"
        component.handleInput("\r");     // open edit-or-remove
        component.handleInput("\r");     // choose "Edit limit" → numeric input pre-filled "2"
        component.handleInput("\x1b[3~"); // clear the pre-filled value
        component.handleInput("5");
        component.handleInput("\r");     // submit routes through onChange → update-limit
        component.handleInput("\x1b");   // back to root
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(renders[1]).toContain("Provider · anthropic");
    expect(notifications).toHaveBeenCalledWith("anthropic concurrency set to 5", "info");
  });

  it("removes a keyed limit through the explicit remove gesture", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\x1b[B"); // move to "Provider · anthropic"
        component.handleInput("\r");     // open edit-or-remove
        component.handleInput("\x1b[B"); // move to "Remove limit"
        component.handleInput("\r");
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(notifications).toHaveBeenCalledWith("Removed Provider limit for anthropic", "info");
  });

  it("adds a model limit through the picker followed by the numeric step", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        // Rows: fallback, Provider · anthropic, Add Provider limit, Add Model limit, Reset.
        for (let i = 0; i < 3; i++) component.handleInput("\x1b[B");
        component.handleInput("\r");     // open the searchable picker
        component.handleInput("\x1b[B"); // move to "openai/gpt-5"
        component.handleInput("\r");     // pick → numeric input pre-filled "1"
        component.handleInput("\x1b[3~");
        component.handleInput("3");
        component.handleInput("\r");     // submit commits add-limit directly
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    expect(notifications).toHaveBeenCalledWith("openai/gpt-5 concurrency set to 3", "info");
  });

  it("resets concurrency only after the confirm dialog answers Yes", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\x1b[A"); // wrap upward to the last row: "Reset concurrency"
        component.handleInput("\r");     // open the confirm dialog
        component.handleInput("\x1b");   // Escape → no reset
        component.handleInput("\r");     // reopen
        component.handleInput("\r");     // Yes is preselected → confirm
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings(), noLegacy);

    const resets = notifications.mock.calls.filter(([message]) => message === "Concurrency reset");
    expect(resets).toHaveLength(1);
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
