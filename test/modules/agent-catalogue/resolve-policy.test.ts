import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ResolveAgentPolicyCommandSchema,
  ResolveAgentPolicyResultSchema,
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
});
