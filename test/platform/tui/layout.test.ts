import { describe, expect, it } from "vitest";
import { validateChildLayout } from "../../../src/platform/pi/tui/layout.js";

function component(children?: unknown[]) {
  return {
    render: () => [],
    invalidate() {},
    ...(children ? { children } : {}),
  };
}

describe("Pi child-screen layout contract", () => {
  it("fails closed when the root child count is not the verified Pi 0.84 layout", () => {
    const selector = component();
    const editor = component();
    const tui = {
      children: [component([component(), component(), component([component()])])],
    } as any;
    expect(validateChildLayout(tui, selector, editor)).toEqual({ ok: false });
  });
});
