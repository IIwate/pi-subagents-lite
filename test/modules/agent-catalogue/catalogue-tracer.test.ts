import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Check } from "typebox/value";
import {
  AgentCatalogueResultSchema,
  DiscoverAgentCatalogueCommandSchema,
  createAgentCatalogue,
  type AgentCatalogueRepository,
} from "../../../src/modules/agent-catalogue/public.js";
import { createFileAgentCatalogueRepository } from "../../../src/platform/fs/agent-catalogue-repository.js";

describe("REQ-CATALOGUE-002 Agent catalogue public seam", () => {
  it("keeps a same-name global definition when built-in definitions are disabled", async () => {
    const repository: AgentCatalogueRepository = {
      async load() {
        return {
          definitions: [{
            name: "general-purpose",
            description: "Custom general-purpose agent",
            systemPrompt: "Use the project review policy.",
            source: "global",
          }],
        };
      },
    };
    const catalogue = createAgentCatalogue({
      repository,
      builtInDefinitions: [
        {
          name: "general-purpose",
          displayName: "Agent",
          description: "General-purpose agent",
          systemPrompt: "",
          source: "built-in",
        },
        {
          name: "Explore",
          displayName: "Explore",
          description: "Read-only exploration agent",
          systemPrompt: "Explore safely.",
          source: "built-in",
        },
      ],
    });
    const command = JSON.parse(JSON.stringify({
      kind: "discover",
      roots: {
        globalDirectory: "C:/agents/global",
        projectDirectory: "C:/project/.pi/agents",
      },
      configuration: { disableDefaultAgents: true },
    }));

    const result = await catalogue.execute(command);
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      commandValid: Check(DiscoverAgentCatalogueCommandSchema, command),
      result: roundTrippedResult,
      resultValid: Check(AgentCatalogueResultSchema, roundTrippedResult),
    }).toEqual({
      commandValid: true,
      result: {
        ok: true,
        catalogue: {
          definitions: [{
            name: "general-purpose",
            description: "Custom general-purpose agent",
            systemPrompt: "Use the project review policy.",
            source: "global",
          }],
        },
      },
      resultValid: true,
    });
  });

  it("keeps valid filesystem definitions when another file is malformed", async () => {
    const globalDirectory = resolve(import.meta.dirname, "../../resources/agent-catalogue/mixed");
    const projectDirectory = resolve(import.meta.dirname, "../../resources/agent-catalogue/missing");

    const catalogue = createAgentCatalogue({
      repository: createFileAgentCatalogueRepository(),
      builtInDefinitions: [],
    });
    const result = await catalogue.execute({
      kind: "discover",
      roots: { globalDirectory, projectDirectory },
      configuration: {},
    });

    expect(result).toEqual({
      ok: true,
      catalogue: {
        definitions: [{
          name: "valid-agent",
          description: "Valid definition",
          systemPrompt: "Review the task.",
          source: "global",
        }],
      },
    });
  });
});
