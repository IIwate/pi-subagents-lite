/**
 * fixtures.ts — Shared test fixtures and helpers for the subagents extension tests.
 *
 * Provides:
 *   - createMockExtensionAPI: mock ExtensionAPI for index test
 *   - hasParam: check TypeBox schema for a parameter
 *   - loadExtension: import and invoke the extension factory
 *   - makeAgentMd: build agent .md content from frontmatter fields
 *   - tempDirWithFiles: create a temp dir with files for scanAgentFilesInDir tests
 *
 */

import { vi } from "vitest";
import type { TestHarness } from "./harness.js";

import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/*  Extension API mock                                                */
/* ------------------------------------------------------------------ */

export interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  parameters: any; // TypeBox TSchema
  execute?: (...args: any[]) => any;
  renderShell?: string;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
}

export interface RegisteredCommand {
  name: string;
  description: string;
  handler: (...args: any[]) => any;
}

export interface ListenerRegistration {
  event: string;
  handler: (...args: any[]) => any;
}

export interface RegisteredShortcut {
  shortcut: string;
  description?: string;
  handler: (...args: any[]) => any;
}

export interface MockExtensionAPI {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  listeners: ListenerRegistration[];
  shortcuts: RegisteredShortcut[];
  api: {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    registerShortcut: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
}

/**
 * Create a mock ExtensionAPI that captures registered tools, commands, and listeners.
 */
export function createMockExtensionAPI(): MockExtensionAPI {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const listeners: ListenerRegistration[] = [];
  const shortcuts: RegisteredShortcut[] = [];

  return {
    tools,
    commands,
    listeners,
    shortcuts,
    api: {
      registerTool: vi.fn((tool: any) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn((name: string, opts: any) => {
        commands.push({ name, ...opts });
      }),
      registerShortcut: vi.fn((shortcut: string, opts: any) => {
        shortcuts.push({ shortcut, ...opts });
      }),
      on: vi.fn((event: string, handler: any) => {
        listeners.push({ event, handler });
      }),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(),
    },
  };
}

/**
 * Check if a specific param exists in a TypeBox schema.
 */
export function hasParam(schema: any, paramName: string): boolean {
  return paramName in (schema?.properties ?? {});
}

/**
 * Import and invoke the extension factory.
 * Returns the factory function for chaining.
 */
export async function loadExtension(api: any) {
  const factory = (await import("../../src/index.js")).default;
  return factory(api);
}

/* ------------------------------------------------------------------ */
/*  Agent markdown helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal agent .md content string with frontmatter.
 * Fields are snake_case as they would appear in frontmatter.
 * Pass `_skip: string[]` to omit any fields from the defaults.
 */
export function makeAgentMd(overrides: Record<string, unknown> = {}): string {
  const skipFields = (overrides._skip as string[]) ?? [];
  const defaults: Record<string, string> = {
    name: "test-agent",
    description: "A test agent",
    display_name: "Test Agent",
    tools: "read, bash, edit",
    extensions: "true",
    skills: "true",
    thinking: "off",
    max_turns: "25",
  };
  const fm: Record<string, string> = { ...defaults };
  for (const [key, val] of Object.entries(overrides)) {
    if (key === "_skip") continue;
    if (val === undefined) {
      delete fm[key];
    } else {
      fm[key] = String(val);
    }
  }
  for (const key of skipFields) {
    delete fm[key];
  }
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nSystem prompt body text.`;
}

/**
 * Create a temp directory with agent .md files for scanAgentFilesInDir tests.
 * The harness owns the directory even when a file write or assertion fails.
 */
export function tempDirWithFiles(
  harness: TestHarness,
  files: Array<{ name: string; content: string }>,
  prefix = "agent-test",
): string {
  const dir = harness.createTempDir(prefix);
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content);
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/*  Fake context / pi                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create a minimal fake pi context for agent tests.
 */
export function fakeCtx(): any {
  return {
    cwd: "/home/test/project",
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: vi.fn(), getAll: vi.fn(() => []), getAvailable: vi.fn(() => []) },
    model: { provider: "test", id: "model" },
    scopedModels: [],
    getSystemPrompt: vi.fn(),
  };
}

/**
 * Create a minimal fake pi instance for agent tests.
 */
export function fakePi(): any {
  return { exec: vi.fn() };
}

/**
 * Create a resolvable promise for async concurrency tests.
 */
export function makeResolvablePromise() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ */
/*  Skill file helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a skill directory with SKILL.md in <tmpDir>/.pi/skills/<name>/.
 */
export function createSkillDir(tmpDir: string, name: string, description: string, body: string) {
  const skillDir = join(tmpDir, ".pi", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

/**
 * Create a flat skill file in <tmpDir>/.pi/skills/<name>.md.
 */
export function createFlatSkill(tmpDir: string, name: string, description: string, body: string) {
  const skillsDir = join(tmpDir, ".pi", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillsDir, `${name}.md`), content);
}
