import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  applyParentModelAccess,
} from "../../../src/modules/model-access/public.js";

describe("REQ-MODEL-001 Parent access fragment update", () => {
  it("writes an explicit denial and prunes a restored default grant", () => {
    const denied = applyParentModelAccess({
      enabled: false,
      enabledProviders: [],
      agentAccess: {},
    }, "Explore", false);
    const restored = applyParentModelAccess(denied, "Explore", true);

    expect({
      deniedValid: Check(ModelAccessFragmentSchema, denied),
      restoredValid: Check(ModelAccessFragmentSchema, restored),
      denied,
      restored,
    }).toEqual({
      deniedValid: true,
      restoredValid: true,
      denied: {
        enabled: false,
        enabledProviders: [],
        agentAccess: { Explore: { parentModelAccess: false, providers: {} } },
      },
      restored: {
        enabled: false,
        enabledProviders: [],
        agentAccess: {},
      },
    });
  });
});
