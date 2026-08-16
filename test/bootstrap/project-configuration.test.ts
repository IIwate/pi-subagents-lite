/**
 * project-configuration.test.ts — Project document binding at the bootstrap seam.
 *
 * The owner Map is process-scoped like the global document: one facade per
 * lexically normalized file path, so two runtimes on the same project share
 * one revision domain while different projects share nothing.
 */

await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "project-config-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  // Windows homedir() reads USERPROFILE; Pi's getAgentDir derives from it.
  process.env.USERPROFILE = home;
});

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { bindProjectConfiguration } from "../../src/bootstrap/configuration.js";
import { hostInstallationPaths } from "../../src/platform/pi/host-resources.js";
import { normalizeConfigPathKey, projectConfigFilePath } from "../../src/platform/fs/config-paths.js";

function tempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "project-config-cwd-"));
}

function configFileOf(cwd: string): string {
  return projectConfigFilePath(cwd, hostInstallationPaths.projectConfigDirectoryName);
}

describe("bindProjectConfiguration", () => {
  it("returns an untrusted binding with no file path and no section IO", () => {
    const binding = bindProjectConfiguration(false, tempProject());
    expect(binding.getState()).toBe("untrusted");
    expect(binding.filePath).toBeUndefined();
    expect(binding.sectionIO).toBeUndefined();
  });

  it("reports absent for a trusted project without a config file, and Set creates it", () => {
    const cwd = tempProject();
    const binding = bindProjectConfiguration(true, cwd);
    expect(binding.getState()).toBe("absent");
    expect(binding.filePath).toBe(configFileOf(cwd));
    expect(existsSync(configFileOf(cwd))).toBe(false);

    binding.sectionIO!.read("concurrency");
    const commit = binding.sectionIO!.commit("concurrency", { default: 2 });
    expect(commit).toEqual({ ok: true });
    expect(binding.getState()).toBe("loaded");
    expect(JSON.parse(readFileSync(configFileOf(cwd), "utf-8"))).toEqual({ concurrency: { default: 2 } });
  });

  it("reads a loaded project document and removes keys through removals", () => {
    const cwd = tempProject();
    const filePath = configFileOf(cwd);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ concurrency: { default: 3, providers: { openai: 1 } }, junkSection: 1 }));

    const binding = bindProjectConfiguration(true, cwd);
    expect(binding.getState()).toBe("loaded");
    expect(binding.sectionIO!.read("concurrency")).toEqual({ default: 3, providers: { openai: 1 } });

    const commit = binding.sectionIO!.commit("concurrency", {}, ["providers"]);
    expect(commit).toEqual({ ok: true });
    // Unmentioned sections keep their JSON value.
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ concurrency: { default: 3 }, junkSection: 1 });
  });

  it("treats a malformed project file as read-only and never rewrites it", () => {
    const cwd = tempProject();
    const filePath = configFileOf(cwd);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json");

    const binding = bindProjectConfiguration(true, cwd);
    expect(binding.getState()).toBe("malformed");

    binding.sectionIO!.read("concurrency");
    const commit = binding.sectionIO!.commit("concurrency", { default: 2 });
    expect(commit).toMatchObject({ ok: false, code: "document-malformed" });
    expect(binding.getState()).toBe("malformed");
    expect(readFileSync(filePath, "utf-8")).toBe("{ not json");
  });

  it("shares one revision domain between two bindings of the same project path", () => {
    const cwd = tempProject();
    const first = bindProjectConfiguration(true, cwd);
    const second = bindProjectConfiguration(true, cwd);

    first.sectionIO!.read("concurrency");
    expect(first.sectionIO!.commit("concurrency", { default: 2 })).toEqual({ ok: true });
    // The second binding reads through the same facade, so its observed
    // revision refreshes and its commit cannot silently lose the first write.
    second.sectionIO!.read("concurrency");
    expect(second.sectionIO!.commit("concurrency", { default: 5 })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(configFileOf(cwd), "utf-8"))).toEqual({ concurrency: { default: 5 } });
  });

  it("shows a commit made through one binding in another binding's state immediately", () => {
    const cwd = tempProject();
    const first = bindProjectConfiguration(true, cwd);
    const second = bindProjectConfiguration(true, cwd);
    expect(second.getState()).toBe("absent");

    first.sectionIO!.read("concurrency");
    expect(first.sectionIO!.commit("concurrency", { default: 2 })).toEqual({ ok: true });

    // The document state lives on the shared owner entry, not per binding: the
    // second binding already reads the committed value through the shared
    // facade, so its reported state must not lag behind as "absent".
    expect(second.getState()).toBe("loaded");
  });

  it("keeps different projects in different owners with no shared state", () => {
    const cwdA = tempProject();
    const cwdB = tempProject();
    const a = bindProjectConfiguration(true, cwdA);
    const b = bindProjectConfiguration(true, cwdB);

    a.sectionIO!.read("concurrency");
    expect(a.sectionIO!.commit("concurrency", { default: 2 })).toEqual({ ok: true });
    expect(a.getState()).toBe("loaded");
    expect(b.getState()).toBe("absent");
    expect(existsSync(configFileOf(cwdB))).toBe(false);
  });
});

