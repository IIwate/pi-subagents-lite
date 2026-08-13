import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  CommitConfigurationFragmentCommandSchema,
  CommitConfigurationFragmentResultSchema,
  ReadConfigurationValueCommandSchema,
  ReadConfigurationValueResultSchema,
  createConfiguration,
  type ConfigurationDocumentRepository,
  type JsonObject,
} from "../../../src/modules/configuration/public.js";

interface MemoryRepository extends ConfigurationDocumentRepository {
  persisted: JsonObject[];
  failNextPersist: (message: string) => void;
  setDocument: (document: JsonObject) => void;
}

function memoryRepository(initial: JsonObject = {}): MemoryRepository {
  let document = structuredClone(initial);
  let failure: string | null = null;
  return {
    persisted: [],
    failNextPersist(message) {
      failure = message;
    },
    setDocument(next) {
      document = structuredClone(next);
    },
    load() {
      return structuredClone(document);
    },
    persist(next) {
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      document = structuredClone(next);
      this.persisted.push(structuredClone(next));
    },
  };
}

describe("configuration public seam", () => {
  it("reads a capability-owned value without putting the revision in the document", () => {
    const repository = memoryRepository({
      modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
      agent: { disableDefaultAgents: true, forceBackground: false },
      concurrency: { default: 4 },
    });
    const configuration = createConfiguration({ repository });
    const command = JSON.parse(JSON.stringify({
      kind: "read-value",
      path: ["agent", "disableDefaultAgents"],
    }));

    const result = configuration.execute(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ReadConfigurationValueCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(ReadConfigurationValueResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: { ok: true, revision: 1, found: true, value: true },
      resultValid: true,
    });
  });

  it("commits one fragment and preserves keys owned by other capabilities in the same section", () => {
    const repository = memoryRepository({
      agent: { forceBackground: true, showTools: false },
      concurrency: { default: 4 },
    });
    const configuration = createConfiguration({ repository });
    const command = JSON.parse(JSON.stringify({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "agent",
      assignments: { showTools: true, showCost: true },
    }));

    const commit = configuration.execute(command);
    const readBack = configuration.execute({ kind: "read-value", path: ["agent"] });

    expect({
      commandValid: Check(CommitConfigurationFragmentCommandSchema, command),
      commit: JSON.parse(JSON.stringify(commit)),
      commitValid: Check(CommitConfigurationFragmentResultSchema, JSON.parse(JSON.stringify(commit))),
      persisted: repository.persisted,
      readBack,
    }).toEqual({
      commandValid: true,
      commit: { ok: true, revision: 2 },
      commitValid: true,
      persisted: [{
        agent: { forceBackground: true, showTools: true, showCost: true },
        concurrency: { default: 4 },
      }],
      readBack: {
        ok: true,
        revision: 2,
        found: true,
        value: { forceBackground: true, showTools: true, showCost: true },
      },
    });
  });

  it("keeps the previous fragment effective and reports an explicit failure when persistence fails", () => {
    // REQ-CONFIG-001: a failed save must not publish the candidate value.
    const repository = memoryRepository({ concurrency: { default: 4 } });
    const configuration = createConfiguration({ repository });
    repository.failNextPersist("EACCES: permission denied");

    const commit = configuration.execute({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "concurrency",
      assignments: { default: 9 },
    });
    const readBack = configuration.execute({ kind: "read-value", path: ["concurrency", "default"] });

    expect({ commit, readBack, persisted: repository.persisted }).toEqual({
      commit: {
        ok: false,
        error: { code: "persistence-failure", message: "EACCES: permission denied" },
      },
      readBack: { ok: true, revision: 1, found: true, value: 4 },
      persisted: [],
    });
  });

  it("rejects a commit built against a stale revision", () => {
    const repository = memoryRepository({});
    const configuration = createConfiguration({ repository });
    configuration.execute({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "concurrency",
      assignments: { default: 2 },
    });

    const stale = configuration.execute({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "concurrency",
      assignments: { default: 3 },
    });

    expect(stale).toEqual({
      ok: false,
      error: {
        code: "revision-conflict",
        message: "Expected revision 1 but the current document is at 2.",
      },
    });
  });

  it("replaces a malformed section instead of merging into unreadable data", () => {
    const repository = memoryRepository({ concurrency: "broken" as unknown as JsonObject[string] } as JsonObject);
    const configuration = createConfiguration({ repository });

    configuration.execute({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "concurrency",
      assignments: { default: 6 },
    });

    expect(repository.persisted).toEqual([{ concurrency: { default: 6 } }]);
  });

  it("stores prototype-like keys as own enumerable entries", () => {
    const repository = memoryRepository({});
    const configuration = createConfiguration({ repository });

    configuration.execute({
      kind: "commit-fragment",
      expectedRevision: 1,
      section: "modelRouting",
      assignments: JSON.parse('{"agentAccess":{"constructor":{"providers":{"__proto__":{"models":["worker"]}}}}}'),
    });
    const readBack = configuration.execute({ kind: "read-value", path: ["modelRouting", "agentAccess"] });

    if (!readBack.ok || !("found" in readBack) || !readBack.found) throw new Error("expected a found read");
    const access = readBack.value as Record<string, { providers: Record<string, unknown> }>;
    expect(Object.hasOwn(access, "constructor")).toBe(true);
    expect(Object.hasOwn(access.constructor!.providers, "__proto__")).toBe(true);
    expect(access.constructor!.providers.__proto__).toEqual({ models: ["worker"] });
  });

  it("reloads the persisted document and advances the revision", () => {
    const repository = memoryRepository({ agent: { graceTurns: 6 } });
    const configuration = createConfiguration({ repository });
    repository.setDocument({ agent: { graceTurns: 9 } });

    const beforeReload = configuration.execute({ kind: "read-value", path: ["agent", "graceTurns"] });
    const reload = configuration.execute({ kind: "reload" });
    const afterReload = configuration.execute({ kind: "read-value", path: ["agent", "graceTurns"] });

    expect({ beforeReload, reload, afterReload }).toEqual({
      beforeReload: { ok: true, revision: 1, found: true, value: 6 },
      reload: { ok: true, revision: 2 },
      afterReload: { ok: true, revision: 2, found: true, value: 9 },
    });
  });

  it("rejects a command outside the configuration schema", () => {
    const configuration = createConfiguration({ repository: memoryRepository({}) });
    expect(configuration.execute({ kind: "commit-fragment", section: "agent" })).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Configuration command is invalid." },
    });
  });
});
