import { describe, expect, it } from "vitest";
import { projectPiAcceptedRunPolicyInput } from "../../src/bootstrap/project-pi-accepted-run-policy.js";
import { parseAcceptedRunPolicy } from "../../src/modules/subagent-runtime/public.js";

describe("projectPiAcceptedRunPolicyInput", () => {
  it("projects a Pi 0.84.1 runtime model snapshot into a contract object", () => {
    // Literals taken from installed @earendil-works/pi-ai 0.84.1 deepseek.json,
    // pi-coding-agent provider-composer modelFromJson, and model-resolver
    // scopedModels.push({ model, thinkingLevel }) when the pattern has no :level.
    const deepseekFlash = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      provider: "deepseek",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
    };
    const modelsJsonModel = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      api: "openai-responses",
      provider: "CloseAI",
      baseUrl: "http://127.0.0.1:8317/v1",
      reasoning: true,
      thinkingLevelMap: { high: "high", xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 372_000,
      maxTokens: 128_000,
      samplingParams: undefined,
      headers: undefined,
      compat: undefined,
      source: "models_json",
    };
    const cliproxyLuna = {
      id: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      api: "cliproxyapi-codex-responses",
      provider: "cliproxyapi",
      baseUrl: "http://127.0.0.1:8317/backend-api/",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 372_000,
      maxTokens: 16_384,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
        ultra: "ultra",
      },
    };
    const policy = {
      definition: {
        name: "Explore",
        displayName: "Explore",
        description: "Fast codebase exploration agent (read-only)",
        registeredTools: ["read", "bash", "grep", "find"],
        systemPrompt: "Search only.",
      },
      registeredTools: ["read", "bash", "grep", "find"],
      restrictToRegisteredTools: true,
      extensions: true,
      skills: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "deepseek/deepseek-v4-flash",
      model: { ...deepseekFlash },
      parentModel: { ...deepseekFlash },
      scopedModels: [
        { model: modelsJsonModel, thinkingLevel: undefined },
        { model: cliproxyLuna, thinkingLevel: "max" },
        { model: deepseekFlash, thinkingLevel: "max" },
      ],
      thinkingLevel: "max",
      outputTokenLimit: 384_000,
      turnLimit: null,
      graceTurns: 6,
    };

    const accepted = parseAcceptedRunPolicy(projectPiAcceptedRunPolicyInput(policy));
    expect(accepted).toEqual({
      ...policy,
      model: deepseekFlash,
      parentModel: deepseekFlash,
      scopedModels: [
        {
          model: {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            api: "openai-responses",
            provider: "CloseAI",
            baseUrl: "http://127.0.0.1:8317/v1",
            reasoning: true,
            thinkingLevelMap: { high: "high", xhigh: "xhigh", max: "max" },
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 372_000,
            maxTokens: 128_000,
          },
        },
        { model: cliproxyLuna, thinkingLevel: "max" },
        { model: deepseekFlash, thinkingLevel: "max" },
      ],
    });
    expect(accepted?.model).not.toHaveProperty("source");
  });

  it("leaves a top-level extra key in place so parse can still fail closed", () => {
    const projected = projectPiAcceptedRunPolicyInput({
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
      },
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: false,
      skills: false,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "",
      model: {
        id: "worker-model",
        name: "Worker model",
        api: "openai-responses",
        provider: "test",
        baseUrl: "https://example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
        source: "models_json",
      },
      parentModel: null,
      scopedModels: [],
      thinkingLevel: null,
      outputTokenLimit: 8_192,
      turnLimit: null,
      graceTurns: 6,
      unexpected: true,
    });

    expect(projected).toMatchObject({ unexpected: true });
    expect((projected as { model: { source?: string } }).model).not.toHaveProperty("source");
    expect(parseAcceptedRunPolicy(projected)).toBeUndefined();
  });
});
