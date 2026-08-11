import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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
    resolve(projectRoot, "CONTEXT.md"),
    ...markdownFiles(resolve(projectRoot, "docs")),
    ...markdownFiles(resolve(projectRoot, "src/modules")),
  ];
}

function relativeTargets(source: string): string[] {
  const text = readFileSync(source, "utf8");
  return [...text.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith(("http:")) && !target.startsWith("https:") && !target.startsWith("mailto:"));
}

function requirementIds(): { defined: Set<string>; referenced: Set<string> } {
  const prdFiles = markdownFiles(resolve(projectRoot, "docs/product/prd"));
  const defined = new Set<string>();
  for (const file of prdFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(/^### (REQ-[A-Z]+-\d+) /gm)) defined.add(match[1]);
  }

  const referenced = new Set<string>();
  const sources = [
    resolve(projectRoot, "docs/refactoring-plan.md"),
    ...markdownFiles(resolve(projectRoot, "src/modules")),
  ];
  for (const file of sources) {
    for (const match of readFileSync(file, "utf8").matchAll(/REQ-[A-Z]+-\d+/g)) referenced.add(match[0]);
  }
  return { defined, referenced };
}

describe("documentation migration guardrails", () => {
  it("keeps scoped repository links and required module documents valid", () => {
    const errors: string[] = [];
    for (const source of scopedMarkdownFiles()) {
      for (const target of relativeTargets(source)) {
        if (!resolve(dirname(source), target).startsWith(projectRoot)) continue;
        if (!statSync(resolve(dirname(source), target), { throwIfNoEntry: false })) {
          errors.push(`${relative(projectRoot, source)} -> ${target}`);
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
});
