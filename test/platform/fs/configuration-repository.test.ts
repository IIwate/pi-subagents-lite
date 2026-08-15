import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { ConfigurationDocumentLoadResultSchema } from "../../../src/modules/configuration/public.js";
import { createFileConfigurationDocumentRepository } from "../../../src/platform/fs/configuration-document-repository.js";
import {
  configFilePath,
  customPromptFilePath,
  projectAgentsDirPath,
  userAgentsDirPath,
} from "../../../src/platform/fs/config-paths.js";

const tempRoots: string[] = [];

function tempConfigFile(): string {
  const root = mkdtempSync(join(tmpdir(), "subagents-config-"));
  tempRoots.push(root);
  return join(root, "nested", "subagents-lite.json");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("file configuration document repository contract", () => {
  it("reports a missing file as absent, distinct from malformed content", () => {
    const repository = createFileConfigurationDocumentRepository({ filePath: tempConfigFile() });
    expect(repository.load()).toEqual({ status: "absent" });
  });

  it("reports malformed JSON, the JSON literal null, and arrays as malformed with a message", () => {
    const filePath = tempConfigFile();
    mkdirSync(join(filePath, ".."), { recursive: true });
    const repository = createFileConfigurationDocumentRepository({ filePath });

    writeFileSync(filePath, "{ not json", "utf-8");
    const malformed = repository.load();
    writeFileSync(filePath, "null", "utf-8");
    const nullLiteral = repository.load();
    writeFileSync(filePath, "[1,2]", "utf-8");
    const array = repository.load();

    for (const result of [malformed, nullLiteral, array]) {
      expect(result).toMatchObject({ status: "malformed", message: expect.any(String) });
      expect(Check(ConfigurationDocumentLoadResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true);
    }
  });

  it("reports a non-ENOENT read failure as malformed instead of absent", () => {
    // A directory at the file path makes readFileSync fail with EISDIR.
    const filePath = tempConfigFile();
    mkdirSync(filePath, { recursive: true });
    const repository = createFileConfigurationDocumentRepository({ filePath });

    expect(repository.load()).toMatchObject({ status: "malformed", message: expect.any(String) });
  });

  it("persists the document atomically with the current two-space formatting", () => {
    const filePath = tempConfigFile();
    const repository = createFileConfigurationDocumentRepository({ filePath });
    const document = {
      modelRouting: { enabled: true, enabledProviders: ["openai"], agentAccess: {} },
      agent: { forceBackground: false },
      concurrency: { default: 4 },
    };

    repository.persist(document);

    expect(readFileSync(filePath, "utf-8")).toBe(JSON.stringify(document, null, 2));
    expect(repository.load()).toEqual({ status: "loaded", document });
  });

  it("overwrites an existing file on a second persist", () => {
    const filePath = tempConfigFile();
    const repository = createFileConfigurationDocumentRepository({ filePath });
    const first = { concurrency: { default: 4 } };
    const second = { concurrency: { default: 8 }, agent: { forceBackground: true } };

    repository.persist(first);
    repository.persist(second);

    expect(readFileSync(filePath, "utf-8")).toBe(JSON.stringify(second, null, 2));
    expect(repository.load()).toEqual({ status: "loaded", document: second });
  });

  it("throws on persistence failure instead of swallowing it", () => {
    // A directory at the target path makes the atomic rename fail, standing in
    // for permission and disk errors that REQ-CONFIG-001 must surface.
    const filePath = tempConfigFile();
    mkdirSync(filePath, { recursive: true });
    const repository = createFileConfigurationDocumentRepository({ filePath });

    expect(() => repository.persist({ concurrency: { default: 4 } })).toThrowError();
  });
});

describe("config path policy", () => {
  it("REQ-CONFIG-002 derives all persisted global locations from the Pi agent directory", () => {
    const root = join("H:", "users", "demo", ".pi", "agent");
    expect(configFilePath(root)).toBe(join(root, "subagents-lite.json"));
    expect(customPromptFilePath(root)).toBe(join(root, "subagents-lite-prompt.md"));
    expect(userAgentsDirPath(root)).toBe(join(root, "agents"));
  });

  it("REQ-CONFIG-002 composes the project agents root from Pi's config directory name", () => {
    expect(projectAgentsDirPath(join("H:", "repo"), ".pi")).toBe(join("H:", "repo", ".pi", "agents"));
    expect(projectAgentsDirPath(join("H:", "repo"), ".other")).toBe(join("H:", "repo", ".other", "agents"));
  });
});
