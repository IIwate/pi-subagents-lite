import { Container } from "@earendil-works/pi-tui";

/**
 * Chat rendering for the three stealth tools.
 *
 * Subagent state belongs to the below-editor list. Results still reach the LLM,
 * but every tool renders zero chat rows so Pi's default tool cards cannot leak
 * back in. Owning the empty containers here keeps the TUI package out of tool
 * registration, so replacing the renderer stays inside this directory.
 */
export const SILENT_TOOL_RENDERING = {
  renderShell: "self" as const,
  renderCall: () => new Container(),
  renderResult: () => new Container(),
};
