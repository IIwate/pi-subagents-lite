/**
 * Theme for terminal rendering — used by formatting helpers and UI widgets.
 * Defined here (not in ui/agent-widget.ts) so non-UI modules can import it
 * without depending on the UI layer.
 */
export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};
