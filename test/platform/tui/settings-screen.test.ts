/**
 * settings-screen.test.ts — Renderer contract for the generic settings host.
 *
 * Drives the real pi-tui components through a scripted ctx.ui.custom, the same
 * seam Pi uses. The settings facade is the real module wired to in-memory
 * owners, so these cases cover translation only: snapshot → widgets and key
 * input → commands.
 */

// Pin HOME before importing ConfigSectionIO; that module opens the
// process-scoped document at load time.
await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "settings-screen-persist-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
});

import { describe, expect, it, vi } from "vitest";
import { mergeConcurrencyLayers, parseConcurrencyLayer } from "../../../src/modules/subagent-runtime/public.js";
import { createAgentSettingsStore } from "../../../src/bootstrap/agent-settings.js";
import { createConfigurationSectionIO } from "../../../src/bootstrap/configuration.js";
import { createConfiguration } from "../../../src/modules/configuration/public.js";
import { runSettingsScreen } from "../../../src/platform/pi/tui/settings-screen.js";
import {
  createSettings,
  type ConcurrencySettingsOwner,
  type ConcurrencySettingsView,
  type DebugSettingsOwner,
  type DisplaySettingsOwner,
  type DisplaySettingsView,
  type ModelAccessSettingsOwner,
  type PromptSettingsOwner,
  type SpawnSettingsOwner,
  type SpawnSettingsView,
} from "../../../src/modules/settings/public.js";

function persistFailingDisplayOwner(message: string) {
  const io = createConfigurationSectionIO(createConfiguration({
    repository: {
      load: () => ({ status: "loaded" as const, document: { agent: { expandListByDefault: true, showTools: true } } }),
      persist() {
        throw new Error(message);
      },
    },
  }));
  const store = createAgentSettingsStore(io, () => null);
  const display: DisplaySettingsOwner = {
    read() {
      const agent = store.read();
      return {
        expandListByDefault: agent.expandListByDefault,
        showTools: agent.showTools,
        showTurns: agent.showTurns,
        showInput: agent.showInput,
        showOutput: agent.showOutput,
        showContext: agent.showContext,
        showCost: agent.showCost,
        showTime: agent.showTime,
      };
    },
    update(id, value) {
      return store.update(id, value);
    },
  };
  return { display, store };
}

