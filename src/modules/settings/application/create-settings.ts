import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  ConcurrencySettingsViewSchema,
  DebugAgentTypeSchema,
  DebugDiagnosticsViewSchema,
  DebugSettingsViewSchema,
  DisplaySettingsViewSchema,
  ModelAccessAgentDetailViewSchema,
  ModelAccessAgentRowSchema,
  ModelAccessModelsViewSchema,
  ModelAccessProvidersViewSchema,
  ModelAccessRootViewSchema,
  ModelAccessThinkingTargetSchema,
  ModelAccessThinkingViewSchema,
  PromptSettingsViewSchema,
  RootSummariesSchema,
  SettingsCommandSchema,
  SettingsResultSchema,
  SettingsUpdateResultSchema,
  SpawnSettingsViewSchema,
  type ConcurrencySettingsView,
  type DebugAgentType,
  type DebugDiagnosticsView,
  type DebugSettingsView,
  type DisplaySettingsView,
  type ModelAccessAgentDetailView,
  type ModelAccessAgentRow,
  type ModelAccessModelsView,
  type ModelAccessProvidersView,
  type ModelAccessRootView,
  type ModelAccessThinkingTarget,
  type ModelAccessThinkingView,
  type PromptSettingsView,
  type RootSummaries,
  type SettingsNotice,
  type SettingsResult,
  type SettingsSnapshot,
  type SettingsUpdateResult,
  type SpawnSettingsView,
} from "../contracts/settings-contracts.js";
import { SystemPromptModeSchema, type SystemPromptMode } from "../../prompt/public.js";
import {
  buildConcurrencyRows,
  CONCURRENCY_LIMIT_MINIMUM,
  parseLimitRowId,
  targetLabel,
} from "../core/concurrency-page.js";
import {
  buildDebugRows,
  faultForRow,
  formatAgentTypesReport,
  formatDiagnosticsReport,
  previewForRow,
  previewLabel,
  previewNotice,
} from "../core/debug-page.js";
import {
  buildDisplayRows,
  displayChangeNotice,
  displayToggleDefinition,
} from "../core/display-page.js";
import {
  buildAgentDetailRows,
  buildAgentListRows,
  buildModelAccessRootRows,
  buildModelsRows,
  buildProvidersRows,
  buildThinkingRows,
  buildThinkingTargetRows,
  buildUnavailableProviderRows,
  buildUnavailableProvidersRows,
  keyForRow,
  nextThinkingDefault,
} from "../core/model-access-pages.js";
import { buildRootRows } from "../core/root-page.js";
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
import type { ConcurrencySettingsOwner } from "../ports/concurrency-settings-owner.js";
import type { DebugSettingsOwner } from "../ports/debug-settings-owner.js";
import type { DisplaySettingsOwner } from "../ports/display-settings-owner.js";
import type { ModelAccessSettingsOwner } from "../ports/model-access-settings-owner.js";
import type { PromptSettingsOwner } from "../ports/prompt-settings-owner.js";
import type { SettingsSummaryReader } from "../ports/settings-summary-reader.js";
import type { SpawnSettingsOwner } from "../ports/spawn-settings-owner.js";

export interface CreateSettingsOptions {
  summaries: SettingsSummaryReader;
  display: DisplaySettingsOwner;
  spawn: SpawnSettingsOwner;
  prompt: PromptSettingsOwner;
  concurrency: ConcurrencySettingsOwner;
  debug: DebugSettingsOwner;
  modelAccess: ModelAccessSettingsOwner;
}

export interface Settings {
  execute(command: unknown): SettingsResult;
}

/**
 * Pages are a stack so nested model-access pages unwind one level per `back`.
 * Parameterized pages carry their subject; snapshots rebuild from live owner
 * views, so a page never caches policy state between commands.
 */
type Page =
  | { id: "root" }
  | { id: "display" }
  | { id: "spawn-options" }
  | { id: "system-prompt" }
  // The write target is session-local page state: entering the page always
  // starts on Global, and switching targets performs no IO (REQ-CONFIG-003).
  | { id: "concurrency"; target: "global" | "project" }
  | { id: "debug" }
  | { id: "model-access" }
  | { id: "ma-quick-agents" }
  | { id: "ma-providers" }
  | { id: "ma-agents" }
  | { id: "ma-agent"; type: string }
  | { id: "ma-models"; type: string; provider: string; quick: boolean }
  | { id: "ma-thinking-targets"; type: string }
  | { id: "ma-thinking"; type: string; modelKey: string }
  | { id: "ma-unavailable" }
  | { id: "ma-unavailable-provider"; provider: string };

