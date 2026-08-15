import { describe, expect, it } from "vitest";
import {
  createConfiguration,
  resolveOperationalValue,
  type ConfigurationDocumentRepository,
} from "../../../src/modules/configuration/public.js";

describe("operational source precedence", () => {
  it("prefers the environment variable over every other source", () => {
    expect(resolveOperationalValue({
      environment: "/from-environment",
      dotEnv: "/from-dot-env",
      configured: "/from-config-file",
      fallback: "/fallback",
    })).toBe("/from-environment");
  });

  it("prefers the .env value when the environment variable is unset", () => {
    expect(resolveOperationalValue({
      dotEnv: "/from-dot-env",
      configured: "/from-config-file",
      fallback: "/fallback",
    })).toBe("/from-dot-env");
  });

  it("prefers the configured file value when both external sources are unset", () => {
    expect(resolveOperationalValue({
      configured: "/from-config-file",
      fallback: "/fallback",
    })).toBe("/from-config-file");
  });

  it("uses the capability-owned fallback when every source is unset", () => {
    expect(resolveOperationalValue({ fallback: "/fallback" })).toBe("/fallback");
  });

  it("rejects candidates that do not match the inbound contract", () => {
    expect(() => resolveOperationalValue({} as never)).toThrow(TypeError);
    expect(() => resolveOperationalValue({ fallback: 1 } as never)).toThrow(
      /Operational value candidates do not match their contract/,
    );
  });

  it("treats a set-but-empty source as absent instead of an override", () => {
    // Preserves the historical `process.env.HOME || ""` contract: an empty
    // exported variable must not blank out a usable lower-precedence source.
    expect(resolveOperationalValue({
      environment: "",
      dotEnv: "",
      configured: "/from-config-file",
      fallback: "/fallback",
    })).toBe("/from-config-file");
    expect(resolveOperationalValue({
      environment: "",
      fallback: "/os-home",
    })).toBe("/os-home");
  });
});

describe("interactive policy isolation from environment sources", () => {
  it("reads interactive policy values from the document even when a same-named environment variable exists", () => {
    // The configuration facade has no environment port at all; this test
    // fails only if someone wires one in, which is the revisit signal for
    // the no-implicit-override rule.
    const repository: ConfigurationDocumentRepository = {
      load: () => ({ status: "loaded" as const, document: { modelRouting: { enabled: true } } }),
      persist: () => {},
    };
    const configuration = createConfiguration({ repository });
    process.env.modelRouting = JSON.stringify({ enabled: false });
    try {
      const result = configuration.execute({ kind: "read-value", path: ["modelRouting", "enabled"] });
      expect(result).toMatchObject({ ok: true, found: true, value: true });
    } finally {
      delete process.env.modelRouting;
    }
  });
});
