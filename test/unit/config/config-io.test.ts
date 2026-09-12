import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/config-io.js";

describe("configuration input boundary", () => {
  it.each([
    null, [], { modelRouting: false }, { agent: { forceBackground: "false" } },
    { concurrency: { models: { "provider/model": 0 } } },
    { modelRouting: { agentAccess: { worker: { providers: { provider: { models: [] } } } } } },
    { modelRouting: { agentAccess: { worker: { providers: { provider: { models: "all" } } } } } },
  ])("rejects malformed input without widening access: %j", input => {
    expect(() => parseConfig(input)).toThrow();
  });

  it("preserves dormant exact access and prototype-like identifiers as own rules", () => {
    const input = JSON.parse('{"modelRouting":{"enabled":true,"enabledProviders":[],"agentAccess":{"__proto__":{"providers":{"constructor":{"models":["model"]}}}}}}');
    const config = parseConfig(input);
    expect(Object.hasOwn(config.modelRouting.agentAccess, "__proto__")).toBe(true);
    expect(config.modelRouting.agentAccess.__proto__.providers.constructor).toEqual({ models: ["model"] });
    expect(config.modelRouting.enabledProviders).toEqual([]);
    expect(Object.getPrototypeOf(config.modelRouting.agentAccess)).toBe(Object.prototype);
  });
});
