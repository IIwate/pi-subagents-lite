/**
 * skill-loader.test.ts — Skill discovery and prompt integration.
 *
 * Runs against the real Pi loaders over real temp directories. Mocking the
 * vendor package here used to make the suite green while proving nothing about
 * discovery order, so cwd and home are pointed at fixtures instead: what Pi
 * actually finds on disk is the thing under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatSkillMetaElements,
  loadAllSkills,
  loadSkillMeta,
  preloadSkills,
} from "../../../src/platform/pi/skill-loader.ts";
import { buildAgentPrompt } from "../../../src/prompt/prompts.ts";
import type { AgentConfig } from "../../../src/agents/types.ts";
import type { EnvInfo } from "../../../src/types.ts";
import { createSkillDir, createFlatSkill } from "../../fixtures.ts";

let tmpDir: string;

/** Skills live under the fixture root; home is pinned there so nothing outside leaks in. */
function skills(cwd: string = tmpDir) {
  return loadAllSkills(cwd, tmpDir);
}

/** Write a skill into `<home>/.agents/skills/<name>/SKILL.md` (the highest-precedence source). */
function createAgentsSkill(root: string, name: string, description: string, body: string) {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ------------------------------------------------------------------ */
/*  Unit: loadAllSkills                                               */
/* ------------------------------------------------------------------ */

describe("loadAllSkills", () => {
  it("loads project skills from .pi/skills", () => {
    createSkillDir(tmpDir, "tdd", "TDD workflow", "## TDD Steps\n1. Red");

    const result = skills();

    expect(result.map((skill) => skill.name)).toContain("tdd");
    expect(result.find((skill) => skill.name === "tdd")?.description).toBe("TDD workflow");
  });

  it("loads .agents/skills from the resolved home directory", () => {
    createAgentsSkill(tmpDir, "agents-skill", "From agents", "Body");

    expect(skills().some((skill) => skill.name === "agents-skill")).toBe(true);
  });

  it("filters root .md files directly under an .agents/skills directory", () => {
    const agentsSkills = join(tmpDir, ".agents", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    writeFileSync(
      join(agentsSkills, "root-skill.md"),
      "---\nname: root-skill\ndescription: Root level\n---\n\nBody",
    );
    createAgentsSkill(tmpDir, "dir-skill", "Dir level", "Body");

    const result = skills();

    // Root-level files are reserved for notes, not skills: only nested
    // directories describe a loadable skill.
    expect(result.some((skill) => skill.name === "root-skill")).toBe(false);
    expect(result.some((skill) => skill.name === "dir-skill")).toBe(true);
  });

  it("gives .agents/skills precedence over the Pi defaults on a name clash", () => {
    createSkillDir(tmpDir, "tdd", "Default TDD", "Default body");
    createAgentsSkill(tmpDir, "tdd", "Agents TDD", "Agents body");

    const matches = skills().filter((skill) => skill.name === "tdd");

    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe("Agents TDD");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: preloadSkills                                               */
/* ------------------------------------------------------------------ */

describe("preloadSkills", () => {
  it("loads full content and description from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");

    const result = preloadSkills(["tdd"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].content).toContain("## TDD Steps");
    expect(result[0].content).toContain("1. Red");
  });

  it("loads full content and description from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce");

    const result = preloadSkills(["debug"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].content).toContain("## Debug Steps");
  });

  it("reports a missing skill in place of its content", () => {
    const result = preloadSkills(["nonexistent"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
  });

  it("reports an unreadable skill file in place of its content", () => {
    createSkillDir(tmpDir, "gone", "Was here", "Body");
    rmSync(join(tmpDir, ".pi", "skills", "gone", "SKILL.md"));

    const result = preloadSkills(["gone"], tmpDir, tmpDir);

    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
  });

  it("returns an empty description when the skill file has no frontmatter", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "plain");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Just body text, no frontmatter.");

    const result = preloadSkills(["plain"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: loadSkillMeta                                               */
/* ------------------------------------------------------------------ */

describe("loadSkillMeta", () => {
  it("returns metadata without the body from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red");

    const result = loadSkillMeta(["tdd"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].location).toContain("SKILL.md");
    expect(result[0].location).not.toContain("TDD Steps");
  });

  it("returns metadata from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps");

    const result = loadSkillMeta(["debug"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].location).toContain("debug.md");
  });

  it("reports a missing skill without a location", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir, tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toContain("not found");
    expect(result[0].location).toBe("");
    expect(result[0].disableModelInvocation).toBe(false);
  });

  it("loads metadata for several skills in request order", () => {
    createSkillDir(tmpDir, "tdd", "TDD workflow", "Body");
    createSkillDir(tmpDir, "debug", "Debug workflow", "Body");

    const result = loadSkillMeta(["tdd", "debug"], tmpDir, tmpDir);

    expect(result.map((meta) => meta.name)).toEqual(["tdd", "debug"]);
    expect(result.map((meta) => meta.description)).toEqual(["TDD workflow", "Debug workflow"]);
  });

  it("threads disableModelInvocation from the skill frontmatter", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "internal");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: internal\ndescription: Internal tool\ndisable-model-invocation: true\n---\n\nBody",
    );

    const result = loadSkillMeta(["internal"], tmpDir, tmpDir);

    expect(result[0].disableModelInvocation).toBe(true);
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

    const metas = loadSkillMeta(["proof-skill"], tmpDir, tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, {
      skillElements: formatSkillMetaElements(metas),
    });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).toContain("Use the read tool to load a skill's file");

    expect(prompt).not.toContain(SECRET_TOKEN);
    expect(prompt).not.toContain(BODY_MARKER);
  });

  it("escapes XML special characters through Pi's formatter", () => {
    createSkillDir(tmpDir, "xml-skill", 'Use <code> & "quotes"', "Body");

    const elements = formatSkillMetaElements(loadSkillMeta(["xml-skill"], tmpDir, tmpDir)).join("\n");

    expect(elements).toContain("&lt;code&gt;");
    expect(elements).toContain("&amp;");
    expect(elements).toContain("&quot;quotes&quot;");
  });

  it("omits a skill whose frontmatter disables model invocation", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "internal");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: internal\ndescription: Internal tool\ndisable-model-invocation: true\n---\n\nBody",
    );

    const elements = formatSkillMetaElements(loadSkillMeta(["internal"], tmpDir, tmpDir));

    expect(elements).toEqual([]);
  });
});

describe("Prompt integration: preload in available_skills with content tag", () => {
  it("Preloaded skill appears in available_skills with content tag", () => {
    createProofSkill();

    const blocks = preloadSkills(["proof-skill"], tmpDir, tmpDir);
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

    const metas = loadSkillMeta(["proof-skill"], tmpDir, tmpDir);
    const blocks = preloadSkills(["other-skill"], tmpDir, tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, {
      skillElements: formatSkillMetaElements(metas),
      skillBlocks: blocks,
    });

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
