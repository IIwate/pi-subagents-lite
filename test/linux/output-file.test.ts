/**
 * output-file.test.ts — POSIX file-permission acceptance.
 *
 * Windows has no portable Unix mode-bit semantics, so the default local suite excludes this file.
 * Linux CI verifies 0o700. Revisit this boundary if permissions move to ACLs or platform-specific code.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createOutputFilePath } from "../../src/agents/output-file.js";
import { tempDirFixture } from "../fixtures.ts";

const fixture = tempDirFixture();

beforeEach(() => fixture.setup());
afterEach(() => fixture.teardown());

describe.runIf(process.platform !== "win32")("POSIX output directory permissions", () => {
  it("creates the directory with 0o700 permissions", () => {
    const dir = join(fixture.getDir(), "sub");
    createOutputFilePath("test-agent-123", dir);

    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});
