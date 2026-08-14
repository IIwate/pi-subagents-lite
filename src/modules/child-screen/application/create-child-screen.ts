import { Check } from "typebox/value";
import {
  NavigatorCommandResultSchema,
  NavigatorCommandSchema,
  type ChildRecordSummary,
  type ChildStatus,
  type NavigatorCommand,
  type NavigatorCommandResult,
  type NavigatorKey,
  type NavigatorSnapshot,
  type StatsVisibility,
} from "../contracts/navigator.js";
import { projectFooterStatus, projectList } from "../core/projection.js";
import { projectTranscript } from "../core/transcript.js";
import type { TextLayout } from "../ports/text-layout.js";

export interface CreateChildScreenOptions {
  initialListExpanded?: boolean;
  // Required so application never constructs the layout adapter. Bootstrap
  // injects the Pi implementation; tests inject the ASCII one. A default
  // here would hide a missing host wire until a row wrapped wrong.
  textLayout: TextLayout;
}

export interface ChildScreen {
  execute(command: unknown): NavigatorCommandResult;
}

function failure(
  code: Extract<NavigatorCommandResult, { ok: false }>["error"]["code"],
  message: string,
): NavigatorCommandResult {
  return { ok: false, error: { code, message } };
}

/**
 * The last door a result walks through. A layout port or an in-memory record
 * can hold a value that typechecked when it was written and is garbage by the
 * time it is projected. The host treats a successful result as a complete
 * picture it can paint, so a half-valid snapshot is how one bad field becomes
 * a row the user can act on. invalid-command is the only failure this schema
 * names for a broken view; not-found stays reserved for a missing Subagent.
 */
function outbound(result: NavigatorCommandResult): NavigatorCommandResult {
  return Check(NavigatorCommandResultSchema, result)
    ? result
    : failure("invalid-command", "Navigator result does not match its contract.");
}

