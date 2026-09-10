import { describe, it, expect, vi } from "vitest";
import { join, resolve } from "node:path";
import { makeSkill, mockLoadSkills, mockLoadSkillsFromDir } from "../../support/skills.js";
import { loadAllSkills, loadSkillMeta } from "../../../src/prompt/skill-loader.js";
import { createTestHarness } from "../../support/harness.js";
import { homedir } from "node:os";

vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readdirSync: () => [".git"],
  realpathSync: (path: string) => path,
}));

const tmpDir = resolve("skill-fixture");

describe("loadAllSkills", () => {
  it("uses the Pi directory override while retaining the OS home skills root", async () => {
    const harness = createTestHarness();
    try {
      const directory = harness.createTempDir();
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
      loadAllSkills(tmpDir);
      expect(mockLoadSkills).toHaveBeenCalledWith(expect.objectContaining({ agentDir: directory }));
      expect(mockLoadSkillsFromDir).toHaveBeenCalledWith(expect.objectContaining({ dir: join(homedir(), ".agents", "skills") }));
    } finally {
      await harness.dispose();
    }
  });
  it("loads from .pi/skills via loadSkills (Pi defaults)", () => {
    const tddSkill = makeSkill("tdd", "TDD workflow", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [tddSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(mockLoadSkills).toHaveBeenCalledWith(expect.objectContaining({
      cwd: tmpDir,
      includeDefaults: true,
    }));
  });

  it("loads ancestor .agents/skills via loadSkillsFromDir", () => {
    const agentsSkill = makeSkill("agents-skill", "From agents", join(tmpDir, ".agents", "skills", "agents-skill", "SKILL.md"));
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result.some((s) => s.name === "agents-skill")).toBe(true);
    expect(mockLoadSkillsFromDir).toHaveBeenCalledWith(expect.objectContaining({
      dir: join(tmpDir, ".agents", "skills"),
      source: "agents",
    }));
  });

  it("filters root .md files from .agents/skills directories", () => {
    const rootSkill = makeSkill("root-skill", "Root level", join(tmpDir, ".agents", "skills", "root-skill.md"));
    const dirSkill = makeSkill("dir-skill", "Dir level", join(tmpDir, ".agents", "skills", "dir-skill", "SKILL.md"));
    const agentsSkillsDir = join(tmpDir, ".agents", "skills");
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) => {
      // Only return skills for the tmpDir's .agents/skills
      if (dir === agentsSkillsDir) return { skills: [rootSkill, dirSkill], diagnostics: [] };
      return { skills: [], diagnostics: [] };
    });

    const result = loadAllSkills(tmpDir);

    // Root .md file should be filtered out (parent === skillsRoot)
    expect(result.some((s) => s.name === "root-skill")).toBe(false);
    expect(result.some((s) => s.name === "dir-skill")).toBe(true);
  });

  it("gives ancestor .agents/skills higher precedence than defaults", () => {
    const defaultSkill = makeSkill("tdd", "Default TDD", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    const agentsSkill = makeSkill("tdd", "Agents TDD", join(tmpDir, ".agents", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Agents TDD");
  });

  it("deduplicates by name (first match wins)", () => {
    const skill1 = makeSkill("dup", "First", join(tmpDir, ".agents", "skills", "dup", "SKILL.md"));
    const skill2 = makeSkill("dup", "Second", join(tmpDir, ".pi", "skills", "dup", "SKILL.md"));
    mockLoadSkillsFromDir.mockReturnValue({ skills: [skill1], diagnostics: [] });
    mockLoadSkills.mockReturnValue({ skills: [skill2], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("First");
  });
});

describe("loadSkillMeta", () => {
  it("returns metadata only from a skill directory", () => {
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "Test-driven development workflow", tddPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].location).toContain("SKILL.md");
    expect(result[0].location).not.toContain("TDD Steps");
  });

  it("returns metadata from a flat skill file", () => {
    const debugPath = join(tmpDir, ".pi", "skills", "debug.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("debug", "Debugging workflow", debugPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].location).toContain("debug.md");
  });

  it("returns not-found description for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].description).toContain("not found");
    expect(result[0].location).toBe("");
  });

  it("loads multiple skills metadata", () => {
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    const debugPath = join(tmpDir, ".pi", "skills", "debug", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [
        makeSkill("tdd", "TDD workflow", tddPath),
        makeSkill("debug", "Debug workflow", debugPath),
      ],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd", "debug"], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("TDD workflow");
    expect(result[1].name).toBe("debug");
    expect(result[1].description).toBe("Debug workflow");
  });

  it("threads disableModelInvocation from loaded skill", () => {
    const skillPath = join(tmpDir, ".pi", "skills", "internal", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("internal", "Internal tool", skillPath, { disableModelInvocation: true })],
      diagnostics: [],
    });

    const result = loadSkillMeta(["internal"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(true);
  });

  it("defaults disableModelInvocation to false for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(false);
  });
});
