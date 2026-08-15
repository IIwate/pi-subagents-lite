/**
 * host-resources.test.ts — Canonical Pi installation path snapshot.
 *
 * The adapter is exercised through the injectable factory seam; the real Pi
 * SDK readers are touched only by one smoke assertion so tests never depend
 * on the Pi environment variable name (it can change with an APP_NAME rebrand).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createHostInstallationPaths,
  hostInstallationPaths,
  HostInstallationPathsSchema,
} from "../../../src/platform/pi/host-resources.js";

const absoluteDir = path.resolve("/custom/agent-root");

describe("createHostInstallationPaths", () => {
  it("REQ-CONFIG-002 projects an injected Pi agent directory and config dir name into a validated snapshot", () => {
    const snapshot = createHostInstallationPaths({
      getAgentDir: () => absoluteDir,
      configDirName: ".pi",
    });
    expect(snapshot).toEqual({
      agentDirectory: absoluteDir,
      projectConfigDirectoryName: ".pi",
    });
    expect(Check(HostInstallationPathsSchema, snapshot)).toBe(true);
  });

  it("survives a JSON round trip", () => {
    const snapshot = createHostInstallationPaths({
      getAgentDir: () => absoluteDir,
      configDirName: ".custom",
    });
    const revived: unknown = JSON.parse(JSON.stringify(snapshot));
    expect(Check(HostInstallationPathsSchema, revived)).toBe(true);
    expect(revived).toEqual(snapshot);
  });

  it("rejects a relative agent directory", () => {
    expect(() => createHostInstallationPaths({
      getAgentDir: () => "relative/agent",
      configDirName: ".pi",
    })).toThrow(TypeError);
  });

  it("rejects an empty agent directory", () => {
    expect(() => createHostInstallationPaths({
      getAgentDir: () => "",
      configDirName: ".pi",
    })).toThrow(TypeError);
  });

  it.each(["", ".", "..", "a/b", "a\\b", "/abs", "..\\up"])(
    "rejects config dir name %j that is not a single safe path segment",
    (configDirName) => {
      expect(() => createHostInstallationPaths({
        getAgentDir: () => absoluteDir,
        configDirName,
      })).toThrow(TypeError);
    },
  );
});

describe("HostInstallationPathsSchema", () => {
  it("rejects empty values, wrong types, and extra keys", () => {
    expect(Check(HostInstallationPathsSchema, { agentDirectory: "", projectConfigDirectoryName: ".pi" })).toBe(false);
    expect(Check(HostInstallationPathsSchema, { agentDirectory: absoluteDir, projectConfigDirectoryName: "" })).toBe(false);
    expect(Check(HostInstallationPathsSchema, { agentDirectory: null, projectConfigDirectoryName: ".pi" })).toBe(false);
    expect(Check(HostInstallationPathsSchema, {
      agentDirectory: absoluteDir,
      projectConfigDirectoryName: ".pi",
      extra: true,
    })).toBe(false);
  });
});

describe("hostInstallationPaths (real SDK smoke)", () => {
  it("matches Pi's resolved agent directory", () => {
    expect(hostInstallationPaths.agentDirectory).toBe(path.resolve(getAgentDir()));
    expect(Check(HostInstallationPathsSchema, hostInstallationPaths)).toBe(true);
  });
});
