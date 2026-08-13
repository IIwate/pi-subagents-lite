import { describe, expect, it } from "vitest";
import { parseModelAccessFragment } from "../../../src/modules/model-access/public.js";

// Normalization coverage moved from the retired config-io suite: the fragment
// parser is the receiving-end validator for the persisted modelRouting block.
describe("REQ-MODEL-003 model access fragment normalization", () => {
  it("returns fresh routing defaults for missing and malformed blocks", () => {
    for (const value of [undefined, null, [], "on"]) {
      expect(parseModelAccessFragment(value)).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
    }
    const first = parseModelAccessFragment(undefined);
    first.enabledProviders.push("openai");
    first.agentAccess.Explore = { providers: { openai: {} } };
    expect(parseModelAccessFragment(undefined)).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });

  it("only accepts true for enabled", () => {
    expect(parseModelAccessFragment({ enabled: true }).enabled).toBe(true);
    for (const enabled of [false, "true", 1, null]) {
      expect(parseModelAccessFragment({ enabled }).enabled).toBe(false);
    }
  });

  it("normalizes enabled provider IDs", () => {
    expect(
      parseModelAccessFragment({ enabledProviders: [" openai ", "", 4, "openai", "google"] }).enabledProviders,
    ).toEqual(["openai", "google"]);
    expect(parseModelAccessFragment({ enabledProviders: "openai" }).enabledProviders).toEqual([]);
  });

  it("normalizes all-model and exact-model access rules", () => {
    expect(parseModelAccessFragment({
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        " Explore ": {
          providers: {
            " openai ": {},
            google: { models: [" gemini-pro ", "", "gemini-pro", "gemini-flash", 4] },
          },
        },
      },
    })).toEqual({
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        Explore: {
          providers: {
            openai: {},
            google: { models: ["gemini-pro", "gemini-flash"] },
          },
        },
      },
    });
  });

  it("drops empty, malformed, and invalid exact rules instead of widening them", () => {
    expect(parseModelAccessFragment({
      agentAccess: {
        empty: { providers: { openai: { models: [] } } },
        blanks: { providers: { openai: { models: [" "] } } },
        badModels: { providers: { openai: { models: "gpt" } } },
        misspelledModels: { providers: { openai: { model: ["gpt-5"] } } },
        badProvider: { providers: { openai: null } },
        badProviders: { providers: [] },
        " ": { providers: { openai: {} } },
      },
    }).agentAccess).toEqual({});
  });

  it("preserves prototype-like IDs only as explicit own rules", () => {
    const access = parseModelAccessFragment({
      agentAccess: JSON.parse('{"constructor":{"providers":{"__proto__":{"models":["worker"]}}}}'),
    }).agentAccess;
    expect(Object.hasOwn(access, "constructor")).toBe(true);
    expect(Object.hasOwn(access.constructor!.providers, "__proto__")).toBe(true);
    expect(access.constructor!.providers.__proto__).toEqual({ models: ["worker"] });
  });

  it("keeps dormant rules for providers outside enabledProviders", () => {
    expect(parseModelAccessFragment({
      enabled: false,
      enabledProviders: [],
      agentAccess: { Explore: { providers: { openai: { models: ["gpt-5"] } } } },
    }).agentAccess.Explore!.providers.openai).toEqual({ models: ["gpt-5"] });
  });

  it("normalizes Parent model access and exact-model thinking overrides", () => {
    expect(parseModelAccessFragment({
      agentAccess: {
        Explore: {
          parentModelAccess: false,
          providers: {},
          thinking: {
            " openai/gpt-5 ": {
              allowed: [" high ", "low", "high"],
              default: "low",
            },
          },
        },
      },
    }).agentAccess).toEqual({
      Explore: {
        parentModelAccess: false,
        providers: {},
        thinking: {
          "openai/gpt-5": { allowed: ["high", "low"], default: "low" },
        },
      },
    });
  });

  it("drops malformed thinking overrides without deleting other Agent access", () => {
    expect(parseModelAccessFragment({
      agentAccess: {
        Explore: {
          parentModelAccess: false,
          providers: { openai: {} },
          thinking: {
            bare: { allowed: ["low"], default: "low" },
            "openai/empty": { allowed: [], default: "low" },
            "openai/unknown": { allowed: ["provider-custom"], default: "provider-custom" },
            "openai/missing-default": { allowed: ["low"], default: "high" },
            "openai/malformed": null,
          },
        },
      },
    }).agentAccess).toEqual({
      Explore: {
        parentModelAccess: false,
        providers: { openai: {} },
      },
    });
  });

  it("ignores assignment-era routing fields without migration", () => {
    expect(parseModelAccessFragment({
      enabled: true,
      allowedProviders: ["openai"],
      agentModels: { Explore: "openai/gpt-5" },
    })).toEqual({ enabled: true, enabledProviders: [], agentAccess: {} });
  });
});
