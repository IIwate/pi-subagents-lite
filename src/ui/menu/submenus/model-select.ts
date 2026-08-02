/**
 * model-select-submenu.ts — 2-step model override submenu.
 *
 * Step 1: SearchableSelectDialog for model selection (incl. "(inherits parent)")
 * Step 2 (after picking a model): SelectList for override mode (session/permanent/clear)
 *
 * Model comes first: users think in terms of "which model", then decide where
 * to store the choice. The submenu factory must be created inside
 * ctx.ui.custom to capture the theme.
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog } from "../../../ui/searchable-select.js";
import { buildModelOptions, buildListTheme, createDelegatingComponent } from "../helpers.js";

export interface ModelSelectSubmenuOptions {
  modelOptions: string[];
  showClear: boolean;
  theme: Theme;
  onSelect: (mode: "session" | "permanent" | "clear", model: string | null) => void;
}

/**
 * Creates a submenu factory for SettingsList items that need the 2-step
 * model override flow (model selection → mode selection).
 */
export function createModelSelectSubmenu(
  options: ModelSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    let selectedModel: string | null = null;

    const modelOpts = buildModelOptions(options.modelOptions);
    const modelSelector = new SearchableSelectDialog(
      modelOpts,
      _currentValue === "(inherits parent)" ? null : _currentValue,
      {
        onSelect: (modelValue) => {
          selectedModel = modelValue;
          delegator.setActive(modeList);
        },
        onCancel: () => done(),
      },
      options.theme,
    );

    const modeItems = [
      { value: "session", label: "Set for this session (not saved)" },
      { value: "permanent", label: "Set permanently (saved to config)" },
    ];
    if (options.showClear) {
      modeItems.push({ value: "clear", label: "Clear" });
    }

    const modeList = new SelectList(modeItems, 5, buildListTheme(options.theme));
    modeList.onSelect = (item) => {
      if (item.value === "clear") {
        options.onSelect("clear", null);
        done("clear");
        return;
      }
      options.onSelect(item.value as "session" | "permanent", selectedModel);
      done(selectedModel ?? undefined);
    };
    modeList.onCancel = () => done();

    const delegator = createDelegatingComponent(modelSelector);
    return delegator;
  };
}
