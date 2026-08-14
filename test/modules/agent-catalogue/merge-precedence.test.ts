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

  it("refuses a discover result whose merged definitions violate the snapshot contract", async () => {
    const definitions = [{
      name: "explorer",
      description: "User explorer",
      systemPrompt: "user prompt",
      source: "global" as const,
    }];
    const catalogue = createAgentCatalogue({
      repository: {
        async load() {
          return {
            definitions,
            get worktreeDefinitions() {
              // Hostile port: inbound Check already accepted this payload.
              // Emptying the name after that is how a passing load becomes an
              // unregisterable snapshot — outbound must refuse it.
              definitions[0] = { ...definitions[0]!, name: "" };
              return [];
            },
          };
        },
      },
      builtInDefinitions: [],
    });

    const result = await catalogue.execute({
      kind: "discover",
      roots: {
        globalDirectory: "C:/agents/global",
        projectDirectory: "C:/project/.pi/agents",
      },
      configuration: {},
    });
    expect(Check(AgentCatalogueResultSchema, result)).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Agent catalogue result does not match its contract." },
    });
  });
});
