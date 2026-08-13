/**
 * settings-screen.ts — Generic Pi host for the settings module.
 *
 * Translates settings snapshots into Pi list components and Pi input back
 * into serializable settings commands. One `ctx.ui.custom` session renders
 * one page visit; page changes re-enter the loop with a fresh component so
 * no widget state leaks between pages (same lifecycle the menus used).
 * Same-page updates rebuild the list in place so the cursor stays put.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildListTheme, SettingsListWrapper, skipNonSelectableRows } from "./settings-chrome.js";
import { createConfirmSubmenu, createMultilineConfirmComponent } from "./confirm.js";
import { createNumericSubmenu } from "./numeric-input.js";
import { buildPickOptions, createDelegatingComponent, createSearchableSelect } from "./pick-list.js";
import type { Theme } from "./theme.js";
import type {
  Settings,
  SettingsCommand,
  SettingsResult,
  SettingsRow,
  SettingsSnapshot,
} from "../../../modules/settings/public.js";

export async function runSettingsScreen(
  ctx: ExtensionCommandContext,
  settings: Settings,
): Promise<void> {
  let result = settings.execute({ kind: "open" });
  while (true) {
    if (!result.ok) {
      ctx.ui.notify(result.error.message, "error");
      return;
    }
    if (result.effect?.kind === "close") return;
    result = await renderPageVisit(ctx, settings, result.snapshot);
  }
}

/** Everything a row submenu needs from the hosting page visit. */
interface RowHost {
  ctx: ExtensionCommandContext;
  theme: Theme;
  /**
   * Execute a settings command and refresh the list from the returned
   * snapshot. `deferRebuild` postpones the refresh one microtask for commands
   * that can delete the currently selected row — SettingsList restores its
   * submenu cursor after done(), and an immediate rebuild could restore an
   * out-of-range index.
   */
  execute(command: SettingsCommand, options?: { deferRebuild?: boolean }): void;
}

/**
 * Edit-or-remove submenu for keyed limit rows. Editing routes the new value
 * through the SettingsList done→onChange path (one commit per submit);
 * removal is an explicit gesture so clearing an input never deletes anything.
 */
function limitSubmenu(row: SettingsRow, host: RowHost): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => {
    const list = new SelectList(
      [{ value: "edit", label: "Edit limit" }, { value: "remove", label: "Remove limit" }],
      5,
      buildListTheme(host.theme),
    );
    const delegator = createDelegatingComponent(list);
    list.onSelect = (item) => {
      if (item.value === "edit") {
        delegator.setActive(
          createNumericSubmenu(host.ctx, { min: row.min ?? 1, required: true })(row.input ?? "", done),
        );
        return;
      }
      host.execute({ kind: "update-limit", id: row.id, limit: null }, { deferRebuild: true });
      done();
    };
    list.onCancel = () => done();
    return delegator;
  };
}

/**
 * Pick-then-type submenu for "Add … limit" rows. The picked key is not
 * representable on the done→onChange path (which only carries a value), so
 * the numeric step commits directly and the wrapper swallows done's value.
 */
function pickerSubmenu(row: SettingsRow, host: RowHost): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => createSearchableSelect(
    buildPickOptions([...(row.choices ?? [])]),
    {
      onSelect: (key) => createNumericSubmenu(host.ctx, { min: row.min ?? 1, required: true }, (limit) => {
        host.execute({ kind: "add-limit", id: row.id, key, limit }, { deferRebuild: true });
      })(row.input ?? "1", () => done()),
      onCancel: () => done(),
    },
    host.theme,
  );
}

function toSettingItems(snapshot: SettingsSnapshot, host: RowHost): SettingItem[] {
  return snapshot.rows.map((row) => {
    const base = {
      id: row.id,
      label: row.label,
      currentValue: row.value ?? "",
      description: row.detail ?? "",
    };
    if (row.kind === "numeric") {
      // Numeric rows edit through an input submenu. The submenu only
      // validates; committing stays on the SettingsList done→onChange path,
      // the same seam every other row kind uses (one commit per submit).
      return {
        ...base,
        submenu: createNumericSubmenu(host.ctx, {
          min: row.min ?? 0,
          ...(row.fallback !== undefined ? { default: row.fallback } : {}),
        }),
      };
    }
    if (row.kind === "limit") return { ...base, submenu: limitSubmenu(row, host) };
    if (row.kind === "picker") return { ...base, submenu: pickerSubmenu(row, host) };
    if (row.kind === "action" && row.confirm) {
      // Confirmation flows through done("Yes")→onChange, so the destructive
      // command still commits exactly once, on the same path as other rows.
      return { ...base, submenu: createConfirmSubmenu({ message: row.confirm, theme: host.theme, onConfirm: () => {} }) };
    }
    return { ...base, values: row.choices ? [...row.choices] : [] };
  });
}