describe("normalizeConfigPathKey", () => {
  it("normalizes separators and lowercases Windows-style paths", () => {
    expect(normalizeConfigPathKey("C:\\Repo\\Project")).toBe("c:/repo/project");
    expect(normalizeConfigPathKey("C:/Repo/Project")).toBe("c:/repo/project");
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(normalizeConfigPathKey("/Repo/Project")).toBe("/Repo/Project");
  });

  it("keys a relative path to its host-resolved absolute form", () => {
    const relative = path.join("Config", "Sub.JSON");
    expect(normalizeConfigPathKey(relative)).toBe(normalizeConfigPathKey(path.resolve(relative)));
  });
});

describe("REQ-RUNTIME-008 layered concurrency owner routing", () => {
  function fakeManager() {
    const replaced: unknown[] = [];
    return { replaced, manager: { replaceLimits: (limits: unknown) => { replaced.push(limits); } } as any };
  }

  it("REQ-CONFIG-003 routes a project write to the project file only and republishes merged limits", async () => {
    const { updateConcurrencyLimits, concurrencyMergedLimits } = await import("../../src/bootstrap/concurrency.js");
    const cwd = tempProject();
    const binding = bindProjectConfiguration(true, cwd);
    const { replaced, manager } = fakeManager();

    const result = updateConcurrencyLimits(
      { target: "project", update: { scope: "provider", key: "openai", limit: 2 } },
      manager,
      binding,
    );

    expect(result).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(configFileOf(cwd), "utf-8"))).toEqual({ concurrency: { providers: { openai: 2 } } });
    expect(replaced).toHaveLength(1);
    expect((replaced[0] as { providerLimits: Record<string, number> }).providerLimits.openai).toBe(2);
    expect(concurrencyMergedLimits(binding).providerLimits.openai).toBe(2);
  });

  it("REQ-CONFIG-003 treats clearing an override the project never had as a no-op that creates no file", async () => {
    const { updateConcurrencyLimits } = await import("../../src/bootstrap/concurrency.js");
    const cwd = tempProject();
    const binding = bindProjectConfiguration(true, cwd);
    const { replaced, manager } = fakeManager();

    const result = updateConcurrencyLimits(
      { target: "project", update: { scope: "provider", key: "openai", limit: null } },
      manager,
      binding,
    );

    expect(result).toEqual({ ok: true });
    expect(existsSync(configFileOf(cwd))).toBe(false);
    expect(replaced).toEqual([]);
    expect(binding.getState()).toBe("absent");
  });

  it("REQ-CONFIG-003 refuses a keyed clear on a malformed project document instead of an ok no-op", async () => {
    const { updateConcurrencyLimits } = await import("../../src/bootstrap/concurrency.js");
    const cwd = tempProject();
    const filePath = configFileOf(cwd);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json");
    const binding = bindProjectConfiguration(true, cwd);
    const { replaced, manager } = fakeManager();

    // A keyed clear against the empty in-memory view of a malformed document
    // produces an empty plan; the malformed refusal must still win over the
    // empty-plan no-op so every write to a malformed layer is refused alike.
    const result = updateConcurrencyLimits(
      { target: "project", update: { scope: "provider", key: "openai", limit: null } },
      manager,
      binding,
    );

    expect(result).toMatchObject({ ok: false, code: "document-malformed" });
    expect(replaced).toEqual([]);
    expect(readFileSync(filePath, "utf-8")).toBe("{ not json");
  });

  it("REQ-RUNTIME-008 does not replace scheduler limits when the commit fails", async () => {
    const { updateConcurrencyLimits } = await import("../../src/bootstrap/concurrency.js");
    const cwd = tempProject();
    const filePath = configFileOf(cwd);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json");
    const binding = bindProjectConfiguration(true, cwd);
    const { replaced, manager } = fakeManager();

    const result = updateConcurrencyLimits(
      { target: "project", update: { scope: "default", limit: 9 } },
      manager,
      binding,
    );

    expect(result).toMatchObject({ ok: false, code: "document-malformed" });
    expect(replaced).toEqual([]);
    expect(readFileSync(filePath, "utf-8")).toBe("{ not json");
  });

  it("REQ-RUNTIME-008 clearing a project override makes the scheduler adopt the latest global value", async () => {
    const { updateConcurrencyLimits } = await import("../../src/bootstrap/concurrency.js");
    const cwd = tempProject();
    const filePath = configFileOf(cwd);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ concurrency: { providers: { openai: 1 } } }));
    const binding = bindProjectConfiguration(true, cwd);
    const { replaced, manager } = fakeManager();

    // Shadowed global write: persists but the effective value stays the
    // project override.
    const globalWrite = updateConcurrencyLimits(
      { target: "global", update: { scope: "provider", key: "openai", limit: 7 } },
      manager,
      binding,
    );
    expect(globalWrite).toEqual({ ok: true });
    expect((replaced[0] as { providerLimits: Record<string, number> }).providerLimits.openai).toBe(1);

    const cleared = updateConcurrencyLimits(
      { target: "project", update: { scope: "provider", key: "openai", limit: null } },
      manager,
      binding,
    );
    expect(cleared).toEqual({ ok: true });
    expect((replaced[1] as { providerLimits: Record<string, number> }).providerLimits.openai).toBe(7);
    // The project container emptied, so the key was removed entirely.
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ concurrency: {} });
  });
});