function createRealSettings(options: {
  failUpdatesWith?: string;
  display?: DisplaySettingsOwner;
} = {}) {
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
  const display: DisplaySettingsOwner = options.display ?? {
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
    graceTurnsFallback: 6,
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
  const globalFragment: { default?: number; providers: Record<string, number>; models: Record<string, number> } = {
    default: 4,
    providers: { anthropic: 2 },
    models: {},
  };
  const concurrency: ConcurrencySettingsOwner = {
    read: (): ConcurrencySettingsView => {
      const merged = mergeConcurrencyLayers(parseConcurrencyLayer(structuredClone(globalFragment)));
      return {
        effective: merged.effective,
        provenance: merged.provenance,
        global: parseConcurrencyLayer(structuredClone(globalFragment)).fragment,
        project: {},
        projectLayer: { state: "untrusted", writable: false, ignoredEntryCount: 0 },
        factoryDefaultLimit: 4,
        activeProviders: ["anthropic", "openai"],
        activeModels: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
      };
    },
    update({ update }) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      if (update.scope === "default") {
        if (update.limit === null) delete globalFragment.default;
        else globalFragment.default = update.limit;
      } else if (update.scope === "reset") {
        globalFragment.default = 4;
        globalFragment.providers = {};
        globalFragment.models = {};
      } else {
        const section = update.scope === "provider"
          ? globalFragment.providers
          : globalFragment.models;
        if (update.limit === null) delete section[update.key];
        else section[update.key] = update.limit;
      }
      return { ok: true };
    },
  };
  const debug: DebugSettingsOwner = {
    read: () => ({}),
    agentTypes: () => [{ name: "general-purpose", description: "General agent", hidden: false }],
    diagnostics: () => ({ ok: true, diagnostics: { agents: [] } }),
    setStatusPreview: () => ({ ok: true }),
    armFault: () => ({ ok: true }),
  };
  // Minimal stateful policy fake: the renderer suite only needs the root page
  // toggle and the confirm-gated reset; page composition is the module's test.
  const modelAccessState = { enabled: false, resets: 0 };
  const rootView = () => ({
    enabled: modelAccessState.enabled,
    parentModelKey: "anthropic/opus",
    enabledProviderCount: 0,
    configuredAgentCount: 0,
    unavailableProviders: [],
    unavailableRules: [],
  });
  const unsupported = (verb: string) => (): never => {
    throw new Error(`renderer suite does not exercise ${verb}`);
  };
  const modelAccess: ModelAccessSettingsOwner = {
    root: rootView,
    agents: () => [],
    quickAgents: () => [],
    agentDetail: unsupported("agentDetail"),
    providers: () => ({ parentModelKey: "anthropic/opus", providers: [] }),
    models: unsupported("models"),
    thinkingTargets: () => [],
    thinking: unsupported("thinking"),
    setEnabled(enabled) {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      modelAccessState.enabled = enabled;
      return { ok: true };
    },
    setProviderEnabled: unsupported("setProviderEnabled"),
    setParentAccess: unsupported("setParentAccess"),
    toggleAllModels: unsupported("toggleAllModels"),
    toggleModel: unsupported("toggleModel"),
    toggleThinkingLevel: unsupported("toggleThinkingLevel"),
    setThinkingDefault: unsupported("setThinkingDefault"),
    resetThinking: unsupported("resetThinking"),
    deleteProviderRules: unsupported("deleteProviderRules"),
    cleanUnavailableRules: unsupported("cleanUnavailableRules"),
    clearAll() {
      if (options.failUpdatesWith) return { ok: false, message: options.failUpdatesWith };
      modelAccessState.enabled = false;
      modelAccessState.resets += 1;
      return { ok: true };
    },
  };
  const settings = createSettings({
    summaries: { read: () => ({ modelAccessEnabled: false, concurrencyDefault: 4 }) },
    display,
    spawn,
    prompt,
    concurrency,
    debug,
    modelAccess,
  });
  return Object.assign(settings, { modelAccessState });
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

describe("settings screen renderer contract", () => {
  it("renders the root categories with summaries and closes on Escape", async () => {
    const { ctx, renders } = createScriptedCtx([
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings());

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
    await runSettingsScreen(ctx, createRealSettings());

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
    await runSettingsScreen(ctx, createRealSettings({ failUpdatesWith: "disk full" }));

    expect(notifications).toHaveBeenCalledWith("Failed to save setting: disk full", "error");
    // The row shows the saved ON value again instead of the failed OFF attempt.
    expect(failedFormText).toMatch(/Expand list by default\s+ON/);
  });

  it("stays on the display form when the real owner returns persistence-failure", async () => {
    const { display, store } = persistFailingDisplayOwner("disk full");
    let ownerWrite: unknown;
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
    await runSettingsScreen(ctx, createRealSettings({
      display: {
        read: () => display.read(),
        update(id, value) {
          ownerWrite = display.update(id, value);
          return ownerWrite as ReturnType<DisplaySettingsOwner["update"]>;
        },
      },
    }));

    expect(ownerWrite).toEqual({
      ok: false,
      code: "persistence-failure",
      message: "disk full",
    });
    expect(notifications).toHaveBeenCalledWith("Failed to save setting: disk full", "error");
    expect(notifications).not.toHaveBeenCalledWith(
      expect.stringContaining("does not match its contract"),
      expect.anything(),
    );
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
    expect(failedFormText).toMatch(/Expand list by default\s+ON/);
    expect(store.read().expandListByDefault).toBe(true);
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
    await runSettingsScreen(ctx, createRealSettings());

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
    await runSettingsScreen(ctx, createRealSettings());

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
    await runSettingsScreen(ctx, createRealSettings());

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
    await runSettingsScreen(ctx, createRealSettings());

    expect(renders[1]).toContain("Provider · anthropic");
    expect(notifications).toHaveBeenCalledWith("anthropic concurrency set to 5 (Global)", "info");
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
    await runSettingsScreen(ctx, createRealSettings());

    expect(notifications).toHaveBeenCalledWith("Removed Provider limit for anthropic (Global)", "info");
  });

  it("removes the explicit fallback default through the same remove gesture", async () => {
    const { ctx, notifications } = createScriptedCtx([
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\r");     // first row: "Fallback model limit" opens edit-or-remove
        component.handleInput("\x1b[B"); // move to "Remove limit"
        component.handleInput("\r");
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings());

    expect(notifications).toHaveBeenCalledWith("Removed fallback model limit (Global)", "info");
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
    await runSettingsScreen(ctx, createRealSettings());

    expect(notifications).toHaveBeenCalledWith("openai/gpt-5 concurrency set to 3 (Global)", "info");
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
    await runSettingsScreen(ctx, createRealSettings());

    const resets = notifications.mock.calls.filter(([message]) => message === "Concurrency reset");
    expect(resets).toHaveLength(1);
  });

  it("toggles a menu-page policy in place without leaving the visit", async () => {
    let toggledText = "";
    const { ctx, renders, notifications } = createScriptedCtx([
      (component) => {
        // "Model access" is the first row; enter its native menu page.
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\r"); // toggle "Alternate models" in place
        toggledText = component.render(120).join("\n");
        component.handleInput("\x1b"); // back to the root
      },
      (component) => component.handleInput("\x1b"),
    ]);
    const settings = createRealSettings();
    await runSettingsScreen(ctx, settings);

    // Three visits: root, model access, root again. The toggle itself
    // rebuilt the same visit instead of opening a fourth one.
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
    expect(renders[1]).toContain("Model Access");
    expect(renders[1]).toContain("Alternate models · OFF");
    expect(toggledText).toContain("Alternate models · ON");
    expect(settings.modelAccessState.enabled).toBe(true);
    expect(notifications).toHaveBeenCalledWith("Alternate models enabled", "info");
    expect(renders[2]).toContain("Agents");
  });

  it("gates destructive menu actions behind a confirm dialog and fires once on Yes", async () => {
    let dialogText = "";
    const { ctx, notifications } = createScriptedCtx([
      (component) => component.handleInput("\r"),
      (component) => {
        component.handleInput("\x1b[A"); // wrap upward to "Reset Model access"
        component.handleInput("\r");     // open the confirm dialog
        dialogText = component.render(120).join("\n");
        component.handleInput("\x1b");   // Escape → no reset, back to the list
        component.handleInput("\r");     // reopen the dialog
        component.handleInput("\r");     // Yes is preselected → confirm
        component.handleInput("\x1b");   // leave the page
      },
      (component) => component.handleInput("\x1b"),
    ]);
    const settings = createRealSettings();
    await runSettingsScreen(ctx, settings);

    expect(dialogText).toContain("Reset all Model access settings?");
    expect(settings.modelAccessState.resets).toBe(1);
    const resets = notifications.mock.calls.filter(([message]) => message === "Model access reset");
    expect(resets).toHaveLength(1);
  });

  it("fires a debug report action and shows the formatted report", async () => {
    const { ctx, renders, notifications } = createScriptedCtx([
      (component) => {
        // "Debug" is the last row; \x1b[A wraps upward to it.
        component.handleInput("\x1b[A");
        component.handleInput("\r");
      },
      (component) => {
        component.handleInput("\r"); // "Agent types" action row
        component.handleInput("\x1b");
      },
      (component) => component.handleInput("\x1b"),
    ]);
    await runSettingsScreen(ctx, createRealSettings());

    expect(renders[1]).toContain("Debug");
    expect(renders[1]).toContain("Runtime diagnostics");
    // The list shows 10 rows at a time; fault rows sit below the fold.
    expect(renders[1]).toContain("Preview: Queued");
    expect(notifications).toHaveBeenCalledWith(
      expect.stringContaining("Available agent types:"),
      "info",
    );
  });
});
