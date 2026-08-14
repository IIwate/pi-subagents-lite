import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AcceptedRunPolicySchema,
  describeAcceptedRunPolicyFailure,
  parseAcceptedRunPolicy,
} from "../../../src/modules/subagent-runtime/public.js";

const modelSnapshot = {
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
};

describe("accepted Agent call contract", () => {
  it("validates an independent accepted run policy snapshot", () => {
    const policy = JSON.parse(JSON.stringify({
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
        maxTurns: 25,
      },
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: false,
      skills: false,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "test/model",
      model: modelSnapshot,
      parentModel: { ...modelSnapshot, id: "model", name: "Parent model", maxTokens: 16_384 },
      scopedModels: [{ model: modelSnapshot, thinkingLevel: "high" }],
      thinkingLevel: "high",
      outputTokenLimit: 8_192,
      turnLimit: 25,
      graceTurns: 6,
    }));

    expect(Check(AcceptedRunPolicySchema, policy)).toBe(true);
    expect(parseAcceptedRunPolicy(policy)).toEqual(policy);
  });

  it("rejects non-serializable values instead of certifying their JSON projection", () => {
    const policy = {
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: { toJSON: () => "Review the task." },
        maxTurns: 25,
      },
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: false,
      skills: false,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "",
      model: modelSnapshot,
      parentModel: null,
      scopedModels: [],
      thinkingLevel: null,
      outputTokenLimit: 8_192,
      turnLimit: 25,
      graceTurns: 6,
    };

    expect(Check(AcceptedRunPolicySchema, policy)).toBe(false);
    expect(parseAcceptedRunPolicy(policy)).toBeUndefined();
    expect(describeAcceptedRunPolicyFailure(policy)).toContain("definition.systemPrompt");

    const withFunction = {
      ...policy,
      definition: { ...policy.definition, systemPrompt: "Review", extra: () => true },
    };
    expect(parseAcceptedRunPolicy(withFunction)).toBeUndefined();

    const withHiddenSerializer = {
      ...withFunction,
      definition: { ...withFunction.definition },
    };
    delete (withHiddenSerializer.definition as Record<string, unknown>).extra;
    Object.defineProperty(withHiddenSerializer.definition, "toJSON", {
      value: () => ({ name: "reviewer", description: "Review", systemPrompt: "Changed" }),
    });
    expect(parseAcceptedRunPolicy(withHiddenSerializer)).toBeUndefined();
  });

  it("rejects snapshots whose derived limits contradict their accepted inputs", () => {
    const policy = {
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        maxTurns: 25,
      },
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: false,
      skills: false,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "",
      model: modelSnapshot,
      parentModel: null,
      scopedModels: [],
      thinkingLevel: null,
      outputTokenLimit: modelSnapshot.maxTokens,
      turnLimit: 25,
      graceTurns: 6,
    };

    expect(parseAcceptedRunPolicy({ ...policy, outputTokenLimit: 4_096 })).toBeUndefined();
    expect(parseAcceptedRunPolicy({ ...policy, turnLimit: 24 })).toBeUndefined();
    expect(parseAcceptedRunPolicy({ ...policy, parentModelKey: "other/model" })).toBeUndefined();
    expect(describeAcceptedRunPolicyFailure({ ...policy, outputTokenLimit: 4_096 }))
      .toContain("outputTokenLimit 4096 does not match model.maxTokens 8192");
    expect(describeAcceptedRunPolicyFailure({ ...policy, parentModelKey: "other/model" }))
      .toContain("parentModelKey \"other/model\" does not match \"\"");
  });

  it("accepts a Pi 0.84.1 runtime model snapshot and drops host-only leftovers", () => {
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

    const accepted = parseAcceptedRunPolicy(policy);
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
  });

  it("still rejects a policy that remains illegal after host leftovers are dropped", () => {
    const policy = {
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
      model: modelSnapshot,
      parentModel: null,
      scopedModels: [],
      thinkingLevel: null,
      outputTokenLimit: modelSnapshot.maxTokens,
      turnLimit: null,
      graceTurns: 6,
      unexpected: true,
    };

    expect(parseAcceptedRunPolicy(policy)).toBeUndefined();
    expect(describeAcceptedRunPolicyFailure(policy)).toContain("unexpected");
  });
});
