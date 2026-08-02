/**
 * model-precedence.test.ts — Model resolution chain and authorization policy.
 *
 * Resolution (routing ON):
 *   1. session assignment
 *   2. persistent assignment (modelRouting.agentModels)
 *   3. agent frontmatter model
 *   4. parent model (fallback)
 *
 * Authorization: scope gate → exact parent always OK → routing OFF allows
 * only the parent model → ON allows parent provider + allowlist.
 */

import { describe, it, expect } from "vitest";
import { authorizeModel, resolveModelSelection } from "../../src/models/model-precedence.ts";
import type { SubagentsConfig } from "../../src/config/types.ts";

const baseConfig: SubagentsConfig = {
  modelRouting: { enabled: true, allowedProviders: [], agentModels: {} },
  agent: { forceBackground: false },
  concurrency: { default: 4 },
};

describe("model resolution precedence chain", () => {
  it("1 — session assignment wins over everything", () => {
    const r = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: { ...baseConfig, modelRouting: { ...baseConfig.modelRouting, agentModels: { Explore: "persistent" } } },
      parentModelId: "parent",
      sessionOverrides: { Explore: "session" },
    }).model;
    expect(r).toBe("session");
  });

  it("2 — persistent assignment beats frontmatter", () => {
    const r = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: { ...baseConfig, modelRouting: { ...baseConfig.modelRouting, agentModels: { Explore: "persistent" } } },
      parentModelId: "parent",
    }).model;
    expect(r).toBe("persistent");
  });

  it("3 — frontmatter beats parent model", () => {
    const r = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: baseConfig,
      parentModelId: "parent",
    }).model;
    expect(r).toBe("frontmatter");
  });

  it("preserves automatic provenance when an assignment equals the parent string", () => {
    const selection = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: { model: "provider/model" },
      config: baseConfig,
      parentModelId: "provider/model",
    });
    expect(selection).toEqual({ model: "provider/model", source: "automatic" });
  });

  it("4 — parent model as final fallback when nothing is assigned", () => {
    const r = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: undefined,
      config: baseConfig,
      parentModelId: "parent",
    }).model;
    expect(r).toBe("parent");
  });

  it("ignores empty strings in the chain", () => {
    const r = resolveModelSelection({
      subagentType: "Explore",
      agentConfig: { model: "" },
      config: { ...baseConfig, modelRouting: { ...baseConfig.modelRouting, agentModels: { Explore: "" } } },
      parentModelId: "parent",
      sessionOverrides: { Explore: "" },
    }).model;
    expect(r).toBe("parent");
  });
});

describe("authorizeModel — scope gate", () => {
  it("rejects models outside the active scope even when routing is ON", () => {
    expect(authorizeModel({
      modelKey: "x/y",
      parentModelKey: "p/parent",
      parentProvider: "p",
      allowedProviders: [],
      routingEnabled: true,
      scopedKeys: new Set(["p/parent"]),
    })).toEqual({ ok: false, reason: "out-of-scope" });
  });

  it("treats a null scope as unrestricted", () => {
    expect(authorizeModel({
      modelKey: "x/y",
      parentModelKey: "p/parent",
      parentProvider: "p",
      allowedProviders: ["x"],
      routingEnabled: true,
      scopedKeys: null,
    }).ok).toBe(true);
  });
});

describe("authorizeModel — routing OFF is strict parent inheritance", () => {
  const off = {
    parentModelKey: "p/parent",
    parentProvider: "p",
    allowedProviders: [],
    routingEnabled: false,
    scopedKeys: null,
  };

  it("allows the exact parent model", () => {
    expect(authorizeModel({ ...off, modelKey: "p/parent" }).ok).toBe(true);
  });

  it("rejects a different model from the parent provider", () => {
    expect(authorizeModel({ ...off, modelKey: "p/other" })).toEqual({
      ok: false,
      reason: "routing-disabled",
    });
  });

  it("rejects a model from another provider even when allowedProviders lists it", () => {
    expect(authorizeModel({ ...off, modelKey: "other/model", allowedProviders: ["other"] })).toEqual({
      ok: false,
      reason: "routing-disabled",
    });
  });
});

describe("authorizeModel — routing ON provider policy", () => {
  const on = {
    parentModelKey: "p/parent",
    parentProvider: "p",
    allowedProviders: ["openai", "google"],
    routingEnabled: true,
    scopedKeys: null,
  };

  it("allows the exact parent model", () => {
    expect(authorizeModel({ ...on, modelKey: "p/parent" }).ok).toBe(true);
  });

  it("allows any model from the parent provider (no allowlist entry needed)", () => {
    expect(authorizeModel({ ...on, modelKey: "p/other-model" }).ok).toBe(true);
  });

  it("allows models from allowlisted providers", () => {
    expect(authorizeModel({ ...on, modelKey: "openai/gpt-4o" }).ok).toBe(true);
    expect(authorizeModel({ ...on, modelKey: "google/gemini-2.5-pro" }).ok).toBe(true);
  });

  it("rejects providers not on the allowlist", () => {
    expect(authorizeModel({ ...on, modelKey: "xai/grok-4" })).toEqual({
      ok: false,
      reason: "provider-not-allowed",
    });
  });

  it("without a parent model, only allowlisted providers pass", () => {
    const noParent = { ...on, parentModelKey: "", parentProvider: "" };
    expect(authorizeModel({ ...noParent, modelKey: "openai/gpt-4o" }).ok).toBe(true);
    expect(authorizeModel({ ...noParent, modelKey: "p/other" })).toEqual({
      ok: false,
      reason: "provider-not-allowed",
    });
  });
});
