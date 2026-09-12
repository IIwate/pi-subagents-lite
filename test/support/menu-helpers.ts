/** Pure menu controls; module mocks and store lifecycle live in menu-mocks.ts. */

import { vi } from "vitest";

/**
 * Select menu item by partial name match.
 * Maps short names to configuration menu labels.
 */
export function selectByName(name: string): (title: string, items: string[]) => string | undefined {
  const nameMap: Record<string, string> = {
    model: "Model routing",
    concurrency: "Concurrency settings",
    display: "Display settings",
    spawnoptions: "Spawn options",
  };
  const search = nameMap[name.toLowerCase()] ?? name;
  return (_title: string, items: string[]) => {
    const match = items.find(item => item.toLowerCase().includes(search.toLowerCase()));
    return match ?? undefined;
  };
}

/**
 * Create a mock extension command context with controllable UI.
 *
 * @param selections Array of values that ctx.ui.select returns sequentially.
 * @param inputs Array of values that ctx.ui.input returns sequentially.
 * @param customValues Array of values that ctx.ui.custom returns sequentially.
 */
export function createMockCtx(
  selections: (string | ((title: string, items: string[]) => string | undefined) | undefined)[] = [],
  inputs: (string | undefined)[] = [],
  customValues: (string | null)[] = [],
): any {
  let selectIdx = 0;
  let inputIdx = 0;
  let customIdx = 0;

  return {
    ui: {
      select: vi.fn(async (title: string, items: string[]) => {
        const sel = selections[selectIdx++];
        if (typeof sel === "function") return sel(title, items);
        return sel ?? undefined;
      }),
      input: vi.fn(async (_label: string, _initialValue?: string) => {
        return inputs[inputIdx++] ?? undefined;
      }),
      custom: vi.fn(async (_factory: any) => {
        // If customValues have explicit entries, return those
        if (customIdx < customValues.length) {
          return customValues[customIdx++];
        }
        // Otherwise, invoke the factory to trigger component construction side effects
        // Provide a mock tui with terminal.rows, a noop theme, and a done callback
        _factory(
          { terminal: { rows: 40, columns: 120 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
          },
          null,
          () => {},
        );
        return undefined;
      }),
      notify: vi.fn(),
    },
    model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    scopedModels: [],
    modelRegistry: {
      getAll: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "anthropic", id: "claude-haiku-4" },
        { provider: "openai", id: "gpt-4o" },
        { provider: "openai", id: "o3" },
        { provider: "google", id: "gemini-2.5-pro" },
      ]),
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "anthropic", id: "claude-haiku-4" },
        { provider: "openai", id: "gpt-4o" },
        { provider: "openai", id: "o3" },
      ]),
      getRegisteredProviderIds: vi.fn(() => ["anthropic", "openai", "google"]),
      getError: vi.fn(() => undefined),
    },
  };
}
