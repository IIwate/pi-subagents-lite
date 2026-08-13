/**
 * theme.ts — Minimal Pi theme contract shared by the platform TUI widgets.
 * Structural subset of the theme object Pi passes into `ctx.ui.custom`.
 */
export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};
