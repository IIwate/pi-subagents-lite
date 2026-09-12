import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "./runtime.js";
import { modelKey, scopedModelKeys } from "./models/model-scope.js";
import { buildCurrentAgentGuidance } from "./prompt/agent-guidance.js";

// Note: see .agents/notes/implemented/architecture/2026-09-09-dynamic-guidance-injection.md
export function setupEventListeners(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
  pi.on("session_start", async (_event, ctx) => { await runtime.start(ctx); });
  pi.on("session_shutdown", async () => { await runtime.dispose(); });
  pi.on("before_agent_start", (event, ctx) => {
    if (!runtime.active) return;
    runtime.assertContext(ctx);
    if (!event.systemPromptOptions.selectedTools?.includes("Agent")) return;
    const guidance = buildCurrentAgentGuidance({
      agents: runtime.catalogue.getAvailableTypes().flatMap(name => {
        const config = runtime.catalogue.getAgentConfig(name);
        return config ? [{ name, description: config.description, registeredTools: config.registeredTools, maxTurns: config.maxTurns }] : [];
      }),
      forceBackground: runtime.store.agent.forceBackground,
      parentModelKey: ctx.model ? modelKey(ctx.model) : "", routing: runtime.store.routing,
      availableKeys: new Set(ctx.modelRegistry.getAvailable().map(modelKey)), scopedKeys: scopedModelKeys(ctx.scopedModels),
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });
  pi.on("input", (event, ctx) => {
    if (!runtime.active) return;
    runtime.assertContext(ctx);
    if (event.source !== "interactive" || event.text.trim().startsWith("/") || event.text.trim().startsWith("!")) return;
    if (runtime.navigator?.handleEditorSubmit(event.text, "steer", event.images)) return { action: "handled" as const };
  });
  pi.on("agent_end", () => { runtime.reflow(); });
  pi.on("agent_settled", async () => { await runtime.flushDeliveries(); });
  pi.on("session_tree", async () => { await runtime.flushDeliveries(); });
  pi.on("model_select", (_event, ctx) => { if (runtime.active) { runtime.updateContext(ctx); runtime.navigator?.update(); } });
  pi.on("thinking_level_select", (_event, ctx) => { if (runtime.active) { runtime.updateContext(ctx); runtime.navigator?.update(); } });
}