/** Render one page until the user picks a category or leaves; returns the next settings result. */
function renderPageVisit(
  ctx: ExtensionCommandContext,
  settings: Settings,
  snapshot: SettingsSnapshot,
): Promise<SettingsResult> {
  return ctx.ui.custom<SettingsResult>((_tui, theme, _kb, done) => {
    const listTheme = buildListTheme(theme);

    if (snapshot.presentation === "menu") {
      // Menu pages are select-driven: one activation toggles a policy, fires
      // an action, or navigates. Same-page outcomes rebuild the list in place
      // (cursor preserved); page changes and effects end the visit.
      let currentRows = snapshot.rows;
      let delegator: ReturnType<typeof createDelegatingComponent>;

      const apply = (command: SettingsCommand, cursorRowId?: string): void => {
        const outcome = settings.execute(command);
        if (!outcome.ok) {
          ctx.ui.notify(outcome.error.message, "error");
          return;
        }
        const notice = outcome.snapshot.notice;
        if (notice) ctx.ui.notify(notice.message, notice.severity);
        if (outcome.effect || outcome.snapshot.page !== snapshot.page) {
          done(outcome);
          return;
        }
        currentRows = outcome.snapshot.rows;
        delegator.setActive(buildList(cursorRowId));
      };

      const buildList = (cursorRowId?: string): SelectList => {
        const items = currentRows.map((row) => ({
          value: row.id,
          label: row.value !== undefined ? `${row.label} · ${row.value}` : row.label,
          description: row.detail,
          nonSelectable: row.kind === "note",
        }));
        const list = new SelectList(items, 12, listTheme);
        skipNonSelectableRows(list, (item) => item?.nonSelectable === true);
        if (cursorRowId) {
          const index = items.findIndex((item) => item.value === cursorRowId);
          if (index >= 0) (list as any).selectedIndex = index;
        }
        list.onSelect = (item) => {
          const row = currentRows.find((candidate) => candidate.id === item.value);
          if (!row || row.kind === "note") return;
          if (row.kind === "action" && row.confirm) {
            // The module executes on select; the renderer owns asking first,
            // exactly like the form path's confirm-before-onChange.
            delegator.setActive(createMultilineConfirmComponent({
              message: row.confirm,
              theme,
              onConfirm: () => apply({ kind: "select", id: row.id }, row.id),
              onCancel: () => delegator.setActive(buildList(row.id)),
              done: () => {},
            }));
            return;
          }
          apply({ kind: "select", id: row.id }, row.id);
        };
        // Space activates the selected row, matching the checkbox gesture the
        // menus used for toggle lists.
        const baseInput = list.handleInput.bind(list);
        list.handleInput = (data: string) => {
          if (data === " ") {
            const item = (list as any).items?.[(list as any).selectedIndex ?? 0];
            if (item && !item.nonSelectable) list.onSelect?.(item);
            return;
          }
          baseInput(data);
        };
        list.onCancel = () => done(settings.execute({ kind: "back" }));
        return list;
      };

      delegator = createDelegatingComponent(buildList());
      return new SettingsListWrapper(delegator, {
        title: snapshot.title,
        theme,
        onCancel: () => done(settings.execute({ kind: "back" })),
      });
    }

    // Form page: value changes are applied in place and the rows are rebuilt
    // from the returned snapshot, so a failed save visibly reverts the widget
    // to the value that is actually persisted.
    let rebuild: ((items: SettingItem[]) => void) | undefined;
    let currentRows: SettingsSnapshot["rows"] = snapshot.rows;

    const host: RowHost = {
      ctx,
      theme,
      execute: (command, options) => {
        const outcome = settings.execute(command);
        if (!outcome.ok) {
          ctx.ui.notify(outcome.error.message, "error");
          return;
        }
        const notice = outcome.snapshot.notice;
        if (notice) ctx.ui.notify(notice.message, notice.severity);
        currentRows = outcome.snapshot.rows;
        if (options?.deferRebuild) {
          queueMicrotask(() => rebuild?.(toSettingItems(outcome.snapshot, host)));
        } else {
          rebuild?.(toSettingItems(outcome.snapshot, host));
        }
      },
    };

    const onChange = (id: string, newValue: string): void => {
      // Keyed limit rows commit through update-limit; everything else is a
      // plain set-value. The row kind decides, so the widgets stay generic.
      const row = currentRows.find((candidate) => candidate.id === id);
      host.execute(row?.kind === "limit"
        ? { kind: "update-limit", id, limit: Number(newValue) }
        : { kind: "set-value", id, value: newValue });
    };
    const list = new SettingsList(
      toSettingItems(snapshot, host),
      10,
      listTheme,
      onChange,
      () => done(settings.execute({ kind: "back" })),
    );
    return new SettingsListWrapper(list, {
      title: snapshot.title,
      theme,
      onCancel: () => done(settings.execute({ kind: "back" })),
      onRebuild: (fn) => { rebuild = fn; },
    });
  });
}
