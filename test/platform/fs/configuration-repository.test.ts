import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("loads an empty document for a missing file", () => {
    const repository = createFileConfigurationDocumentRepository({ filePath: tempConfigFile() });
    expect(repository.load()).toEqual({});
  });

  it("loads an empty document for malformed JSON and the JSON literal null", () => {
    const filePath = tempConfigFile();
    mkdirSync(join(filePath, ".."), { recursive: true });
    const repository = createFileConfigurationDocumentRepository({ filePath });

    writeFileSync(filePath, "{ not json", "utf-8");
    const malformed = repository.load();
    writeFileSync(filePath, "null", "utf-8");
    const nullLiteral = repository.load();
    writeFileSync(filePath, "[1,2]", "utf-8");
    const array = repository.load();

    expect({ malformed, nullLiteral, array }).toEqual({ malformed: {}, nullLiteral: {}, array: {} });
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
    expect(repository.load()).toEqual(document);
  });

  it("overwrites an existing file on a second persist", () => {
    const filePath = tempConfigFile();
    const repository = createFileConfigurationDocumentRepository({ filePath });
    const first = { concurrency: { default: 4 } };
    const second = { concurrency: { default: 8 }, agent: { forceBackground: true } };

    repository.persist(first);
    repository.persist(second);

    expect(readFileSync(filePath, "utf-8")).toBe(JSON.stringify(second, null, 2));
    expect(repository.load()).toEqual(second);
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
