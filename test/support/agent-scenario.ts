import { vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import * as shell from "../../src/shell.js";
import { createTestHarness } from "./harness.js";
import { fakeCtx } from "./fixtures.js";

// Note: see .agents/notes/implemented/testing/2026-09-09-test-layers-and-scenario-harness.md
export function createAgentScenario(options: Parameters<typeof createTestHarness>[0] = {}) {
  const harness = createTestHarness(options);
  const directory = harness.createTempDir();
  const parent = SessionManager.create(directory, directory);
  parent.appendMessage({ role: "user", content: "Start the task", timestamp: Date.now() });
  const originId = parent.appendMessage(fauxAssistantMessage("Ready"));
  const ctx = {
    ...fakeCtx(), cwd: directory, sessionManager: parent, isIdle: () => true,
    ui: { notify: vi.fn() },
  };
  const pi = {
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    appendEntry: vi.fn((type: string, data: unknown) => { parent.appendCustomEntry(type, data); }),
    sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
  };
  const api = pi as typeof pi & ExtensionAPI;
  vi.spyOn(shell, "getStore").mockReturnValue(harness.store);
  shell.setSessionCtx(ctx);
  shell.setPiInstance(api);
  const manager = new AgentManager(undefined, harness.store.concurrency);
  shell.setManager(manager);
  const coordinator = new SpawnCoordinator(manager);
  manager.setOnComplete(record => coordinator.onAgentComplete(record));
  shell.setCoordinator(coordinator);

  // Keep the shell installed until completion callbacks and disk reconciliation settle.
  harness.onDispose(() => {
    shell.takeFallbackResults(parent.getSessionId());
    shell.setNavigator(null);
    shell.setCoordinator(null);
    shell.setManager(null);
    shell.setSessionCtx(null!);
    shell.setPiInstance(null!);
  });
  harness.onDispose(() => coordinator.dispose());
  harness.onDispose(() => coordinator.reconcileDeliveryState().then(() => {}));
  harness.onDispose(() => manager.dispose());

  let persistedMessages = 0;
  return {
    ...harness, directory, parent, originId, ctx, pi: api, manager, coordinator,
    // Sending queues a message; a receipt exists only after Pi appends it to the log.
    persistMessages(): void {
      for (const [message] of pi.sendMessage.mock.calls.slice(persistedMessages)) {
        parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        persistedMessages++;
      }
    },
  };
}

export type AgentScenario = ReturnType<typeof createAgentScenario>;
