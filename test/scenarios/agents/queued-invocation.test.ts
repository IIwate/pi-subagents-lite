import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";
import { createPiAgentScenario, type PiAgentScenario } from "../../support/pi-agent-scenario.js";
import { registerAgents, setDefaultAgentsDisabled } from "../../../src/agents/agent-types.js";
import type { AgentConfig } from "../../../src/agents/types.js";

function params(description: string, model?: string, background = true, agent = "general-purpose") {
  return {
    agent,
    prompt: description,
    description,
    run_in_background: background,
    ...(model ? { model } : {}),
  };
}

describe("queued invocation snapshots", () => {
  let scenario: PiAgentScenario;

  beforeEach(async () => { scenario = await createPiAgentScenario(); });
  afterEach(async () => { await scenario.dispose(); });

  it("keeps queued model, scope, and thinking after policy and session edits", async () => {
    await executeAgentTool("first", params("first", "other/worker-model"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second", "other/worker-model"), undefined, undefined, scenario.ctx);

    const second = scenario.manager.listAgents().find((record: any) => record.display.description === "second")!;
    expect(second.lifecycle.status).toBe("queued");

    scenario.store.mutate.routing.clearAll();
    scenario.ctx.model = { provider: "parent", id: "next-model" };
    scenario.ctx.scopedModels = [{ model: scenario.ctx.model, thinkingLevel: "low" }];
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    expect(scenario.createAgentSession).toHaveBeenCalledTimes(2);
    const queuedOptions = scenario.createAgentSession.mock.calls[1][0]!;
    expect(queuedOptions.model).toMatchObject({ provider: "other", id: "worker-model", reasoning: true });
    expect(queuedOptions.scopedModels).toMatchObject([
      { model: { provider: "parent", id: "main-model", reasoning: true } },
      { model: { provider: "other", id: "worker-model", reasoning: true }, thinkingLevel: "high" },
    ]);
    expect(queuedOptions.thinkingLevel).toBe("high");
    expect(second.lifecycle.status, second.error).toBe("completed");

    await expect(executeAgentTool("future", params("future", "other/worker-model"), undefined, undefined, scenario.ctx))
      .rejects.toThrow("Model routing is OFF");
    expect(scenario.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("keeps a queued Explore read-only after default agents are disabled", async () => {
    scenario.store.mutate.routing.clearAll();
    await executeAgentTool("first", params("blocker"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("queued Explore", undefined, true, "Explore"), undefined, undefined, scenario.ctx);

    const queued = scenario.manager.listAgents().find((record: any) => record.display.description === "queued Explore")!;
    expect(queued.lifecycle.status).toBe("queued");

    setDefaultAgentsDisabled(true);
    scenario.store.mutate.agent.setLoadSkillsImplicitly(false);
    scenario.store.mutate.agent.setLoadExtensionsImplicitly(false);
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    const queuedOptions = scenario.createAgentSession.mock.calls[1][0]!;
    const queuedLoader = scenario.loaderOptions[1];
    const queuedSession = scenario.sessions[1];
    const expectedReadOnlyTools = process.platform === "win32"
      ? ["read", "bash", "powershell", "grep", "find"]
      : ["read", "bash", "grep", "find"];
    expect(queuedOptions.tools).toEqual(expectedReadOnlyTools);
    expect(queuedSession.getActiveToolNames()).toEqual(expectedReadOnlyTools);
    expect(queuedSession.getActiveToolNames()).not.toEqual(expect.arrayContaining(["edit", "write"]));
    expect(queuedLoader.noExtensions).toBe(false);
    expect(queuedLoader.noSkills).toBe(false);
    expect(queuedLoader.systemPromptOverride!(undefined)).toContain("CRITICAL: READ-ONLY MODE");
    expect(queued.display.type).toBe("Explore");
    expect(queued.lifecycle.status, queued.error).toBe("completed");
    expect(scenario.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("fallback"), expect.anything());

    const future = executeAgentTool(
      "future",
      params("future Explore", undefined, true, "Explore"),
      undefined,
      undefined,
      scenario.ctx,
    );
    await expect(future).rejects.toThrow("Unknown agent type: Explore");
    expect(scenario.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("deep-copies a queued custom policy while future calls use its replacement", async () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom agent",
      systemPrompt: "Original accepted prompt.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: ["original-extension"],
      skills: ["original-skill"],
      preloadSkills: ["original-preload"],
    };
    registerAgents(new Map([[config.name, config]]));
    scenario.store.mutate.routing.clearAll();

    await executeAgentTool("first", params("blocker"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("queued custom", undefined, true, "custom"), undefined, undefined, scenario.ctx);

    (config.registeredTools as string[]).push("write");
    (config.tools as string[]).push("write");
    (config.extensions as string[]).push("mutated-extension");
    (config.skills as string[]).push("mutated-skill");
    (config.preloadSkills as string[]).push("mutated-preload");
    config.systemPrompt = "Mutated prompt.";

    const replacement: AgentConfig = {
      name: "custom",
      description: "Replacement agent",
      systemPrompt: "Replacement prompt.",
      registeredTools: ["write"],
      tools: ["write"],
      extensions: ["replacement-extension"],
      skills: ["replacement-skill"],
      preloadSkills: ["replacement-preload"],
    };
    registerAgents(new Map([[replacement.name, replacement]]));
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    const queuedOptions = scenario.createAgentSession.mock.calls[1][0]!;
    const queuedLoader = scenario.loaderOptions[1];
    expect(queuedOptions.tools).toEqual(["read"]);
    expect(scenario.sessions[1].getActiveToolNames()).toEqual(["read"]);
    expect(queuedLoader.systemPromptOverride!(undefined)).toContain("Original accepted prompt.");
    expect(queuedLoader.systemPromptOverride!(undefined)).not.toContain("Mutated prompt.");
    expect(scenario.preloadCalls[0]).toEqual(["original-preload"]);
    expect(scenario.skillMetaCalls[0]).toEqual(["original-skill"]);
    const filtered = queuedLoader.extensionsOverride!({
      extensions: [
        { path: "/tmp/extensions/original-extension/index.ts" },
        { path: "/tmp/extensions/mutated-extension/index.ts" },
      ],
    } as Parameters<NonNullable<typeof queuedLoader.extensionsOverride>>[0]);
    expect(filtered.extensions.map((extension: any) => extension.path)).toEqual([
      "/tmp/extensions/original-extension/index.ts",
    ]);

    await executeAgentTool("future", params("future custom", undefined, true, "custom"), undefined, undefined, scenario.ctx);
    const future = scenario.manager.listAgents().find((record: any) => record.display.description === "future custom")!;
    await future.execution.promise;

    expect(scenario.createAgentSession.mock.calls[2][0]!.tools).toEqual(["write"]);
    expect(scenario.sessions[2].getActiveToolNames()).toEqual(["write"]);
    expect(scenario.loaderOptions[2].systemPromptOverride!(undefined)).toContain("Replacement prompt.");
    expect(scenario.preloadCalls[1]).toEqual(["replacement-preload"]);
    expect(scenario.skillMetaCalls[1]).toEqual(["replacement-skill"]);
  });

  it.each([
    { source: "inherited", thinking: undefined, expected: "high" },
    { source: "explicit", thinking: "low", expected: "low" },
  ])("keeps $source thinking when the parent changes before dequeue", async ({ thinking, expected }) => {
    scenario.ctx.scopedModels = [];
    scenario.ctx.thinkingLevel = "high";
    await executeAgentTool("first", params("blocker", "other/worker-model"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool(
      "second",
      { ...params("queued", "other/worker-model"), thinking },
      undefined,
      undefined,
      scenario.ctx,
    );

    const queued = scenario.manager.listAgents().find((record: any) => record.display.description === "queued")!;
    expect(queued.lifecycle.status).toBe("queued");
    expect(queued.display.invocation!.thinkingLevel).toBe(expected);

    scenario.ctx.thinkingLevel = "off";
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    expect(scenario.createAgentSession.mock.calls[1][0]!.thinkingLevel).toBe(expected);
    expect(queued.display.invocation!.thinkingLevel).toBe(expected);
    expect(queued.lifecycle.status, queued.error).toBe("completed");
  });

  it("keeps a clamped undefined snapshot after parent and default changes", async () => {
    scenario.store.mutate.routing.clearAll();
    scenario.ctx.model.reasoning = false;
    scenario.ctx.thinkingLevel = "high";
    await executeAgentTool("first", params("first"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, scenario.ctx);

    const queued = scenario.manager.listAgents().find((record: any) => record.display.description === "second")!;
    expect(queued.lifecycle.status).toBe("queued");
    expect(queued.display.invocation!.thinkingLevel).toBeUndefined();

    scenario.ctx.thinkingLevel = "low";
    scenario.ctx.model.reasoning = true;
    scenario.store.mutate.agent.setDefaultThinking("xhigh");
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    expect(scenario.createAgentSession.mock.calls[1][0]!.thinkingLevel).toBeUndefined();
    expect(queued.execution.session!.thinkingLevel).toBe("off");
    expect(queued.display.invocation!.thinkingLevel).toBeUndefined();
    expect(queued.lifecycle.status, queued.error).toBe("completed");
  });

  it("keeps the enqueue-time parent model when model is omitted", async () => {
    scenario.store.mutate.routing.clearAll();
    await executeAgentTool("first", params("first"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, scenario.ctx);

    scenario.ctx.model = { provider: "parent", id: "next-model" };
    scenario.releaseFirst();
    await Promise.all(scenario.manager.listAgents().map((record: any) => record.execution.promise));

    expect(scenario.createAgentSession.mock.calls[1][0]!.model).toMatchObject({ provider: "parent", id: "main-model", reasoning: true });
  });

  it("waits for a queued foreground Agent until it settles", async () => {
    scenario.store.mutate.routing.clearAll();
    await executeAgentTool("first", params("first"), undefined, undefined, scenario.ctx);
    await vi.waitFor(() => expect(scenario.createAgentSession).toHaveBeenCalledTimes(1));

    let settled = false;
    const foreground = executeAgentTool("second", params("second", undefined, false), undefined, undefined, scenario.ctx)
      .then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(
      scenario.manager.listAgents().some((record: any) => record.display.description === "second" && record.lifecycle.status === "queued"),
    ).toBe(true));
    expect(settled).toBe(false);

    scenario.releaseFirst();
    await foreground;
    expect(settled).toBe(true);
    expect(scenario.createAgentSession).toHaveBeenCalledTimes(2);
  });
});
