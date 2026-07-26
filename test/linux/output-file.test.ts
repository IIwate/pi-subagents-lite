/**
 * output-file.test.ts — POSIX 文件权限验收。
 *
 * Windows 不提供可移植的 Unix mode bit 语义，本地默认测试不运行此文件；
 * Linux CI 负责验证 0o700。若以后改为 ACL 或平台专用权限实现，需要重审此边界。
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
