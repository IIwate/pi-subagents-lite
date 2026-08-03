/**
 * Theme for terminal rendering — used by formatting helpers and UI widgets.
 * Defined separately so formatting modules share one narrow UI contract.
 */
export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};