type SettingsFailureCode = "invalid-command" | "unknown-row" | "invalid-value" | "invalid-snapshot";

const ModelAccessAgentRowsSchema = Type.Array(ModelAccessAgentRowSchema);
const ModelAccessThinkingTargetsSchema = Type.Array(ModelAccessThinkingTargetSchema);
const DebugAgentTypesSchema = Type.Array(DebugAgentTypeSchema);

// Owner views are replaceable ports. A page that renders an unchecked view
// would treat a missing field as a product state — Alternate models off,
// an empty inventory — and the user would act on a lie. Fail closed here;
// revisit only if a view is documented as partially available.
function ownerView<T>(schema: TSchema, value: unknown): T | undefined {
  return Check(schema, value) ? value as T : undefined;
}

/**
 * Owner writes are replaceable ports. Reading `.ok` on an unchecked
 * payload is how `{ ok: "yes" }` becomes a success notice after nothing
 * was saved. Fail closed before the page treats the write as committed.
 */
function ownerWrite(result: unknown): SettingsUpdateResult | undefined {
  return Check(SettingsUpdateResultSchema, result) ? result : undefined;
}

export function createSettings(options: CreateSettingsOptions): Settings {
  let stack: Page[] = [{ id: "root" }];
  const current = (): Page => stack[stack.length - 1]!;
  const push = (page: Page): void => { stack.push(page); };

  const buildSnapshot = (page: Page, notice?: SettingsNotice): SettingsSnapshot | undefined => {
    const withNotice = (snapshot: Omit<SettingsSnapshot, "notice">): SettingsSnapshot =>
      ({ ...snapshot, ...(notice ? { notice } : {}) });
    switch (page.id) {
      case "root": {
        const view = ownerView<RootSummaries>(RootSummariesSchema, options.summaries.read());
        if (!view) return undefined;
        return withNotice({
          page: "root",
          title: "Agents",
          presentation: "menu",
          rows: buildRootRows(view),
        });
      }
      case "display": {
        const view = ownerView<DisplaySettingsView>(DisplaySettingsViewSchema, options.display.read());
        if (!view) return undefined;
        return withNotice({
          page: "display",
          title: "Display Settings",
          presentation: "form",
          rows: buildDisplayRows(view),
        });
      }
      case "spawn-options": {
        const view = ownerView<SpawnSettingsView>(SpawnSettingsViewSchema, options.spawn.read());
        if (!view) return undefined;
        return withNotice({
          page: "spawn-options",
          title: "Spawn Options",
          presentation: "form",
          rows: buildSpawnOptionsRows(view),
        });
      }
      case "system-prompt": {
        const view = ownerView<PromptSettingsView>(PromptSettingsViewSchema, options.prompt.read());
        if (!view) return undefined;
        return withNotice({
          page: "system-prompt",
          title: "System Prompt",
          presentation: "form",
          rows: buildSystemPromptRows(view),
        });
      }
      case "concurrency": {
        const view = ownerView<ConcurrencySettingsView>(ConcurrencySettingsViewSchema, options.concurrency.read());
        if (!view) return undefined;
        return withNotice({
          page: "concurrency",
          title: "Concurrency",
          presentation: "form",
          rows: buildConcurrencyRows(view, page.target),
        });
      }
      case "debug": {
        const view = ownerView<DebugSettingsView>(DebugSettingsViewSchema, options.debug.read());
        if (!view) return undefined;
        return withNotice({
          page: "debug",
          title: "Debug",
          presentation: "form",
          rows: buildDebugRows(view),
        });
      }
      case "model-access": {
        const view = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
        if (!view) return undefined;
        return withNotice({
          page: "model-access",
          title: "Model Access",
          presentation: "menu",
          rows: buildModelAccessRootRows(view),
        });
      }
      case "ma-quick-agents": {
        const rows = ownerView<ModelAccessAgentRow[]>(ModelAccessAgentRowsSchema, options.modelAccess.quickAgents());
        if (!rows) return undefined;
        return withNotice({
          page: "model-access/quick-agents",
          title: "Quick Model Setup",
          presentation: "menu",
          rows: buildAgentListRows(rows),
        });
      }
      case "ma-providers": {
        const view = ownerView<ModelAccessProvidersView>(ModelAccessProvidersViewSchema, options.modelAccess.providers());
        if (!view) return undefined;
        return withNotice({
          page: "model-access/providers",
          title: "Provider Access",
          presentation: "menu",
          rows: buildProvidersRows(view),
        });
      }
      case "ma-agents": {
        const rows = ownerView<ModelAccessAgentRow[]>(ModelAccessAgentRowsSchema, options.modelAccess.agents());
        if (!rows) return undefined;
        return withNotice({
          page: "model-access/agents",
          title: "Agent Access",
          presentation: "menu",
          rows: buildAgentListRows(rows),
        });
      }
      case "ma-agent": {
        const view = ownerView<ModelAccessAgentDetailView>(
          ModelAccessAgentDetailViewSchema,
          options.modelAccess.agentDetail(page.type),
        );
        if (!view) return undefined;
        return withNotice({
          page: "model-access/agent",
          title: `Agent Access · ${page.type}`,
          presentation: "menu",
          rows: buildAgentDetailRows(view),
        });
      }
      case "ma-models": {
        const view = ownerView<ModelAccessModelsView>(
          ModelAccessModelsViewSchema,
          options.modelAccess.models(page.type, page.provider),
        );
        if (!view) return undefined;
        return withNotice({
          page: "model-access/models",
          title: page.quick
            ? `Quick Setup · ${page.type} · ${page.provider}`
            : `Models · ${page.type} · ${page.provider}`,
          presentation: "menu",
          rows: buildModelsRows(view),
        });
      }
      case "ma-thinking-targets": {
        const targets = ownerView<ModelAccessThinkingTarget[]>(
          ModelAccessThinkingTargetsSchema,
          options.modelAccess.thinkingTargets(page.type),
        );
        if (!targets) return undefined;
        return withNotice({
          page: "model-access/thinking-targets",
          title: `Thinking · ${page.type}`,
          presentation: "menu",
          rows: buildThinkingTargetRows(targets),
        });
      }
      case "ma-thinking": {
        const view = ownerView<ModelAccessThinkingView>(
          ModelAccessThinkingViewSchema,
          options.modelAccess.thinking(page.type, page.modelKey),
        );
        if (!view) return undefined;
        return withNotice({
          page: "model-access/thinking",
          title: `Thinking · ${page.type} · ${page.modelKey}`,
          presentation: "menu",
          rows: buildThinkingRows(view),
        });
      }
      case "ma-unavailable": {
        const view = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
        if (!view) return undefined;
        return withNotice({
          page: "model-access/unavailable",
          title: "Unavailable Providers",
          presentation: "menu",
          rows: buildUnavailableProvidersRows(view),
        });
      }
      case "ma-unavailable-provider": {
        const root = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
        if (!root) return undefined;
        const entry = root.unavailableProviders
          .find((candidate) => candidate.provider === page.provider);
        if (!entry) {
          // The provider became available (or its rules disappeared) while
          // this page was open; unwind to the list instead of showing a
          // stale management page.
          stack.pop();
          return buildSnapshot(current(), { severity: "info", message: "No saved access rules remain" });
        }
        return withNotice({
          page: "model-access/unavailable-provider",
          title: `Unavailable · ${page.provider}`,
          presentation: "menu",
          rows: buildUnavailableProviderRows(entry),
        });
      }
    }
  };

  const failure = (code: SettingsFailureCode, message: string): SettingsResult =>
    ({ ok: false, error: { code, message } });

  const snapshotResult = (
    snapshot: SettingsSnapshot | undefined,
    extra?: { effect?: { kind: "close" } },
  ): SettingsResult =>
    snapshot
      ? { ok: true, snapshot, ...extra }
      : failure("invalid-snapshot", "Settings page does not match its contract.");

  const failureNotice = (message: string): SettingsNotice =>
    ({ severity: "error", message: `Failed to save setting: ${message}` });

  const infoSnapshot = (message: string): SettingsResult =>
    snapshotResult(buildSnapshot(current(), { severity: "info", message }));

  /** Route a committed-or-failed owner update into the current page snapshot. */
  const updated = (result: unknown, notice: string): SettingsResult => {
    const checked = ownerWrite(result);
    if (!checked) return failure("invalid-snapshot", "Settings update result does not match its contract.");
    return snapshotResult(buildSnapshot(current(), checked.ok
      ? { severity: "info", message: notice }
      : failureNotice(checked.message)));
  };

  const navigate = (page: Page): SettingsResult => {
    push(page);
    return snapshotResult(buildSnapshot(current()));
  };

  const setDisplayValue = (id: string, value: string): SettingsResult => {
    if (!displayToggleDefinition(id)) {
      return failure("unknown-row", `Page display has no editable row ${id}.`);
    }
    if (value !== "ON" && value !== "OFF") {
      return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
    }
    const toggleId = id as Parameters<DisplaySettingsOwner["update"]>[0];
    const enabled = value === "ON";
    return updated(options.display.update(toggleId, enabled), displayChangeNotice(toggleId, enabled));
  };

  const setSpawnValue = (id: string, value: string): SettingsResult => {
    if (id === "forceBackground" || id === "disableDefaultAgents") {
      if (value !== "ON" && value !== "OFF") {
        return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
      }
      const enabled = value === "ON";
      return updated(options.spawn.update({ id, value: enabled }), spawnChangeNotice(id, enabled));
    }
    if (id === "graceTurns") {
      // Digits-only guard: Number("") is 0 and Number accepts exponents, so a
      // plain Number() check would silently accept host garbage.
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) < GRACE_TURNS_MINIMUM) {
        return failure("invalid-value", `Grace turns must be an integer >= ${GRACE_TURNS_MINIMUM}, not ${value}.`);
      }
      const parsed = Number(trimmed);
      return updated(options.spawn.update({ id, value: parsed }), spawnChangeNotice(id, parsed));
    }
    return failure("unknown-row", `Page spawn-options has no editable row ${id}.`);
  };

  const setSystemPromptValue = (id: string, value: string): SettingsResult => {
    if (id === "systemPromptMode") {
      if (!Check(SystemPromptModeSchema, value)) {
        return failure("invalid-value", `System prompt mode accepts ${SYSTEM_PROMPT_MODES.join(", ")}, not ${value}.`);
      }
      const mode = value as SystemPromptMode;
      return updated(options.prompt.update({ id, value: mode }), promptChangeNotice(id, mode));
    }
    if (id === "includeContextFiles" || id === "loadSkillsImplicitly" || id === "loadExtensionsImplicitly") {
      if (value !== "ON" && value !== "OFF") {
        return failure("invalid-value", `Toggle ${id} accepts ON or OFF, not ${value}.`);
      }
      const enabled = value === "ON";
      return updated(options.prompt.update({ id, value: enabled }), promptChangeNotice(id, enabled));
    }
    if (id === "createPromptFile") {
      const prompt = ownerView<PromptSettingsView>(PromptSettingsViewSchema, options.prompt.read());
      if (!prompt) return failure("invalid-snapshot", "Settings page does not match its contract.");
      const path = prompt.customPromptPath;
      const result = ownerWrite(options.prompt.createCustomPromptFile());
      if (!result) return failure("invalid-snapshot", "Settings update result does not match its contract.");
      return snapshotResult(buildSnapshot(current(), result.ok
        ? { severity: "info", message: `Created prompt file: ${path}` }
        : { severity: "error", message: `Failed to create prompt file: ${result.message}` }));
    }
    return failure("unknown-row", `Page system-prompt has no editable row ${id}.`);
  };

  const setConcurrencyValue = (page: Page & { id: "concurrency" }, id: string, value: string): SettingsResult => {
    const view = ownerView<ConcurrencySettingsView>(ConcurrencySettingsViewSchema, options.concurrency.read());
    if (!view) return failure("invalid-snapshot", "Settings page does not match its contract.");
    // A shadowed global write still lands on disk but changes only the
    // inherited value; the notice must say so or the page looks broken.
    const shadowSuffix = (shadowed: boolean): string =>
      shadowed ? " (shadowed by a project override; effective value unchanged)" : "";
    if (id === "writeTarget") {
      if (value !== "Global" && value !== "Project") {
        return failure("invalid-value", `Write target accepts Global or Project, not ${value}.`);
      }
      if (value === "Project" && !view.projectLayer.writable) {
        return failure("unknown-row", "Project write target is not available in this session.");
      }
      // Pure page-state change: rebuild the row set, no IO, no commit.
      page.target = value === "Global" ? "global" : "project";
      return snapshotResult(buildSnapshot(current()));
    }
    if (id === "defaultConcurrency") {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) < CONCURRENCY_LIMIT_MINIMUM) {
        return failure("invalid-value", `Fallback model limit must be an integer >= ${CONCURRENCY_LIMIT_MINIMUM}, not ${value}.`);
      }
      const limit = Number(trimmed);
      const shadowed = page.target === "global" && view.provenance.default === "project";
      return updated(
        options.concurrency.update({ target: page.target, update: { scope: "default", limit } }),
        `Fallback model limit set to ${limit} (${targetLabel(page.target)})${shadowSuffix(shadowed)}`,
      );
    }
    if (id === "resetAll") {
      return updated(
        options.concurrency.update({ target: page.target, update: { scope: "reset" } }),
        page.target === "global" ? "Concurrency reset" : "Project concurrency overrides reset",
      );
    }
    return failure("unknown-row", `Page concurrency has no editable row ${id}.`);
  };

  const setDebugValue = (id: string): SettingsResult => {
    // Debug operations are session-local, never persisted (REQ-RUNTIME-007).
    // Owner failures mean the runtime or child screen is unavailable in this
    // session; the frozen menu behavior reports that as an informational
    // notice, not a save error.
    if (id === "agentTypes") {
      const types = ownerView<DebugAgentType[]>(DebugAgentTypesSchema, options.debug.agentTypes());
      if (!types) return failure("invalid-snapshot", "Settings page does not match its contract.");
      return infoSnapshot(formatAgentTypesReport(types));
    }
    if (id === "runtimeDiagnostics") {
      const result = options.debug.diagnostics();
      if (!result.ok) return infoSnapshot(result.message);
      const diagnostics = ownerView<DebugDiagnosticsView>(DebugDiagnosticsViewSchema, result.diagnostics);
      if (!diagnostics) return failure("invalid-snapshot", "Settings page does not match its contract.");
      return infoSnapshot(formatDiagnosticsReport(diagnostics));
    }
    const preview = previewForRow(id);
    if (preview !== undefined) {
      const result = ownerWrite(options.debug.setStatusPreview(preview));
      if (!result) return failure("invalid-snapshot", "Settings update result does not match its contract.");
      if (!result.ok) return infoSnapshot(result.message);
      return infoSnapshot(previewNotice(preview, previewLabel(id)));
    }
    const fault = faultForRow(id);
    if (fault !== undefined) {
      const result = ownerWrite(options.debug.armFault(fault));
      if (!result) return failure("invalid-snapshot", "Settings update result does not match its contract.");
      if (!result.ok) return infoSnapshot(result.message);
      return infoSnapshot(fault ? `Armed ${fault} for the next agent` : "Cleared armed fault");
    }
    return failure("unknown-row", `Page debug has no editable row ${id}.`);
  };

  /** Keyed override rows: shared by in-place edits, removals, and additions. */
  const applyLimitUpdate = (
    command:
      | { kind: "update-limit"; id: string; limit: number | null }
      | { kind: "add-limit"; id: string; key: string; limit: number },
  ): SettingsResult => {
    const page = current();
    if (page.id !== "concurrency") {
      return failure("unknown-row", `Page ${page.id} has no limit row ${command.id}.`);
    }
    const view = ownerView<ConcurrencySettingsView>(ConcurrencySettingsViewSchema, options.concurrency.read());
    if (!view) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const layer = page.target === "global" ? view.global : view.project;
    const shadowSuffix = (scope: "provider" | "model", key: string): string =>
      page.target === "global"
        && view.provenance[scope === "provider" ? "providers" : "models"][key] === "project"
        ? " (shadowed by a project override; effective value unchanged)"
        : "";
    if (command.kind === "add-limit") {
      const scope = command.id === "addProviderLimit"
        ? "provider" as const
        : command.id === "addModelLimit" ? "model" as const : undefined;
      if (!scope) return failure("unknown-row", `Page concurrency has no picker row ${command.id}.`);
      const inventory = scope === "provider" ? view.activeProviders : view.activeModels;
      if (!inventory.includes(command.key)) {
        return failure("invalid-value", `${command.key} is not in the active ${scope} inventory.`);
      }
      return updated(
        options.concurrency.update({
          target: page.target,
          update: { scope, key: command.key, limit: command.limit },
        }),
        `${command.key} concurrency set to ${command.limit} (${targetLabel(page.target)})${shadowSuffix(scope, command.key)}`,
      );
    }
    const target = parseLimitRowId(command.id);
    if (!target) return failure("unknown-row", `Page concurrency has no limit row ${command.id}.`);
    const saved = (target.scope === "provider" ? layer.providers : layer.models) ?? {};
    if (!Object.hasOwn(saved, target.key)) {
      return failure("unknown-row", `No saved ${target.scope} limit for ${target.key} in the ${targetLabel(page.target)} layer.`);
    }
    const scopeLabel = target.scope === "provider" ? "Provider" : "Model";
    return updated(
      options.concurrency.update({
        target: page.target,
        update: { scope: target.scope, key: target.key, limit: command.limit },
      }),
      command.limit === null
        ? `Removed ${scopeLabel} limit for ${target.key} (${targetLabel(page.target)})`
        : `${target.key} concurrency set to ${command.limit} (${targetLabel(page.target)})${shadowSuffix(target.scope, target.key)}`,
    );
  };

  const selectOnRoot = (id: string): SettingsResult => {
    if (id === "concurrency") {
      // Entering the page always starts on the Global write target.
      return navigate({ id: "concurrency", target: "global" });
    }
    if (
      id === "display"
      || id === "spawn-options"
      || id === "system-prompt"
      || id === "debug"
      || id === "model-access"
    ) {
      return navigate({ id });
    }
    return failure("unknown-row", `Root has no category ${id}.`);
  };

  const selectOnModelAccessRoot = (id: string): SettingsResult => {
    const view = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
    if (!view) return failure("invalid-snapshot", "Settings page does not match its contract.");
    switch (id) {
      case "alternateModels":
        return updated(
          options.modelAccess.setEnabled(!view.enabled),
          `Alternate models ${view.enabled ? "disabled" : "enabled"}`,
        );
      case "quickSetup":
        if (view.parentModelKey === "") {
          return infoSnapshot("Select a parent model before using Quick model setup");
        }
        return navigate({ id: "ma-quick-agents" });
      case "providerAccess":
        if (!view.enabled) return failure("unknown-row", "Provider access requires alternate models.");
        return navigate({ id: "ma-providers" });
      case "agentAccess":
        return navigate({ id: "ma-agents" });
      case "unavailableProviders":
        if (!view.enabled || view.unavailableProviders.length === 0) {
          return failure("unknown-row", "No saved unavailable providers.");
        }
        return navigate({ id: "ma-unavailable" });
      case "cleanUnavailableRules": {
        const before = view.unavailableRules.length;
        const result = ownerWrite(options.modelAccess.cleanUnavailableRules());
        if (!result) return failure("invalid-snapshot", "Settings update result does not match its contract.");
        if (!result.ok) return updated(result, "");
        const after = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root())
          ?.unavailableRules.length ?? before;
        const removed = Math.max(0, before - after);
        return infoSnapshot(`Removed ${removed} unavailable model access rule${removed === 1 ? "" : "s"}`);
      }
      case "resetAll":
        return updated(options.modelAccess.clearAll(), "Model access reset");
      default:
        return failure("unknown-row", `Page model-access has no selectable row ${id}.`);
    }
  };

  const selectOnProviders = (id: string): SettingsResult => {
    const provider = keyForRow(id, "provider:");
    if (!provider) return failure("unknown-row", `Page provider access has no selectable row ${id}.`);
    const providers = ownerView<ModelAccessProvidersView>(
      ModelAccessProvidersViewSchema,
      options.modelAccess.providers(),
    );
    if (!providers) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const entry = providers.providers
      .find((candidate) => candidate.provider === provider);
    // A provider can drop out of the inventory while the page is open;
    // refresh silently instead of acting on the stale row.
    if (!entry) return snapshotResult(buildSnapshot(current()));
    return updated(
      options.modelAccess.setProviderEnabled(provider, !entry.enabled),
      `${provider} ${entry.enabled ? "disabled" : "enabled"} for routed models`,
    );
  };

  const selectOnAgentList = (id: string, quick: boolean): SettingsResult => {
    const type = keyForRow(id, "type:");
    if (!type) return failure("unknown-row", `Agent list has no selectable row ${id}.`);
    if (quick) {
      const root = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
      if (!root) return failure("invalid-snapshot", "Settings page does not match its contract.");
      const parentKey = root.parentModelKey;
      if (parentKey === "") return infoSnapshot("Select a parent model before using Quick model setup");
      const provider = parentKey.slice(0, parentKey.indexOf("/"));
      return navigate({ id: "ma-models", type, provider, quick: true });
    }
    return navigate({ id: "ma-agent", type });
  };

  const selectOnAgentDetail = (page: Page & { id: "ma-agent" }, id: string): SettingsResult => {
    const view = ownerView<ModelAccessAgentDetailView>(
      ModelAccessAgentDetailViewSchema,
      options.modelAccess.agentDetail(page.type),
    );
    if (!view) return failure("invalid-snapshot", "Settings page does not match its contract.");
    if (id === "parentAccess") {
      if (view.parentModelKey === "") {
        return infoSnapshot("Select a parent model before changing Parent model access");
      }
      return updated(
        options.modelAccess.setParentAccess(page.type, !view.parentAllowed),
        `Parent model ${view.parentAllowed ? "denied" : "allowed"} for ${page.type}`,
      );
    }
    if (id === "thinking") return navigate({ id: "ma-thinking-targets", type: page.type });
    const provider = keyForRow(id, "provider:");
    if (!provider) return failure("unknown-row", `Page agent access has no selectable row ${id}.`);
    return navigate({ id: "ma-models", type: page.type, provider, quick: false });
  };

  const selectOnModels = (page: Page & { id: "ma-models" }, id: string): SettingsResult => {
    const notice = page.quick
      ? "Quick model setup updated"
      : `${page.type} model access updated for ${page.provider}`;
    if (id === "all") {
      return updated(options.modelAccess.toggleAllModels(page.type, page.provider, page.quick), notice);
    }
    const modelId = keyForRow(id, "model:");
    if (!modelId) return failure("unknown-row", `Page models has no selectable row ${id}.`);
    const models = ownerView<ModelAccessModelsView>(
      ModelAccessModelsViewSchema,
      options.modelAccess.models(page.type, page.provider),
    );
    if (!models) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const known = models.models
      .some((candidate) => candidate.id === modelId);
    if (!known) return snapshotResult(buildSnapshot(current()));
    return updated(options.modelAccess.toggleModel(page.type, page.provider, modelId, page.quick), notice);
  };

  const selectOnThinkingTargets = (page: Page & { id: "ma-thinking-targets" }, id: string): SettingsResult => {
    const key = keyForRow(id, "target:");
    if (!key) return failure("unknown-row", `Page thinking targets has no selectable row ${id}.`);
    return navigate({ id: "ma-thinking", type: page.type, modelKey: key });
  };

  const selectOnThinking = (page: Page & { id: "ma-thinking" }, id: string): SettingsResult => {
    const view = ownerView<ModelAccessThinkingView>(
      ModelAccessThinkingViewSchema,
      options.modelAccess.thinking(page.type, page.modelKey),
    );
    if (!view) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const level = keyForRow(id, "level:");
    if (level !== undefined) {
      const entry = view.levels.find((candidate) => candidate.level === level);
      if (!entry) return failure("unknown-row", `Thinking policy has no level ${level}.`);
      if (entry.allowed && view.levels.filter((candidate) => candidate.allowed).length === 1) {
        return infoSnapshot("At least one thinking level must stay allowed");
      }
      return updated(
        options.modelAccess.toggleThinkingLevel(page.type, page.modelKey, level),
        `Thinking levels updated for ${page.modelKey}`,
      );
    }
    if (id === "default") {
      const next = nextThinkingDefault(view);
      if (next === undefined) return infoSnapshot("No allowed thinking level to choose as default");
      return updated(
        options.modelAccess.setThinkingDefault(page.type, page.modelKey, next),
        `Default thinking level set to ${next}`,
      );
    }
    if (id === "reset") {
      return updated(
        options.modelAccess.resetThinking(page.type, page.modelKey),
        "Thinking policy reset to baseline",
      );
    }
    return failure("unknown-row", `Page thinking has no selectable row ${id}.`);
  };

  const selectOnUnavailable = (id: string): SettingsResult => {
    const provider = keyForRow(id, "provider:");
    if (!provider) return failure("unknown-row", `Page unavailable providers has no selectable row ${id}.`);
    const root = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
    if (!root) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const known = root.unavailableProviders
      .some((candidate) => candidate.provider === provider);
    if (!known) return snapshotResult(buildSnapshot(current()));
    return navigate({ id: "ma-unavailable-provider", provider });
  };

  const selectOnUnavailableProvider = (
    page: Page & { id: "ma-unavailable-provider" },
    id: string,
  ): SettingsResult => {
    const root = ownerView<ModelAccessRootView>(ModelAccessRootViewSchema, options.modelAccess.root());
    if (!root) return failure("invalid-snapshot", "Settings page does not match its contract.");
    const entry = root.unavailableProviders
      .find((candidate) => candidate.provider === page.provider);
    // buildSnapshot pops the stale page itself when the subject disappeared.
    if (!entry) return snapshotResult(buildSnapshot(current()));
    if (id === "routing") {
      return updated(
        options.modelAccess.setProviderEnabled(page.provider, !entry.routingEnabled),
        `${page.provider} ${entry.routingEnabled ? "disabled" : "enabled"} for routed models`,
      );
    }
    if (id === "deleteRules") {
      return updated(
        options.modelAccess.deleteProviderRules(page.provider),
        `Deleted saved ${page.provider} access rules`,
      );
    }
    return failure("unknown-row", `Page unavailable provider has no selectable row ${id}.`);
  };

  const select = (id: string): SettingsResult => {
    const page = current();
    switch (page.id) {
      case "root": return selectOnRoot(id);
      case "model-access": return selectOnModelAccessRoot(id);
      case "ma-providers": return selectOnProviders(id);
      case "ma-quick-agents": return selectOnAgentList(id, true);
      case "ma-agents": return selectOnAgentList(id, false);
      case "ma-agent": return selectOnAgentDetail(page, id);
      case "ma-models": return selectOnModels(page, id);
      case "ma-thinking-targets": return selectOnThinkingTargets(page, id);
      case "ma-thinking": return selectOnThinking(page, id);
      case "ma-unavailable": return selectOnUnavailable(id);
      case "ma-unavailable-provider": return selectOnUnavailableProvider(page, id);
      default:
        return failure("unknown-row", `Page ${page.id} has no selectable row ${id}.`);
    }
  };

  /**
   * The single exit. Owner ports are replaceable implementations, so a view
   * they return is not trusted merely because it typechecked at compile time;
   * a row that violates the contract reaches the renderer as a widget with no
   * value or an action with no label. Refusing the whole page keeps the
   * failure where it can be read — an error notice on a workflow the user can
   * back out of — instead of a half-drawn page they can act on.
   */
  const outbound = (result: SettingsResult): SettingsResult =>
    Check(SettingsResultSchema, result)
      ? result
      : { ok: false, error: { code: "invalid-snapshot", message: "Settings page does not match its contract." } };

  return {
    execute(command: unknown): SettingsResult {
      return outbound(run(command));
    },
  };

  function run(command: unknown): SettingsResult {
    if (!Check(SettingsCommandSchema, command)) {
      return failure("invalid-command", "Command does not match the settings command schema.");
    }
    switch (command.kind) {
      case "open": {
        stack = [{ id: "root" }];
        return snapshotResult(buildSnapshot(current()));
      }
      case "back": {
        if (stack.length > 1) {
          stack.pop();
          return snapshotResult(buildSnapshot(current()));
        }
        return snapshotResult(buildSnapshot(current()), { effect: { kind: "close" } });
      }
      case "select":
        return select(command.id);
      case "set-value": {
        const page = current();
        switch (page.id) {
          case "display": return setDisplayValue(command.id, command.value);
          case "spawn-options": return setSpawnValue(command.id, command.value);
          case "system-prompt": return setSystemPromptValue(command.id, command.value);
          case "concurrency": return setConcurrencyValue(page, command.id, command.value);
          case "debug": return setDebugValue(command.id);
          default: return failure("unknown-row", `Page ${page.id} has no editable row ${command.id}.`);
        }
      }
      case "update-limit":
      case "add-limit":
        return applyLimitUpdate(command);
    }
  }
}
