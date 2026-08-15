import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { scanRequirementTags } from "./requirement-tag-scan.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const requiredModuleDocs = ["index.md", "contracts.md", "testing.md", "decisions.md"];

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (path.endsWith(".md")) files.push(path);
  }
  return files;
}

function scopedMarkdownFiles(): string[] {
  return [
    resolve(projectRoot, "AGENTS.md"),
    resolve(projectRoot, "CLAUDE.md"),
    resolve(projectRoot, ".agents/skills/pre-push-checks/SKILL.md"),
    resolve(projectRoot, "CONTEXT.md"),
    resolve(projectRoot, "README.md"),
    ...markdownFiles(resolve(projectRoot, "docs")),
    ...markdownFiles(resolve(projectRoot, "src/modules")),
  ];
}

interface MarkdownLink {
  readonly path: string;
  readonly fragment?: string;
}

/**
 * Inline links and reference definitions, with the fragment kept. Dropping the
 * fragment is what let a link survive after its heading was renamed: the file
 * still resolves, so the check passes while the reader lands at the top of a
 * long document with no way to know what was meant.
 */
function repositoryLinks(source: string): MarkdownLink[] {
  const text = readFileSync(source, "utf8");
  const raw = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]),
  ];
  return raw
    .filter((target) => !/^(?:https?:|mailto:)/.test(target))
    .map((target) => {
      const hash = target.indexOf("#");
      if (hash < 0) return { path: target };
      return { path: target.slice(0, hash), fragment: target.slice(hash + 1) };
    })
    .filter((link) => link.path !== "" || link.fragment !== undefined);
}

/** GitHub heading slugs: lowercase, punctuation dropped, spaces hyphenated. */
function headingSlugs(file: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of readFileSync(file, "utf8").matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
    const base = match[1]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      // One hyphen per space, matching github-slugger: dropped punctuation
      // between words leaves the spaces behind, so `A — B` anchors as `a--b`.
      .replace(/ /g, "-");
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

function requirementIds(): { defined: Set<string>; referenced: Set<string> } {
  const prdFiles = markdownFiles(resolve(projectRoot, "docs/product/prd"));
  const defined = new Set<string>();
  for (const file of prdFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(/^### (REQ-[A-Z]+-\d+) /gm)) defined.add(match[1]);
  }

  const referenced = new Set<string>();
  const sources = [
    ...markdownFiles(resolve(projectRoot, "src/modules")),
  ];
  for (const file of sources) {
    for (const match of readFileSync(file, "utf8").matchAll(/REQ-[A-Z]+-\d+/g)) referenced.add(match[0]);
  }
  return { defined, referenced };
}

describe("documentation guards", () => {
  it("keeps scoped repository links and required module documents valid", () => {
    const errors: string[] = [];
    for (const source of scopedMarkdownFiles()) {
      for (const link of repositoryLinks(source)) {
        const target = link.path === "" ? source : resolve(dirname(source), link.path);
        if (!target.startsWith(projectRoot)) continue;
        if (!statSync(target, { throwIfNoEntry: false })) {
          errors.push(`${relative(projectRoot, source)} -> ${link.path}`);
          continue;
        }
        if (link.fragment === undefined || !target.endsWith(".md")) continue;
        if (!headingSlugs(target).has(link.fragment.toLowerCase())) {
          errors.push(`${relative(projectRoot, source)} -> ${link.path}#${link.fragment}`);
        }
      }
    }
    for (const module of readdirSync(resolve(projectRoot, "src/modules"))) {
      const moduleDirectory = resolve(projectRoot, "src/modules", module);
      if (!statSync(moduleDirectory).isDirectory()) continue;
      for (const required of requiredModuleDocs) {
        if (!statSync(resolve(moduleDirectory, "docs", required), { throwIfNoEntry: false })) {
          errors.push(`${relative(projectRoot, moduleDirectory)}/docs/${required}`);
        }
      }
      if (readdirSync(moduleDirectory).some((entry) => /^README(?:\.|$)/i.test(entry))) {
        errors.push(`${relative(projectRoot, moduleDirectory)} contains a module README`);
      }
    }
    expect(errors).toEqual([]);
  });

  it("keeps every active requirement defined and assigned to a module", () => {
    const { defined, referenced } = requirementIds();
    expect([...referenced].filter((id) => !defined.has(id))).toEqual([]);
    expect([...defined].filter((id) => !referenced.has(id))).toEqual([]);
  });

  it("collects executed requirement titles and ignores comments and skipped tests", () => {
    expect(scanRequirementTags(
      [
        "// it(\"REQ-GHOST-001 comment only\")",
        "it.skip(\"REQ-GHOST-002 skipped\", () => {});",
        "it.todo(\"REQ-GHOST-003\");",
        "describe.skip(\"REQ-GHOST-004\", () => {});",
        "it.skipIf(true)(\"REQ-GHOST-005\", () => {});",
        "xit(\"REQ-GHOST-006\", () => {});",
        "it(`REQ-${id}`, () => {});",
        "describe.skip(\"parked\", () => { it(\"REQ-GHOST-007 nested in skipped describe\", () => {}); });",
        "it(\"REQ-REAL-001 runs\", () => { expect(1).toBe(1); });",
        "describe(\"REQ-REAL-002 suite\", () => { it(\"nested\", () => { expect(1).toBe(1); }); });",
        "it(\"REQ-TITLE-ONLY-001 title only\", () => {});",
      ].join("\n"),
      "fixture.test.ts",
    )).toEqual(["REQ-REAL-001", "REQ-REAL-002"]);
  });

  // A tagged title still needs an expect() in the body. The expect is not
  // required to mention the same REQ — that would be parsing assertion
  // meaning — but a title-only it() is not coverage.
  it("keeps every active requirement exercised by at least one executed tagged test title", () => {
    const { defined } = requirementIds();
    const tagged = new Set<string>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          visit(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        for (const id of scanRequirementTags(readFileSync(path, "utf8"), path)) tagged.add(id);
      }
    };
    visit(resolve(projectRoot, "test"));
    expect([...defined].filter((id) => !tagged.has(id))).toEqual([]);
  });
});
