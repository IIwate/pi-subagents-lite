import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { AgentConfig } from "./agent-registry.js";
import { configuration, configurationSectionIO } from "./configuration.js";
import { projectAgentsDirPath, userAgentsDirPath } from "../platform/fs/config-paths.js";
import { hostInstallationPaths } from "../platform/pi/host-resources.js";
import {
  AgentCatalogueConfigurationSchema,
  type AgentDefinitionSnapshot,
} from "../modules/agent-catalogue/public.js";
import { concurrencyRuntimeLimits } from "./concurrency.js";
import { createHostSubagentRuntime } from "./subagent-runtime.js";
import { ChildScreenHost } from "./child-screen.js";
import type { ExtensionRuntime } from "./extension-runtime.js";
import { createParentGuidanceRuntime } from "./prompt.js";
import {
  applyDeliveryCommand,
  interactAgent,
  isParentRunSuccessful,
  wireHostDelivery,
} from "./session-host.js";

function toAgentConfig(definition: AgentDefinitionSnapshot): AgentConfig {
  const { source, ...config } = structuredClone(definition);
  return source === "built-in" ? config : { ...config, source };
}

// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the manager, delivery, and navigator exist on the runtime.
 * Idempotent — safe to call on every session_start.
 */
export function ensureManagerAndNavigator(runtime: ExtensionRuntime, ctx: ExtensionContext): void {
  if (!runtime.manager) {
    const manager = createHostSubagentRuntime({
      pi: runtime.pi,
      ctx,
      limits: concurrencyRuntimeLimits(),
    });
    runtime.manager = manager;
    wireHostDelivery(runtime, manager);
  } else {
    // Reload path: the document may have changed on disk while the manager
    // kept running, so republish the persisted limits into the scheduler.
    runtime.manager.replaceLimits(concurrencyRuntimeLimits());
  }

  if (!runtime.navigator) {
    runtime.navigator = new ChildScreenHost(
      runtime.manager,
      async (agentId, text) => interactAgent(runtime, agentId, text),
      () => runtime.delivery?.pendingResultCount(),
      runtime.agentSettings.read().expandListByDefault,
      (type) => runtime.agents.resolvedConfig(type).displayName,
    );
    // Stats visibility follows the persisted display settings.
    runtime.agentSettings.syncNavigatorStats();
  }
  runtime.manager.setOnRemove(() => runtime.navigator?.update());
}

/**
 * Scan agent files from user and project directories, merge with defaults,
 * and register into the type registry.
 */
async function scanAndRegisterAgents(runtime: ExtensionRuntime, ctx: ExtensionContext): Promise<void> {
  const userAgentDir = userAgentsDirPath(hostInstallationPaths.agentDirectory);
  const projectAgentDir = projectAgentsDirPath(ctx.cwd, hostInstallationPaths.projectConfigDirectoryName);

  const configurationResult = configuration.execute({
    kind: "read-value",
    path: ["agent", "disableDefaultAgents"],
  });
  if (!configurationResult.ok) throw new Error(configurationResult.error.message);
  const catalogueConfiguration = "found" in configurationResult && configurationResult.found
    ? { disableDefaultAgents: configurationResult.value }
    : {};
  if (!Check(AgentCatalogueConfigurationSchema, catalogueConfiguration)) {
    throw new TypeError("Agent catalogue configuration is invalid.");
  }
  const disableDefaults = catalogueConfiguration.disableDefaultAgents === true;
  runtime.agents.setScanRoots(userAgentDir, projectAgentDir, disableDefaults);
  const result = await runtime.catalogue.execute({
    kind: "discover",
    roots: { globalDirectory: userAgentDir, projectDirectory: projectAgentDir },
    configuration: catalogueConfiguration,
  });
  if (!result.ok) throw new Error(result.error.message);
  runtime.agents.register(new Map(
    result.catalogue.definitions.map((definition) => [definition.name, toAgentConfig(definition)]),
  ), { disableDefaultAgents: true });
}

async function loadConfigAndRegisterAgents(runtime: ExtensionRuntime, ctx: ExtensionContext): Promise<void> {
  // Re-read the persisted document (it may have changed on disk between
  // sessions), then re-sync every consumer that mirrors it.
  configurationSectionIO.reload();
  ensureManagerAndNavigator(runtime, ctx);
  runtime.agentSettings.syncNavigatorStats();
  await scanAndRegisterAgents(runtime, ctx);
}

// ============================================================================
// Event listener setup
// ============================================================================

