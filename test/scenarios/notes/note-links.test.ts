import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

describe("Agent Note verification links", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(async () => { await harness.dispose(); });

  it("rejects a missing test target outside the notes tree and accepts its restored path", () => {
    const repository = harness.createTempDir();
    const notes = join(repository, ".agents", "notes");
    const implemented = join(notes, "implemented", "testing");
    mkdirSync(implemented, { recursive: true });
    writeFileSync(join(implemented, "2026-09-09-fixture.md"),
      "# Agent Note: Fixture\n\nStatus: implemented\n\n"
      + "[Unit coverage](../../../../test/unit/example.test.ts)\n");
    const script = resolve("scripts/verify-agent-note-tree.ts");
    const options = {
      cwd: repository, encoding: "utf8" as const, timeout: 10_000,
      env: { ...process.env, AGENT_NOTE_ROOT: notes },
    };

    const missing = spawnSync(process.execPath, [script], options);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("test/unit/example.test.ts");
    expect(missing.stderr).toContain("target file does not exist");

    const tests = join(repository, "test", "unit");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "example.test.ts"), "export {};\n");
    const valid = spawnSync(process.execPath, [script], options);
    expect(valid.status, valid.stderr).toBe(0);
  });
});
