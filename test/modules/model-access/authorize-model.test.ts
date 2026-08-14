import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AuthorizeModelCommandSchema,
  AuthorizeModelResultSchema,
  authorizeModelAccess,
} from "../../../src/modules/model-access/public.js";

describe("REQ-MODEL-001 Parent and alternate authorization public seam", () => {
  it("allows the exact parent when Parent model access is omitted", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "authorize",
      agentType: "Explore",
      modelKey: "anthropic/sonnet",
      parentModelKey: "anthropic/sonnet",
      routing: {
        enabled: false,
        enabledProviders: [],
        agentAccess: { Explore: { providers: {} } },
      },
      availableKeys: [],
      scopedKeys: ["openai/gpt-5"],
    }));

    const result = authorizeModelAccess(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(AuthorizeModelCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(AuthorizeModelResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: { ok: true },
      resultValid: true,
    });
  });
});

describe("REQ-MODEL-002 alternate model authorization public seam", () => {
  it("rejects an alternate model when routing is off instead of substituting another model", () => {
    const command = JSON.parse(JSON.stringify({
      kind: "authorize",
      agentType: "Explore",
      modelKey: "openai/gpt-5",
      parentModelKey: "anthropic/sonnet",
      routing: {
        enabled: false,
        enabledProviders: ["openai"],
        agentAccess: { Explore: { providers: { openai: {} } } },
      },
      availableKeys: ["anthropic/sonnet", "openai/gpt-5"],
      scopedKeys: ["anthropic/sonnet", "openai/gpt-5"],
    }));

    const result = authorizeModelAccess(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(AuthorizeModelCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(AuthorizeModelResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: { ok: false, reason: "routing-disabled" },
      resultValid: true,
    });
  });
});
