import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.js";
import type { SubagentsConfig } from "../../src/config/types.js";
import { AgentCatalogue } from "../../src/agents/agent-types.js";

export function createDefaultConfig(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
  return {
    modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
    agent: { forceBackground: false },
    concurrency: { default: 4 },
    ...structuredClone(overrides),
  };
}

export function createMemoryConfigIO(initial: SubagentsConfig = createDefaultConfig()) {
  let persisted = structuredClone(initial);
  const saves: SubagentsConfig[] = [];
  const io: ConfigIO = {
    load: () => structuredClone(persisted),
    save: config => {
      persisted = structuredClone(config);
      saves.push(structuredClone(config));
    },
  };
  return { io, saves, current: () => structuredClone(persisted) };
}

export type MemoryConfigIO = ReturnType<typeof createMemoryConfigIO>;

export function createTestHarness(options: { initialConfig?: SubagentsConfig; sessionId?: string } = {}) {
  const catalogue = new AgentCatalogue();
  const sessionId = options.sessionId ?? randomUUID();
  const memIO = createMemoryConfigIO(options.initialConfig);
  const store = new ConfigStore(memIO.io);
  const disposables: Array<() => void | Promise<void>> = [];
  const directories: string[] = [];
  let disposal: Promise<void> | undefined;

  return {
    sessionId,
    catalogue,
    memIO,
    store,
    onDispose(action: () => void | Promise<void>): void {
      if (disposal) throw new Error("Cannot register cleanup after disposal");
      disposables.push(action);
    },
    createTempDir(prefix = "pi-test-"): string {
      if (disposal) throw new Error("Cannot create resources after disposal");
      const directory = mkdtempSync(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        const errors: unknown[] = [];
        const cleanup = async (action: () => void | Promise<void>) => {
          try { await action(); } catch (error) { errors.push(error); }
        };
        while (disposables.length > 0) await cleanup(disposables.pop()!);
        await cleanup(() => store.dispose());
        await cleanup(() => { vi.restoreAllMocks(); });
        await cleanup(() => { vi.unstubAllEnvs(); });
        await cleanup(() => { vi.unstubAllGlobals(); });
        await cleanup(() => { vi.useRealTimers(); });
        for (const directory of directories) {
          await cleanup(() => rmSync(directory, { recursive: true, force: true }));
        }
        if (errors.length > 0) throw new AggregateError(errors, "Test cleanup failed");
      })();
      return disposal;
    },
  };
}

export type TestHarness = ReturnType<typeof createTestHarness>;
