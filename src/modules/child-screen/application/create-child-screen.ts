import { Check } from "typebox/value";
import {
  NavigatorCommandSchema,
  type ChildRecordSummary,
  type NavigatorCommand,
  type NavigatorCommandResult,
  type NavigatorSnapshot,
} from "../contracts/navigator.js";

export interface CreateChildScreenOptions {
  initialListExpanded?: boolean;
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

export function createChildScreen(options: CreateChildScreenOptions = {}): ChildScreen {
  let selectedAgentId: string | null = null;
  let highlightedAgentId: string | null = null;
  let listExpanded = options.initialListExpanded !== false;
  let listFocused = false;
  let pendingResultCount: number | undefined;
  let records: ChildRecordSummary[] = [];

  function visible(): boolean {
    return records.length > 0 || pendingResultCount != null;
  }

  function snapshot(): NavigatorSnapshot {
    return {
      selectedAgentId,
      highlightedAgentId,
      listExpanded,
      listFocused,
      visible: visible(),
      ...(pendingResultCount != null ? { pendingResultCount } : {}),
      records: structuredClone(records),
    };
  }

  function ok(): NavigatorCommandResult {
    return { ok: true, snapshot: snapshot() };
  }

  function forgetMissingSelection(): void {
    if (selectedAgentId && !records.some((record) => record.id === selectedAgentId)) {
      selectedAgentId = null;
      highlightedAgentId = null;
      listFocused = false;
    }
  }

  return {
    execute(command: unknown): NavigatorCommandResult {
      if (!Check(NavigatorCommandSchema, command)) {
        return failure("invalid-command", "Navigator command is invalid.");
      }
      const next = command as NavigatorCommand;
      switch (next.kind) {
        case "replace-records":
          records = structuredClone(next.records);
          pendingResultCount = next.pendingResultCount;
          forgetMissingSelection();
          return ok();
        case "select":
          if (next.agentId && !records.some((record) => record.id === next.agentId)) {
            return failure("not-found", "Selected Subagent is not in the current list.");
          }
          selectedAgentId = next.agentId;
          highlightedAgentId = next.agentId;
          listFocused = false;
          return ok();
        case "toggle-fold":
          if (!visible()) return ok();
          listExpanded = !listExpanded;
          if (!listExpanded) {
            listFocused = false;
            highlightedAgentId = selectedAgentId;
          }
          return ok();
        case "inspect":
          return ok();
      }
    },
  };
}
