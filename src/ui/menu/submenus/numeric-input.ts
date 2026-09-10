/**
 * numeric-input-submenu.ts — Shared input submenu Components.
 *
 * - createNumericSubmenu: numeric input with validation
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, type Component } from "@earendil-works/pi-tui";
import { saveSetting } from "../helpers.js";

/**
 * Returns a `(initialValue, done) => submenu` function wired to
 * `ctx.ui.notify` for errors.
 *
 * If `required` is true, empty input errors.
 * If `required` is false (default), empty input calls `done()` to clear.
 *
 * Usage:
 *   createNumericSubmenu(ctx, onValid)
 *   createNumericSubmenu(ctx, { min, required? }, onValid, onEmpty?)
 */
export function createNumericSubmenu(
  ctx: ExtensionCommandContext,
  optionsOrCallback?: { min?: number; required?: boolean; default?: number } | ((parsed: number) => void),
  onValid?: (parsed: number) => void,
  onEmpty?: () => void,
): (initialValue: string, done: (selectedValue?: string) => void) => Component {
  const opts = typeof optionsOrCallback === "function"
    ? { onValid: optionsOrCallback }
    : { onValid, ...optionsOrCallback };
  const min = opts.min ?? 1;
  const required = opts.required ?? false;
  const fmtLabel = (n: number) => (n === 0 ? "\u2265 0" : `\u2265 ${n}`);
  const onError = (msg: string) => ctx.ui.notify(msg, "error");

  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue === "(not set)" ? "" : initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed || /^unlimited$/i.test(trimmed)) {
        if (required) {
          onError(`Invalid value \u2014 must be a number ${fmtLabel(min)}`);
          return;
        }
        if (opts.default != null) {
          if (!saveSetting(ctx, () => opts.onValid?.(opts.default!))) return;
          done(String(opts.default));
        } else {
          if (!saveSetting(ctx, () => onEmpty?.())) return;
          done("(not set)");
        }
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < min) {
        onError(`Invalid value \u2014 must be an integer ${fmtLabel(min)}`);
        return;
      }
      if (!saveSetting(ctx, () => opts.onValid?.(parsed))) return;
      done(String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}
