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
 * Shared mock factories (for vi.mock call sites):
 *   - shellMock: ../src/shell.js stubs (parameterized by hoisted fns)
 */

import { vi } from "vitest";
import {
  parseAcceptedRunPolicy,
  type AcceptedRunPolicy,
} from "../src/modules/subagent-runtime/public.js";

/** Build a complete accepted policy for tests that enter the runtime spawn seam. */
export function acceptedRunPolicy(modelKey = "test/model"): AcceptedRunPolicy {
  const separator = modelKey.indexOf("/");
  if (separator < 1 || separator === modelKey.length - 1) {
    throw new TypeError(`Invalid test model key: ${modelKey}`);
  }
  const provider = modelKey.slice(0, separator);
  const id = modelKey.slice(separator + 1);
  const model = {
    id,
    name: id,
    api: "test-api",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const policy = parseAcceptedRunPolicy({
    definition: {
      name: "test-agent",
      description: "Test agent",
      systemPrompt: "Complete the test task.",
    },
    registeredTools: ["read"],
    restrictToRegisteredTools: true,
    tools: ["read"],
    extensions: false,
    skills: false,
    systemPromptMode: "replace",
    includeContextFiles: false,
    parentModelKey: modelKey,
    model,
    parentModel: model,
    scopedModels: [],
    thinkingLevel: null,
    outputTokenLimit: model.maxTokens,
    turnLimit: null,
    graceTurns: 6,
  });
  if (!policy) throw new TypeError(`Invalid accepted policy fixture: ${modelKey}`);
  return policy;
}



/* ================================================================== */
/*  Shared mock factories                                             */
/*  These return factory bodies for vi.mock() calls.                  */
/*  Each test file keeps its own vi.mock("path", factory) line;       */
/*  only the factory BODY is deduplicated here.                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Per-test-overridable mock builders                                */
/*  These accept hoisted fns from the test file so behavior can be    */
/*  controlled per-test. The test file keeps its own vi.hoisted().    */
/* ------------------------------------------------------------------ */

export interface ShellMockFns {
  manager?: any;
  pi?: any;
  sessionCtx?: any;
  delivery?: any;
  coordinator?: any;
}

/**
 * ../src/shell.js mock builder.
 * Accepts partial overrides; defaults to no-op stubs.
 * Pass hoisted fns for per-test behavioral control.
 *
 * Usage:
 *   const { mockAbort } = vi.hoisted(() => ({ mockAbort: vi.fn() }));
 *   vi.mock("../src/shell.js", () => shellMock({
 *     manager: { abort: mockAbort, getRecord: vi.fn(), listAgents: vi.fn() },
 *   }));
 */
export function shellMock(fns: ShellMockFns = {}) {
  const manager = fns.manager ?? {
    // stop() returns boolean ("was it stopped"), not void.
    stop: vi.fn(() => false),
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(() => []),
    execute: vi.fn(),
  };
  const pi = fns.pi ?? { sendMessage: vi.fn(), exec: vi.fn() };
  const sessionCtx = fns.sessionCtx ?? { cwd: "/home/test" };
  const delivery = fns.delivery ?? fns.coordinator ?? { spawn: vi.fn() };

  return {
    getManager: () => manager,
    getDelivery: () => delivery,
    setDelivery: vi.fn(),
    getPiInstance: () => pi,
    getSessionCtx: () => sessionCtx,
  };
}

import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
 * The TypeBox mock always produces { type: "object", properties }, so only
 * the `properties` path is tested — no speculative fallbacks needed.
 */
export function hasParam(schema: any, paramName: string): boolean {
  return paramName in (schema?.properties ?? {});
}

/**
 * Import and invoke the extension factory.
 * Returns the factory function for chaining.
 */
export async function loadExtension(api: any) {
  const factory = (await import("../src/index.js")).default;
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
 * Returns { dir, cleanup } — call cleanup() in afterEach.
 */
export function tempDirWithFiles(
  files: Array<{ name: string; content: string }>,
  prefix = "agent-test",
): { dir: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content);
  }
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
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
    model: {
      id: "model",
      name: "Test model",
      api: "openai-responses",
      provider: "test",
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
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
