/**
 * Filesystem translation for Agent markdown files.
 * Product merge and loading policy live in agent-catalogue.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Raw agent config as parsed from .md frontmatter. */
export interface AgentConfigFromMd {
  name?: string;
  display_name?: string;
  description?: string;
  tools?: string[];
  exclude_tools?: string[];
  extensions?: boolean | string[];
  exclude_extensions?: string[];
  skills?: boolean | string[];
  preload_skills?: string[] | false;
  max_turns?: number;
  max_tokens?: number;
  hidden?: boolean;
  systemPrompt: string;
  source: "user" | "project";
}

function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  if (!content) {
    return { frontmatter: {}, body: "" };
  }

  const openingDelimiterLength = content.startsWith("---\r\n") ? 5 : 4;
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }

  const closingDelimiter = /\r?\n---\r?\n/g;
  closingDelimiter.lastIndex = openingDelimiterLength;
  const delimiterMatch = closingDelimiter.exec(content);
  if (!delimiterMatch) {
    return { frontmatter: {}, body: content };
  }

  const fmRaw = content.slice(openingDelimiterLength, delimiterMatch.index);
  const body = content.slice(delimiterMatch.index + delimiterMatch[0].length).trim();

  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentValues: string[] | null = null;

  for (const line of fmRaw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith("- ")) {
      if (currentKey) {
        if (!currentValues) currentValues = [];
        currentValues.push(trimmed.slice(2).trim());
      }
      continue;
    }

    if (currentKey && currentValues) {
      frontmatter[currentKey] = currentValues;
      currentValues = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      currentKey = trimmed;
      continue;
    }

    currentKey = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      currentValues = [];
      continue;
    }

    frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, "");
    currentValues = null;
  }

  if (currentKey && currentValues) {
    frontmatter[currentKey] = currentValues;
  }

  return { frontmatter, body };
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/^\[|\]$/g, "").trim())
    .filter((s) => s.length > 0);
}

export function parseExtensions(
  raw: unknown,
): boolean | string[] | undefined {
  if (raw === false || raw === "false" || raw === "none") {
    return false;
  }
  if (raw === true || raw === "true" || raw === "all") {
    return true;
  }
  if (typeof raw === "string" && raw.length > 0) {
    return splitCommaList(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return undefined;
}

function parsePreloadSkills(
  raw: unknown,
): string[] | false | undefined {
  if (raw === false || raw === "false" || raw === "none") {
    return false;
  }
  if (typeof raw === "string" && raw.length > 0) {
    return splitCommaList(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return undefined;
}

function parseString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = frontmatter[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = frontmatter[key];
  if (Array.isArray(v)) {
    return v.map(String);
  }
  if (typeof v === "string" && v.length > 0) {
    return splitCommaList(v);
  }
  return undefined;
}

function parseBoolean(
  frontmatter: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = frontmatter[key];
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}

function parseNumber(
  frontmatter: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = frontmatter[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

export function parseAgentFile(
  content: string,
  source: "user" | "project",
): AgentConfigFromMd {
  const { frontmatter, body } = parseFrontmatter(content);
  if (Object.hasOwn(frontmatter, "thinking")) {
    console.warn("[subagents] Agent frontmatter field `thinking` is retired and was ignored.");
  }

  return {
    name: parseString(frontmatter, "name"),
    display_name: parseString(frontmatter, "display_name"),
    description: parseString(frontmatter, "description"),
    tools: parseStringArray(frontmatter, "tools"),
    exclude_tools: parseStringArray(frontmatter, "exclude_tools"),
    extensions: parseExtensions(frontmatter.extensions),
    exclude_extensions: parseStringArray(frontmatter, "exclude_extensions"),
    skills: parseExtensions(frontmatter.skills),
    preload_skills: parsePreloadSkills(frontmatter.preload_skills),
    max_turns: parseNumber(frontmatter, "max_turns"),
    max_tokens: parseNumber(frontmatter, "max_tokens"),
    hidden: parseBoolean(frontmatter, "hidden"),
    systemPrompt: body,
    source,
  };
}

export async function scanAgentFilesInDir(
  dirPath: string,
  source: "user" | "project" = "user",
): Promise<AgentConfigFromMd[]> {
  try {
    await fs.promises.access(dirPath);
  } catch {
    return [];
  }

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const mdFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  );

  const agents: AgentConfigFromMd[] = [];
  for (const entry of mdFiles) {
    const filePath = path.join(dirPath, entry.name);
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const info = parseAgentFile(content, source);
      if (info.name) {
        agents.push(info);
      }
    } catch {
      // Skip files that can't be read
    }
  }
  return agents;
}
