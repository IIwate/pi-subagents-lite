import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSkill, mockLoadSkills, mockFormatSkillsForPrompt } from "../../support/skills.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { createSkillDir, createFlatSkill } from "../../support/fixtures.js";
import { preloadSkills, loadSkillMeta } from "../../../src/prompt/skill-loader.js";
import { buildAgentPrompt } from "../../../src/prompt/prompts.js";
import type { AgentConfig } from "../../../src/agents/types.js";
import type { EnvInfo } from "../../../src/types.js";

let harness: TestHarness;
let tmpDir: string;

beforeEach(() => {
  harness = createTestHarness();
  tmpDir = harness.createTempDir();
});
afterEach(async () => { await harness.dispose(); });

/* ------------------------------------------------------------------ */
/*  Skill file loading                                               */
/* ------------------------------------------------------------------ */

describe("preloadSkills", () => {
  it("loads full content and extracts description from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "Test-driven development workflow", tddPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].content).toContain("## TDD Steps");
    expect(result[0].content).toContain("1. Red");
  });

  it("loads full content and extracts description from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");
    const debugPath = join(tmpDir, ".pi", "skills", "debug.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("debug", "Debugging workflow", debugPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].content).toContain("## Debug Steps");
  });

  it("returns error message for missing skill", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  Integration: prompt building with secret token proof              */
/* ------------------------------------------------------------------ */

const SECRET_TOKEN = "PROOF_TOKEN_ALPHA_7X9K2M";
const BODY_MARKER = "This line proves full content was loaded";

const baseConfig: AgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
};

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "linux",
};

function createProofSkill() {
  createSkillDir(tmpDir, "proof-skill", "Skill with secret token",
    `## Secret Token\n${SECRET_TOKEN}\n\n${BODY_MARKER}`);
}

describe("Prompt integration: whitelist excludes body", () => {
  it("available_skills has metadata but NOT secret token", () => {
    createProofSkill();
    const tddPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("proof-skill", "Skill with secret token", tddPath)],
      diagnostics: [],
    });
    mockFormatSkillsForPrompt.mockReturnValue(
      `<skill><name>proof-skill</name><description>Skill with secret token</description><location>${tddPath}</location></skill>`,
    );

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).toContain("Use the read tool to load a skill's file");

    expect(prompt).not.toContain(SECRET_TOKEN);
    expect(prompt).not.toContain(BODY_MARKER);
  });
});

describe("Prompt integration: preload in available_skills with content tag", () => {
  it("Preloaded skill appears in available_skills with content tag", () => {
    createProofSkill();
    const tddPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("proof-skill", "Skill with secret token", tddPath)],
      diagnostics: [],
    });

    const blocks = preloadSkills(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillBlocks: blocks });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<skill><name>proof-skill</name><description>Skill with secret token</description><content>");
    expect(prompt).toContain(SECRET_TOKEN);
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).toContain("</content></skill>");
    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

describe("Prompt integration: both together", () => {
  it("metadata skill has no secret, preloaded skill has secret in content tag", () => {
    createProofSkill();
    createSkillDir(tmpDir, "other-skill", "Another skill", "OTHER_SECRET_123");

    const proofPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    const otherPath = join(tmpDir, ".pi", "skills", "other-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [
        makeSkill("proof-skill", "Skill with secret token", proofPath),
        makeSkill("other-skill", "Another skill", otherPath),
      ],
      diagnostics: [],
    });
    mockFormatSkillsForPrompt.mockReturnValue(
      `<skill><name>proof-skill</name><description>Skill with secret token</description><location>${proofPath}</location></skill>`,
    );

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const blocks = preloadSkills(["other-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas, skillBlocks: blocks });

    // Single available_skills block
    const blockCount = (prompt.match(/<available_skills>/g) || []).length;
    expect(blockCount).toBe(1);

    // proof-skill: metadata only (location) — from formatSkillsForPrompt
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).not.toContain(SECRET_TOKEN);

    // other-skill: preloaded (content tag)
    expect(prompt).toContain("<skill><name>other-skill</name><description>Another skill</description><content>");
    expect(prompt).toContain("OTHER_SECRET_123");

    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

/* ------------------------------------------------------------------ */
/*  Skill file loading — description from Skill object               */
/* ------------------------------------------------------------------ */

describe("preloadSkills — description from Skill object", () => {
  it("returns empty description when skill not found", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].description).toBe("");
  });

  it("uses description from Skill object", () => {
    createSkillDir(tmpDir, "test-skill", "My skill description", "Body text");
    const skillPath = join(tmpDir, ".pi", "skills", "test-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("test-skill", "My skill description", skillPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["test-skill"], tmpDir);
    expect(result[0].description).toBe("My skill description");
  });

  it("returns empty description when Skill has no description", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "plain");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "Just body text, no frontmatter.");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("plain", "", skillPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["plain"], tmpDir);
    expect(result[0].description).toBe("");
  });

  it("handles file read errors gracefully", () => {
    const missingPath = join(tmpDir, ".pi", "skills", "gone", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("gone", "Was here", missingPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["gone"], tmpDir);
    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
  });
});
