import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AcceptedRunPolicySchema,
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
  });
});
