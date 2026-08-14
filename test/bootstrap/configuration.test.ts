/**
 * configuration.test.ts — Adapter contract for ConfigSectionIO.
 *
 * The process-scoped document is created at import time, so HOME is pinned
 * first. Commit-code forwarding is exercised against an in-memory
 * configuration so a failed persist cannot touch a real file.
 */

await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "configuration-io-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
});

import { describe, expect, it, vi } from "vitest";
import { createConfigurationSectionIO } from "../../src/bootstrap/configuration.js";
import { createConfiguration } from "../../src/modules/configuration/public.js";

describe("ConfigSectionIO commit", () => {
  it("forwards persistence-failure code, not only the message", () => {
    const io = createConfigurationSectionIO(createConfiguration({
      repository: {
        load: () => ({}),
        persist() {
          throw new Error("EACCES: permission denied");
        },
      },
    }));
    io.read("agent");

    expect(io.commit("agent", { forceBackground: true })).toEqual({
      ok: false,
      code: "persistence-failure",
      message: "EACCES: permission denied",
    });
  });
});
