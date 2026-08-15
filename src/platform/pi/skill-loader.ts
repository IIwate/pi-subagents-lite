/**
 * skill-loader.ts — Load skills using Pi's exported APIs.
 *
 * Aligns skill discovery with Pi so subagents see the same skills as the parent session.
 *
 * Roots, in precedence order (first match wins by name):
 *   1. Ancestor .agents/skills (cwd → git root, root .md files filtered out)
 *   2. <userHome>/.agents/skills (root .md files filtered out)
 *   3. <agentDir>/skills (Pi's user default)
 *   4. <cwd>/.pi/skills (Pi's project default)
 *
 * The roots are separate inputs for separate policies. `userHome` follows the
 * extension's HOME resolution, which now serves only `.agents/skills` (see
 * configuration operations doc); `agentDir` is Pi's resolved resource root and
 * the source of every other persisted extension file. Folding them into one
 * home split explicit skills from the child session under Pi agent-dir
 * overrides or MSYS-style HOME values.
 *
 * Pi's loadSkills handles: .gitignore/.ignore/.fdignore, symlinks (follow +
 * canonical-path dedup), YAML frontmatter, name validation.
 *
 * loadSkillsFromDir handles the same for individual .agents/skills directories.
 * Root .md files from .agents/skills are filtered out because Pi's "agents"
 * mode (no root files) is not exported.
 */

import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatSkillsForPrompt,
  loadSkills,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { isUnsafeName } from "../../utils.js";

/** The two independent roots skill discovery reads from. */
export interface SkillRoots {
  /** User-level `.agents/skills` root — this extension's resolved config home. */
  userHome: string;
  /** Pi's agent directory — the Pi-default skill root, shared with the child session. */
  agentDir: string;
}

export interface PreloadedSkill {
  name: string;
  description: string;
  content: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Whether the skill should be excluded from the <available_skills> prompt block. */
  disableModelInvocation: boolean;
  /** Full skill content — present when the skill is preloaded. */
  content?: string;
}

/**
 * Load all skills in correct precedence order.
 *
 * Precedence (first match wins by name):
 *   1. Ancestor .agents/skills directories (cwd → git root)
 *   2. <userHome>/.agents/skills
 *   3. Pi defaults: <agentDir>/skills, <cwd>/.pi/skills
 *
 * Deduplication: by canonical path (symlink dedup) and by name (first match wins).
 */
export function loadAllSkills(cwd: string, roots: SkillRoots): Skill[] {
  const resolvedCwd = resolve(cwd);

  // Ancestor .agents/skills (highest precedence)
  const ancestorsSkills = loadAncestorAgentsSkills(resolvedCwd);

  // <userHome>/.agents/skills
  const homeAgentsDir = join(roots.userHome, ".agents", "skills");
  const homeAgentsResult = loadSkillsFromDir({
    dir: homeAgentsDir,
    source: "agents",
  });
  const homeAgentsSkills = filterRootMdFiles(homeAgentsResult.skills, homeAgentsDir);

  // The caller resolves Pi's root once; every child resource then sees the
  // same directory rather than a locally reconstructed approximation.
  const defaultsResult = loadSkills({
    cwd: resolvedCwd,
    agentDir: roots.agentDir,
    skillPaths: [],
    includeDefaults: true,
  });

  // Merge in precedence order: ancestors first, then home, then defaults.
  // First match wins by name and by canonical path.
  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const skill of [...ancestorsSkills, ...homeAgentsSkills, ...defaultsResult.skills]) {
    const realPath = canonicalizePath(skill.filePath);
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(skill);
  }

  return result;
}

/**
 * Walk from cwd up to git root, loading skills from each .agents/skills directory.
 * Filters out root .md files (Pi's exported API doesn't support "agents" mode).
 */
function loadAncestorAgentsSkills(resolvedCwd: string): Skill[] {
  const gitRoot = findGitRoot(resolvedCwd);
  const result: Skill[] = [];
  let dir = resolvedCwd;

  while (true) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    const dirResult = loadSkillsFromDir({
      dir: agentsSkillsDir,
      source: "agents",
    });
    result.push(...filterRootMdFiles(dirResult.skills, agentsSkillsDir));

    if (dir === gitRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return result;
}

/**
 * Filter out root .md files from .agents/skills directories.
 *
 * loadSkillsFromDir always includes root .md files (includeRootFiles: true),
 * but .agents/skills directories should only contain subdirectory skills.
 * A root .md skill has a filePath whose parent is the skills root itself.
 */
function filterRootMdFiles(skills: Skill[], skillsRoot: string): Skill[] {
  const normalizedRoot = resolve(skillsRoot);
  return skills.filter((skill) => {
    const parent = resolve(skill.filePath, "..");
    return parent !== normalizedRoot;
  });
}

/** Walk up from dir to find the git root (directory containing .git). */
function findGitRoot(dir: string): string {
  let current = resolve(dir);
  while (true) {
    try {
      const entries = readdirSync(current);
      if (entries.includes(".git")) return current;
    } catch { /* ignore */ }
    const parent = resolve(current, "..");
    if (parent === current) return current; // filesystem root
    current = parent;
  }
}

/** Resolve path to canonical form, following symlinks. Falls back to raw path. */
function canonicalizePath(filePath: string): string {
  try { return realpathSync(filePath); } catch { return filePath; }
}

export function preloadSkills(skillNames: string[], cwd: string, roots: SkillRoots): PreloadedSkill[] {
  const skills = loadAllSkills(cwd, roots);
  return skillNames.map((name) => {
    if (isUnsafeName(name)) {
      return { name, description: "", content: `(Skill "${name}" skipped: name contains path traversal characters)` };
    }
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return { name, description: "", content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)` };
    }
    try {
      return { name, description: match.description, content: readFileSync(match.filePath, "utf-8").trim() };
    } catch {
      return { name, description: "", content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)` };
    }
  });
}

/**
 * Load skill metadata only (name, description, location) without full content.
 * Used for the skills whitelist — agent can read full content on-demand.
 */
export function loadSkillMeta(skillNames: string[], cwd: string, roots: SkillRoots): SkillMeta[] {
  const skills = loadAllSkills(cwd, roots);
  return skillNames.map((name) => {
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return { name, description: `(Skill "${name}" not found)`, location: "", disableModelInvocation: false };
    }
    return {
      name,
      description: match.description,
      location: match.filePath,
      disableModelInvocation: match.disableModelInvocation,
    };
  });
}

/**
 * Render whitelisted skill metadata as `<skill>` elements.
 *
 * Pi owns the wording of the advertised skill block, so the metadata is fed
 * back through its formatter and the elements are extracted. Prompt assembly
 * receives strings and never sees a vendor Skill object.
 */
export function formatSkillMetaElements(metas: readonly SkillMeta[]): string[] {
  if (metas.length === 0) return [];
  const piSkills: Skill[] = metas.map((meta) => ({
    name: meta.name,
    description: meta.description,
    filePath: meta.location,
    baseDir: "",
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: meta.disableModelInvocation,
  }));
  return formatSkillsForPrompt(piSkills).match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
}

