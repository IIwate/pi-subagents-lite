/**
 * Pi exposes no public hook for extending session retry classification. This test
 * intentionally fails during dependency upgrades if the private method we wrap is removed.
 */

import { describe, expect, it } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";

describe("Pi retry classifier compatibility", () => {
  it("provides AgentSession._isRetryableError", () => {
    const prototype = AgentSession.prototype as unknown as {
      _isRetryableError?: unknown;
    };

    expect(typeof prototype._isRetryableError).toBe("function");
  });
});
