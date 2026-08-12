import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  ReadConfigurationValueCommandSchema,
  ReadConfigurationValueResultSchema,
  createConfiguration,
  type ConfigurationDocumentRepository,
  type JsonObject,
} from "../../../src/modules/configuration/public.js";

describe("configuration public seam", () => {
  it("reads a capability-owned value without putting the revision in the document", async () => {
    const document: JsonObject = {
      modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
      agent: { disableDefaultAgents: true, forceBackground: false },
      concurrency: { default: 4 },
    };
    const repository: ConfigurationDocumentRepository = {
      async load() {
        return { revision: 7, document };
      },
    };
    const configuration = createConfiguration({ repository });
    const command = JSON.parse(JSON.stringify({
      kind: "read-value",
      path: ["agent", "disableDefaultAgents"],
    }));

    const result = await configuration.execute(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(ReadConfigurationValueCommandSchema, command),
      document,
      result: roundTrippedResult,
      resultValid: Check(ReadConfigurationValueResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      document: {
        modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
        agent: { disableDefaultAgents: true, forceBackground: false },
        concurrency: { default: 4 },
      },
      result: { ok: true, revision: 7, found: true, value: true },
      resultValid: true,
    });
  });
});
