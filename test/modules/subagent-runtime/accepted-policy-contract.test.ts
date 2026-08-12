import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AcceptedRunPolicySchema,
} from "../../../src/modules/subagent-runtime/public.js";

describe("accepted Agent call contract", () => {
  it("validates an independent accepted run policy snapshot", () => {
    const policy = JSON.parse(JSON.stringify({
      definition: {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review the task.",
        source: "project",
      },
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: false,
      skills: false,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "test/model",
    }));

    expect(Check(AcceptedRunPolicySchema, policy)).toBe(true);
  });
});