export function createChildScreen(options: CreateChildScreenOptions): ChildScreen {
  const layout = options.textLayout;
  let selectedAgentId: string | null = null;
  let highlightedAgentId: string | null = null;
  let listExpanded = options.initialListExpanded !== false;
  let listFocused = false;
  let confirmingClearId: string | null = null;
  let interactionNotice: string | undefined;
  let interactionRequestId = 0;
  let pendingResultCount: number | undefined;
  let records: ChildRecordSummary[] = [];
  let statsVisibility: StatsVisibility = {};
  let debugPreview: ChildStatus | undefined;
  let lastColumns = 120;
  let lastRows = 40;
  let lastNow = 0;

  function visible(): boolean {
    return records.length > 0 || pendingResultCount != null;
  }

  function snapshot(withProjection: boolean): NavigatorSnapshot {
    const next: NavigatorSnapshot = {
      selectedAgentId,
      highlightedAgentId,
      listExpanded,
      statsVisibility: { ...statsVisibility },
      listFocused,
      confirmingClearId,
      interactionRequestId,
      visible: visible(),
      records: structuredClone(records),
    };
    if (interactionNotice) next.interactionNotice = interactionNotice;
    if (pendingResultCount != null) next.pendingResultCount = pendingResultCount;
    if (withProjection && listExpanded && visible()) {
      next.listLines = projectList({
        records,
        selectedAgentId,
        highlightedAgentId,
        listFocused,
        confirmingClearId,
        interactionNotice,
        pending: pendingResultCount,
        columns: lastColumns,
        rows: lastRows,
        now: lastNow,
        preview: debugPreview,
        statsVisibility,
        layout,
      });
    }
    const footer = projectFooterStatus(records, {
      listExpanded,
      pending: pendingResultCount,
      notice: interactionNotice,
      selected: selectedAgentId != null,
    });
    if (footer) next.footerStatus = footer;
    if (withProjection && selectedAgentId) {
      next.transcriptLines = projectTranscript(
        records.find((record) => record.id === selectedAgentId),
        lastColumns,
        layout,
      );
    }
    return next;
  }

  function ok(
    extra: Partial<Extract<NavigatorCommandResult, { ok: true }>> = {},
    withProjection = false,
  ): NavigatorCommandResult {
    return { ok: true, snapshot: snapshot(withProjection), ...extra };
  }

  function forgetMissing(): void {
    if (selectedAgentId && !records.some((record) => record.id === selectedAgentId)) {
      selectedAgentId = null;
      interactionRequestId += 1;
      interactionNotice = undefined;
    }
    if (highlightedAgentId && !records.some((record) => record.id === highlightedAgentId)) {
      highlightedAgentId = selectedAgentId;
    }
    if (confirmingClearId && !records.some((record) => record.id === confirmingClearId)) {
      confirmingClearId = null;
    }
    if (!visible()) {
      listFocused = false;
      confirmingClearId = null;
      interactionNotice = undefined;
      highlightedAgentId = null;
    }
  }

  function entryIds(): Array<string | null> {
    return [null, ...records.map((record) => record.id)];
  }

  function handleKey(key: NavigatorKey, editorEmpty: boolean): NavigatorCommandResult {
    if (!listExpanded || records.length === 0 && pendingResultCount == null) {
      return ok({ consume: false });
    }
    const entries = entryIds();
    if (entries.length <= 1) return ok({ consume: false });

    if (!listFocused) {
      if (key === "down" && editorEmpty) {
        listFocused = true;
        confirmingClearId = null;
        highlightedAgentId = selectedAgentId;
        return ok({ consume: true });
      }
      return ok({ consume: false });
    }

    if (confirmingClearId !== null) {
      if (key === "enter") {
        const id = confirmingClearId;
        const index = entries.findIndex((entry) => entry === id);
        confirmingClearId = null;
        if (!id || id === selectedAgentId) {
          return ok({
            consume: true,
            notify: id === selectedAgentId
              ? { message: "Cannot clear the active subagent — switch to Main first", level: "warning" }
              : undefined,
          });
        }
        return ok({
          consume: true,
          effect: { type: "clear", agentId: id, index: Math.max(0, index) },
        });
      }
      if (key === "escape") {
        confirmingClearId = null;
        return ok({ consume: true });
      }
      if (key === "ctrl-c") {
        confirmingClearId = null;
        return ok({ consume: false });
      }
      return ok({ consume: true });
    }

    if (key === "escape") {
      listFocused = false;
      highlightedAgentId = selectedAgentId;
      return ok({ consume: true });
    }
    if (key === "ctrl-d") {
      if (highlightedAgentId === null) {
        return ok({ consume: true, notify: { message: "Cannot clear Main agent", level: "warning" } });
      }
      if (highlightedAgentId === selectedAgentId) {
        return ok({
          consume: true,
          notify: { message: "Cannot clear the active subagent — switch to Main first", level: "warning" },
        });
      }
      confirmingClearId = highlightedAgentId;
      return ok({ consume: true });
    }
    if (key === "space") {
      if (highlightedAgentId === null) {
        return ok({ consume: true, notify: { message: "Cannot pin Main agent", level: "warning" } });
      }
      return ok({ consume: true, effect: { type: "toggle-pin", agentId: highlightedAgentId } });
    }
    if (key === "enter") {
      if (highlightedAgentId && !records.some((record) => record.id === highlightedAgentId)) {
        return failure("not-found", "Selected Subagent is not in the current list.");
      }
      selectedAgentId = highlightedAgentId;
      interactionRequestId += 1;
      interactionNotice = undefined;
      return ok({ consume: true });
    }

    const highlightedIndex = Math.max(0, entries.findIndex((entry) => entry === highlightedAgentId));
    if (key === "up") {
      if (highlightedIndex === 0) {
        listFocused = false;
        highlightedAgentId = selectedAgentId;
      } else {
        highlightedAgentId = entries[highlightedIndex - 1] ?? null;
      }
      return ok({ consume: true });
    }
    if (key === "down") {
      if (highlightedIndex < entries.length - 1) {
        highlightedAgentId = entries[highlightedIndex + 1] ?? null;
      }
      return ok({ consume: true });
    }
    if (key === "printable") {
      listFocused = false;
      highlightedAgentId = selectedAgentId;
      return ok({ consume: false });
    }
    return ok({ consume: false });
  }

  return {
    execute(command: unknown): NavigatorCommandResult {
      return outbound(run(command));
    },
  };

  function run(command: unknown): NavigatorCommandResult {
    if (!Check(NavigatorCommandSchema, command)) {
      return failure("invalid-command", "Navigator command is invalid.");
    }
    const next = command as NavigatorCommand;
    switch (next.kind) {
      case "replace-records":
        records = structuredClone(next.records);
        pendingResultCount = next.pendingResultCount;
        forgetMissing();
        if (next.highlightIndex != null) {
          const entries = entryIds();
          highlightedAgentId = entries[Math.min(next.highlightIndex, Math.max(0, entries.length - 1))] ?? null;
          if (entries.length <= 1) {
            listFocused = false;
            highlightedAgentId = null;
          }
        }
        return ok();
      case "select":
        if (next.agentId && !records.some((record) => record.id === next.agentId)) {
          return failure("not-found", "Selected Subagent is not in the current list.");
        }
        selectedAgentId = next.agentId;
        highlightedAgentId = next.agentId;
        interactionRequestId += 1;
        interactionNotice = undefined;
        return ok();
      case "toggle-fold":
        if (!visible()) return ok();
        listExpanded = !listExpanded;
        if (!listExpanded) {
          listFocused = false;
          confirmingClearId = null;
          highlightedAgentId = selectedAgentId;
        }
        return ok();
      case "key":
        return handleKey(next.key, next.editorEmpty);
      case "set-stats-visibility":
        statsVisibility = { ...next.visibility };
        return ok();
      case "set-debug-preview":
        debugPreview = next.status;
        return ok();
      case "set-interaction-notice":
        interactionNotice = next.notice;
        return ok();
      case "begin-interaction":
        if (next.agentId !== selectedAgentId) return ok({ interactionRequestId: -1 });
        interactionRequestId += 1;
        return ok({ interactionRequestId });
      case "project":
        lastColumns = next.columns;
        lastRows = next.rows;
        lastNow = next.now;
        return ok({}, true);
      case "inspect":
        return ok();
    }
  }
}