/** Register all pi.on() event listeners as closures over one runtime. */
export function setupEventListeners(runtime: ExtensionRuntime): void {
  const { pi } = runtime;
  const parentGuidance = createParentGuidanceRuntime(runtime.agents);

  pi.on("before_agent_start", (event, ctx) => {
    // Pi discards an entire handler result when guidance throws. Committing
    // preflight first would later acknowledge a message the parent never saw;
    // prepare every fallible, side-effect-free part before changing delivery.
    let guidance: string | undefined;
    if (event.systemPromptOptions.selectedTools?.includes("Agent")) {
      const assembled = parentGuidance.assembleFromSession(ctx);
      if (!assembled.ok) throw new TypeError(assembled.error.message);
      guidance = assembled.guidance;
    }
    const { manager, delivery } = runtime;
    const prepared = manager && delivery
      ? applyDeliveryCommand(manager, delivery, { kind: "parent-preflight" })
      : undefined;
    const resultMessage = prepared?.ok ? prepared.injection : undefined;
    if (guidance === undefined) {
      return resultMessage ? { message: resultMessage } : undefined;
    }
    return {
      message: resultMessage,
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
    };
  });

  pi.on("input", async (event, _ctx) => {
    if (event.source !== "interactive") return;
    const selectedAgentId = runtime.navigator?.selectedId();
    const text = event.text.trim();
    if (
      !selectedAgentId
      || text.startsWith("/")
      || text.startsWith("!")
    ) return;

    const navigator = runtime.navigator;
    const requestId = navigator?.beginInteraction(selectedAgentId) ?? -1;
    const result = await interactAgent(runtime, selectedAgentId, event.text, event.images);
    navigator?.completeInteraction(requestId, selectedAgentId, event.text, result);
    return { action: "handled" as const };
  });

  pi.on("agent_start", () => {
    const { manager, delivery } = runtime;
    if (manager && delivery) applyDeliveryCommand(manager, delivery, { kind: "parent-start" });
  });

  // Main session run ended — Working row is gone; force reflow so Pi's
  // differential render does not leave blank gaps above the agent list.
  // setTimeout(0) lets Pi remove the Working row before relayout on the next event-loop turn.
  pi.on("agent_end", (event, ctx) => {
    const { manager, delivery } = runtime;
    if (manager && delivery) {
      applyDeliveryCommand(manager, delivery, {
        kind: "parent-end",
        succeeded: isParentRunSuccessful(event.messages),
      });
    }
    if (!ctx.hasUI) return;
    setTimeout(() => runtime.navigator?.forceLayoutReflow(), 0);
  });

  pi.on("agent_settled", () => {
    const { manager, delivery } = runtime;
    if (manager && delivery) applyDeliveryCommand(manager, delivery, { kind: "parent-settled" });
    runtime.navigator?.update();
  });

  pi.on("session_tree", () => {
    const { manager, delivery } = runtime;
    if (manager && delivery) applyDeliveryCommand(manager, delivery, { kind: "session-tree" });
    runtime.navigator?.update();
  });

  // session_start — load config and refresh the Agent catalogue used by guidance.
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    runtime.sessionCtx = ctx;
    await loadConfigAndRegisterAgents(runtime, ctx);
    if (ctx.mode === "tui") {
      runtime.navigator?.setUICtx(ctx.ui);
    }
    const { manager, delivery } = runtime;
    if (manager && delivery) applyDeliveryCommand(manager, delivery, { kind: "restore" });
    runtime.navigator?.update();
  });

  // session_shutdown — abort all, dispose manager
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };

    await cleanup(() => {
      const manager = runtime.manager;
      if (!manager) return;
      const records = manager.listSnapshots();
      const active = records.filter(r => r.status === "running" || r.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    });

    // Cleanup must reach the child sessions even when a stale host UI component throws.
    // Rethrow the first failure afterwards so Pi still records the shutdown fault.
    await cleanup(() => {
      try { runtime.navigator?.dispose(); } finally { runtime.navigator = null; }
    });
    // Let the manager abort and settle its runs while delivery can still
    // receive legitimate completion callbacks. Delivery is disposed
    // afterwards so its durable fallback handoff is not cut off first.
    await cleanup(async () => {
      try { await runtime.manager?.dispose(); } finally { runtime.manager = null; }
    });
    await cleanup(() => {
      try { runtime.delivery?.execute({ kind: "dispose" }); } finally { runtime.delivery = null; }
    });

    if (failures.length > 0) throw failures[0];
  });
}
