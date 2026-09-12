import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

describe("Agent Note verification links", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(async () => { await harness.dispose(); });

  it("excludes frozen archives while still rejecting active contract drift", () => {
    const repository = harness.createTempDir();
    const notes = join(repository, ".agents", "notes");
    const archived = join(notes, "archived", "architecture");
    const active = join(notes, "implemented", "architecture");
    mkdirSync(archived, { recursive: true }); mkdirSync(active, { recursive: true });
    const source = join(repository, "contract.ts");
    writeFileSync(source, "export interface Contract { value: string; }\n");
    writeFileSync(join(archived, "2026-09-12-frozen.md"),
      "```ts type-equiv: Retired from removed.ts\nexport interface Retired { old: number; }\n```\n");
    const note = join(active, "2026-09-12-current.md");
    writeFileSync(note, "```ts type-equiv: Contract from contract.ts\nexport interface Contract { value: number; }\n```\n");
    const script = resolve("scripts/verify-type-equiv.ts");
    const options = { cwd: repository, encoding: "utf8" as const, timeout: 10_000, env: { ...process.env, AGENT_NOTE_ROOT: notes } };
    const mismatch = spawnSync(process.execPath, [script], options);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("AST divergence");
    expect(mismatch.stderr).not.toContain("removed.ts");
    writeFileSync(note, "```ts type-equiv: Contract from contract.ts\nexport interface Contract { value: string; }\n```\n");
    const valid = spawnSync(process.execPath, [script], options);
    expect(valid.status, valid.stderr).toBe(0);
  });

  it("rejects a missing internal note target while remaining decoupled from external paths", () => {
    const repository = harness.createTempDir();
    const notes = join(repository, ".agents", "notes");
    const implemented = join(notes, "implemented", "testing");
    mkdirSync(implemented, { recursive: true });
    writeFileSync(join(implemented, "2026-09-09-fixture.md"),
      "# Agent Note: Fixture\n\nStatus: implemented\n\n"
      + "[Target note](../architecture/2026-09-09-nonexistent.md)\n"
      + "[External test path](../../../../test/unit/unverified.test.ts)\n");
    const script = resolve("scripts/verify-agent-note-tree.ts");
    const options = {
      cwd: repository, encoding: "utf8" as const, timeout: 10_000,
      env: { ...process.env, AGENT_NOTE_ROOT: notes },
    };

    const missing = spawnSync(process.execPath, [script], options);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("2026-09-09-nonexistent.md");
    expect(missing.stderr).toContain("target file does not exist");
    // External test path should remain decoupled and ignored by the tree validator
    expect(missing.stderr).not.toContain("unverified.test.ts");

    const architecture = join(notes, "implemented", "architecture");
    mkdirSync(architecture, { recursive: true });
    writeFileSync(join(architecture, "2026-09-09-nonexistent.md"),
      "# Agent Note: Target\n\nStatus: implemented\n\n## Problem\n\nContent\n\n## Decision\n\nContent\n\n## Alternatives considered\n\n- Alt\n\n## Consequences\n\nContent\n");
    const valid = spawnSync(process.execPath, [script], options);
    expect(valid.status, valid.stderr).toBe(0);
  });
});
