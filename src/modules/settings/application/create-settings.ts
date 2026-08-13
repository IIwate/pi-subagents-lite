import { Check } from "typebox/value";
import {
  SettingsCommandSchema,
  type SettingsNotice,
  type SettingsResult,
  type SettingsSnapshot,
} from "../contracts/settings-contracts.js";
import {
  buildDisplayRows,
  displayChangeNotice,
  displayToggleDefinition,
} from "../core/display-page.js";
import { buildRootRows, LEGACY_CATEGORY_IDS } from "../core/root-page.js";
import type { DisplaySettingsOwner } from "../ports/display-settings-owner.js";
import type { SettingsSummaryReader } from "../ports/settings-summary-reader.js";

export interface CreateSettingsOptions {
  summaries: SettingsSummaryReader;
  display: DisplaySettingsOwner;
}

export interface Settings {
  execute(command: unknown): SettingsResult;
}

type PageId = "root" | "display";

export function createSettings(options: CreateSettingsOptions): Settings {
  let page: PageId = "root";

  const rootSnapshot = (): SettingsSnapshot => ({
    page: "root",
    title: "Agents",
    presentation: "menu",
    rows: buildRootRows(options.summaries.read()),
  });

  const displaySnapshot = (notice?: SettingsNotice): SettingsSnapshot => ({
    page: "display",
    title: "Display Settings",
    presentation: "form",
    rows: buildDisplayRows(options.display.read()),
    ...(notice ? { notice } : {}),
  });

  const failure = (code: "invalid-command" | "unknown-row" | "invalid-value", message: string): SettingsResult =>
    ({ ok: false, error: { code, message } });

  return {
    execute(command: unknown): SettingsResult {
      if (!Check(SettingsCommandSchema, command)) {
        return failure("invalid-command", "Command does not match the settings command schema.");
      }
      switch (command.kind) {
        case "open": {
          page = "root";
          return { ok: true, snapshot: rootSnapshot() };
        }
        case "back": {
          if (page === "display") {
            page = "root";
            return { ok: true, snapshot: rootSnapshot() };
          }
          return { ok: true, snapshot: rootSnapshot(), effect: { kind: "close" } };
        }
        case "select": {
          if (page !== "root") {
            return failure("unknown-row", `Page ${page} has no selectable row ${command.id}.`);
          }
          if (command.id === "display") {
            page = "display";
            return { ok: true, snapshot: displaySnapshot() };
          }
          if (LEGACY_CATEGORY_IDS.includes(command.id)) {
            return {
              ok: true,
              snapshot: rootSnapshot(),
              effect: { kind: "open-legacy-category", category: command.id },
            };
          }
          return failure("unknown-row", `Root has no category ${command.id}.`);
        }
        case "set-value": {
          if (page !== "display" || !displayToggleDefinition(command.id)) {
            return failure("unknown-row", `Page ${page} has no editable row ${command.id}.`);
          }
          if (command.value !== "ON" && command.value !== "OFF") {
            return failure("invalid-value", `Toggle ${command.id} accepts ON or OFF, not ${command.value}.`);
          }
          const id = command.id as Parameters<DisplaySettingsOwner["update"]>[0];
          const value = command.value === "ON";
          const result = options.display.update(id, value);
          if (!result.ok) {
            // The owner keeps the previous value effective; the snapshot below
            // re-reads it so the renderer shows saved state, not the attempt.
            return {
              ok: true,
              snapshot: displaySnapshot({
                severity: "error",
                message: `Failed to save setting: ${result.message}`,
              }),
            };
          }
          return {
            ok: true,
            snapshot: displaySnapshot({
              severity: "info",
              message: displayChangeNotice(id, value),
            }),
          };
        }
      }
    },
  };
}
