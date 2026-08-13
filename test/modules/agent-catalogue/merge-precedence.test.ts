import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AgentCatalogueResultSchema,
  createAgentCatalogue,
  type AgentCatalogueRepository,
} from "../../../src/modules/agent-catalogue/public.js";

describe("REQ-CATALOGUE-001 source precedence public seam", () => {
  it("keeps lower-layer fields when a higher layer omits them", async () => {
    const repository: AgentCatalogueRepository = {
      async load() {
        return {
          definitions: [
            {
              name: "explorer",
              description: "User explorer",
              systemPrompt: "user prompt",
              source: "global",
            },
            {
              name: "explorer",
              systemPrompt: "project prompt",
              source: "project",
            },
          ],
        };
      },
    };
    const catalogue = createAgentCatalogue({
      repository,
      builtInDefinitions: [{
        name: "explorer",
        description: "Default explorer",
        systemPrompt: "default prompt",
        extensions: true,
        skills: true,
        source: "built-in",
      }],
    });

    const result = await catalogue.execute({
      kind: "discover",
      roots: {
        globalDirectory: "C:/agents/global",
        projectDirectory: "C:/project/.pi/agents",
      },
      configuration: {},
    });
    const roundTrippedResult = JSON.parse(JSON.stringify(result));

    expect({
      result: roundTrippedResult,
      resultValid: Check(AgentCatalogueResultSchema, roundTrippedResult),
    }).toEqual({
      result: {
        ok: true,
        catalogue: {
          definitions: [{
            name: "explorer",
            description: "User explorer",
            systemPrompt: "project prompt",
            extensions: true,
            skills: true,
            source: "project",
          }],
        },
      },
      resultValid: true,
    });
  });
});
