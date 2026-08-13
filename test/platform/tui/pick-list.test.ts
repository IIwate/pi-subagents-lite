/**
 * Contract tests for the pick-list plumbing: option building for model and
 * provider keys, and the delegating component used to chain submenus.
 */

import { describe, it, expect, vi } from "vitest";
import { buildPickOptions, createDelegatingComponent } from "../../../src/platform/pi/tui/pick-list.js";

describe("buildPickOptions", () => {
  it("splits model keys into provider badge and model label", () => {
    expect(buildPickOptions(["anthropic/claude-sonnet-4", "openai/gpt-4o"])).toEqual([
      { value: "anthropic/claude-sonnet-4", label: "claude-sonnet-4", provider: "anthropic" },
      { value: "openai/gpt-4o", label: "gpt-4o", provider: "openai" },
    ]);
  });

  it("keeps plain keys (provider lists) as label-only options", () => {
    expect(buildPickOptions(["anthropic", "openai"])).toEqual([
      { value: "anthropic", label: "anthropic" },
      { value: "openai", label: "openai" },
    ]);
  });
});

describe("createDelegatingComponent", () => {
  it("forwards rendering and input to the currently active component", () => {
    const first = { render: vi.fn(() => ["first"]), handleInput: vi.fn(), invalidate: vi.fn() };
    const second = { render: vi.fn(() => ["second"]), handleInput: vi.fn() };
    const delegator = createDelegatingComponent(first as any);

    expect(delegator.render(80)).toEqual(["first"]);
    delegator.handleInput!("x");
    expect(first.handleInput).toHaveBeenCalledWith("x");

    delegator.setActive(second as any);
    expect(delegator.render(80)).toEqual(["second"]);
    delegator.handleInput!("y");
    expect(second.handleInput).toHaveBeenCalledWith("y");
  });

  it("reports the active child's focus so key passthrough works", () => {
    const child = { render: () => [], handleInput: () => {}, focused: true };
    const delegator = createDelegatingComponent(child as any);
    expect(delegator.focused).toBe(true);
    child.focused = false;
    expect(delegator.focused).toBe(false);
  });
});
