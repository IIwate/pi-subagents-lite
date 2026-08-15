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
  // Windows homedir() reads USERPROFILE; Pi's getAgentDir derives from it.
  process.env.USERPROFILE = home;
});

import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { createConfigurationSectionIO, customPromptPath, skillsUserHome } from "../../src/bootstrap/configuration.js";
import { createConfiguration } from "../../src/modules/configuration/public.js";
import { hostInstallationPaths } from "../../src/platform/pi/host-resources.js";
import {
  configFilePath,
  customPromptFilePath,
  projectAgentsDirPath,
  userAgentsDirPath,
} from "../../src/platform/fs/config-paths.js";

describe("canonical host resource locations", () => {
  it("REQ-CONFIG-002 derives global config, custom prompt, and global agents from one Pi agent directory", () => {
    const root = hostInstallationPaths.agentDirectory;
    expect(configFilePath(root)).toBe(path.join(root, "subagents-lite.json"));
    expect(customPromptPath).toBe(path.join(root, "subagents-lite-prompt.md"));
    expect(customPromptFilePath(root)).toBe(customPromptPath);
    expect(userAgentsDirPath(root)).toBe(path.join(root, "agents"));
  });

  it("REQ-CONFIG-002 follows Pi's project config directory name for project agent roots", () => {
    expect(projectAgentsDirPath("/repo", ".pi")).toBe(path.join("/repo", ".pi", "agents"));
    expect(projectAgentsDirPath("/repo", ".custom")).toBe(path.join("/repo", ".custom", "agents"));
  });

  it("keeps the HOME resolution for the skills user root only", () => {
    // The pinned HOME from the hoisted block above must feed the skills root
    // while leaving the Pi-derived config root untouched.
    expect(skillsUserHome).toBe(process.env.HOME);
    expect(customPromptPath.startsWith(hostInstallationPaths.agentDirectory)).toBe(true);
  });
});

describe("ConfigSectionIO commit", () => {
  it("forwards persistence-failure code, not only the message", () => {
    const io = createConfigurationSectionIO(createConfiguration({
      repository: {
        load: () => ({ status: "loaded" as const, document: {} }),
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
