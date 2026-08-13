import { Check } from "typebox/value";
import {
  SettingsCommandSchema,
  type SettingsNotice,
  type SettingsResult,
  type SettingsSnapshot,
  type SystemPromptMode,
} from "../contracts/settings-contracts.js";
import {
  buildDisplayRows,
  displayChangeNotice,
  displayToggleDefinition,
} from "../core/display-page.js";
import { buildRootRows, LEGACY_CATEGORY_IDS } from "../core/root-page.js";
import {
  buildSpawnOptionsRows,
  GRACE_TURNS_MINIMUM,
  spawnChangeNotice,
} from "../core/spawn-options-page.js";
import {
  buildSystemPromptRows,
  promptChangeNotice,
  SYSTEM_PROMPT_MODES,
} from "../core/system-prompt-page.js";
import type { DisplaySettingsOwner } from "../ports/display-settings-owner.js";
import type { PromptSettingsOwner } from "../ports/prompt-settings-owner.js";
import type { SettingsSummaryReader } from "../ports/settings-summary-reader.js";
import type { SpawnSettingsOwner } from "../ports/spawn-settings-owner.js";

export interface CreateSettingsOptions {
  summaries: SettingsSummaryReader;
  display: DisplaySettingsOwner;
  spawn: SpawnSettingsOwner;
  prompt: PromptSettingsOwner;
}

export interface Settings {
  execute(command: unknown): SettingsResult;
}

type PageId = "root" | "display" | "spawn-options" | "system-prompt";

type SettingsFailureCode = "invalid-command" | "unknown-row" | "invalid-value";

export function createSettings(options: CreateSettingsOptions): Settings {
  let page: PageId = "root";

  const snapshots: Record<PageId, (notice?: SettingsNotice) => SettingsSnapshot> = {
    "root": () => ({
      page: "root",
      title: "Agents",
      presentation: "menu",
      rows: buildRootRows(options.summaries.read()),
    }),
    "display": (notice) => ({
      page: "display",
      title: "Display Settings",
      presentation: "form",
      rows: buildDisplayRows(options.display.read()),
      ...(notice ? { notice } : {}),
    }),
    "spawn-options": (notice) => ({
      page: "spawn-options",
      title: "Spawn Options",
      presentation: "form",
      rows: buildSpawnOptionsRows(options.spawn.read()),
      ...(notice ? { notice } : {}),
    }),
    "system-prompt": (notice) => ({
      page: "system-prompt",
      title: "System Prompt",
      presentation: "form",
      rows: buildSystemPromptRows(options.prompt.read()),
      ...(notice ? { notice } : {}),
    }),
  };

  const failure = (code: SettingsFailureCode, message: string): SettingsResult =>
    ({ ok: false, error: { code, message } });

  const saveFailureNotice = (message: string): SettingsNotice =>
    ({ severity: "error", message: `Failed to save setting: ${message}` });

  /** Route a committed-or-failed owner update into the page snapshot. */
  const updated = (
    pageId: PageId,
    result: { ok: true } | { ok: false; message: string },
    notice: string,
  ): SettingsResult => ({
    ok: true,
    snapshot: snapshots[pageId](result.ok
      ? { severity: "info", message: notice }
      : saveFailureNotice(result.message)),
  });

  const setDisplayValue = (id: string, value: string): SettingsResult => {
    if (!displayToggleDefinition(id)) {
      return failure("unknown-row", `Page display has no editable row ${id}.`);
    }
    if (value !== "ON" && value !== "OFF") {
      return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
    }
    const toggleId = id as Parameters<DisplaySettingsOwner["update"]>[0];
    const enabled = value === "ON";
    return updated("display", options.display.update(toggleId, enabled), displayChangeNotice(toggleId, enabled));
  };

  const setSpawnValue = (id: string, value: string): SettingsResult => {
    if (id === "forceBackground" || id === "disableDefaultAgents") {
      if (value !== "ON" && value !== "OFF") {
        return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
      }
      const enabled = value === "ON";
      return updated("spawn-options", options.spawn.update({ id, value: enabled }), spawnChangeNotice(id, enabled));
    }
    if (id === "graceTurns") {
      // Digits-only guard: Number("") is 0 and Number accepts exponents, so a
      // plain Number() check would silently accept host garbage.
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) < GRACE_TURNS_MINIMUM) {
        return failure("invalid-value", `Grace turns must be an integer >= ${GRACE_TURNS_MINIMUM}, not ${value}.`);
      }
      const parsed = Number(trimmed);
      return updated("spawn-options", options.spawn.update({ id, value: parsed }), spawnChangeNotice(id, parsed));
    }
    return failure("unknown-row", `Page spawn-options has no editable row ${id}.`);
  };

  const setSystemPromptValue = (id: string, value: string): SettingsResult => {
    if (id === "systemPromptMode") {
      if (!SYSTEM_PROMPT_MODES.includes(value)) {
        return failure("invalid-value", `System prompt mode accepts ${SYSTEM_PROMPT_MODES.join(", ")}, not ${value}.`);
      }
      const mode = value as SystemPromptMode;
      return updated("system-prompt", options.prompt.update({ id, value: mode }), promptChangeNotice(id, mode));
    }
    if (id === "includeContextFiles" || id === "loadSkillsImplicitly" || id === "loadExtensionsImplicitly") {
      if (value !== "ON" && value !== "OFF") {
        return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
      }
      const enabled = value === "ON";
      return updated("system-prompt", options.prompt.update({ id, value: enabled }), promptChangeNotice(id, enabled));
    }
    if (id === "createPromptFile") {
      const path = options.prompt.read().customPromptPath;
      const result = options.prompt.createCustomPromptFile();
      return {
        ok: true,
        snapshot: snapshots["system-prompt"](result.ok
          ? { severity: "info", message: `Created prompt file: ${path}` }
          : { severity: "error", message: `Failed to create prompt file: ${result.message}` }),
      };
    }
    return failure("unknown-row", `Page system-prompt has no editable row ${id}.`);
  };

  return {
    execute(command: unknown): SettingsResult {
      if (!Check(SettingsCommandSchema, command)) {
        return failure("invalid-command", "Command does not match the settings command schema.");
      }
      switch (command.kind) {
        case "open": {
          page = "root";
          return { ok: true, snapshot: snapshots.root() };
        }
        case "back": {
          if (page !== "root") {
            page = "root";
            return { ok: true, snapshot: snapshots.root() };
          }
          return { ok: true, snapshot: snapshots.root(), effect: { kind: "close" } };
        }
        case "select": {
          if (page !== "root") {
            return failure("unknown-row", `Page ${page} has no selectable row ${command.id}.`);
          }
          if (command.id === "display" || command.id === "spawn-options" || command.id === "system-prompt") {
            page = command.id;
            return { ok: true, snapshot: snapshots[page]() };
          }
          if (LEGACY_CATEGORY_IDS.includes(command.id)) {
            return {
              ok: true,
              snapshot: snapshots.root(),
              effect: { kind: "open-legacy-category", category: command.id },
            };
          }
          return failure("unknown-row", `Root has no category ${command.id}.`);
        }
        case "set-value": {
          switch (page) {
            case "display": return setDisplayValue(command.id, command.value);
            case "spawn-options": return setSpawnValue(command.id, command.value);
            case "system-prompt": return setSystemPromptValue(command.id, command.value);
            default: return failure("unknown-row", `Page ${page} has no editable row ${command.id}.`);
          }
        }
      }
    },
  };
}
