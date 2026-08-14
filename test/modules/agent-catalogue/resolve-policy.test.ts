import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ResolveAgentPolicyCommandSchema,
  ResolveAgentPolicyResultSchema,
  excludeInheritedTools,
  resolveAgentDefinitionPolicy,
} from "../../../src/modules/agent-catalogue/public.js";

describe("REQ-CATALOGUE-001 loading policy public seam", () => {
  it("fills omitted skills and extensions from implicit defaults and copies registered tools", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "resolve-policy",
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
      },
      configuration: {
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: false,
        defaultRegisteredTools: ["read", "bash"],
      },
    }));

    const result = resolveAgentDefinitionPolicy(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ResolveAgentPolicyCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(ResolveAgentPolicyResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: {
        ok: true,
        policy: {
          definition: {
            name: "reviewer",
            description: "Review",
            systemPrompt: "Review the task.",
            source: "project",
          },
          registeredTools: ["read", "bash"],
          restrictToRegisteredTools: false,
          extensions: false,
          skills: true,
        },
      },
      resultValid: true,
    });
  });

  it("omits Agent from registered tools when a definition names it", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "resolve-policy",
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
        registeredTools: ["read", "Agent", "bash"],
      },
      configuration: {
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: false,
        defaultRegisteredTools: ["read", "bash"],
      },
    }));

    const result = resolveAgentDefinitionPolicy(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ResolveAgentPolicyCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(ResolveAgentPolicyResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: {
        ok: true,
        policy: {
          definition: {
            name: "reviewer",
            description: "Review",
            systemPrompt: "Review the task.",
            source: "project",
            registeredTools: ["read", "Agent", "bash"],
          },
          registeredTools: ["read", "bash"],
          restrictToRegisteredTools: true,
          extensions: false,
          skills: true,
        },
      },
      resultValid: true,
    });
  });

  it("omits Agent from an explicit tools allowlist", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "resolve-policy",
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
        tools: ["read", "Agent", "bash"],
      },
      configuration: {
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: false,
        defaultRegisteredTools: ["read", "bash"],
      },
    }));

    const result = resolveAgentDefinitionPolicy(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ResolveAgentPolicyCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(ResolveAgentPolicyResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: {
        ok: true,
        policy: {
          definition: {
            name: "reviewer",
            description: "Review",
            systemPrompt: "Review the task.",
            source: "project",
            tools: ["read", "Agent", "bash"],
          },
          registeredTools: ["read", "bash"],
          restrictToRegisteredTools: false,
          tools: ["read", "bash"],
          extensions: false,
          skills: true,
        },
      },
      resultValid: true,
    });
  });

  it("omits Agent from the host fallback registered-tool list", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "resolve-policy",
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
      },
      configuration: {
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: false,
        defaultRegisteredTools: ["read", "Agent", "bash"],
      },
    }));

    const result = resolveAgentDefinitionPolicy(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ResolveAgentPolicyCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(ResolveAgentPolicyResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: {
        ok: true,
        policy: {
          definition: {
            name: "reviewer",
            description: "Review",
            systemPrompt: "Review the task.",
            source: "project",
          },
          registeredTools: ["read", "bash"],
          restrictToRegisteredTools: false,
          extensions: false,
          skills: true,
        },
      },
      resultValid: true,
    });
  });
});

describe("excludeInheritedTools public seam", () => {
  it("removes Agent and keeps every other tool name", () => {
    expect(excludeInheritedTools(["read", "Agent", "bash"])).toEqual(["read", "bash"]);
  });

  it("returns an empty list when Agent is the only name", () => {
    expect(excludeInheritedTools(["Agent"])).toEqual([]);
  });
});
