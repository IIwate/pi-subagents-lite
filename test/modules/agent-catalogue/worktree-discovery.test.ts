import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AgentCatalogueResultSchema,
  DiscoverAgentCatalogueCommandSchema,
  createAgentCatalogue,
  type AgentCatalogueRepository,
} from "../../../src/modules/agent-catalogue/public.js";

describe("REQ-CATALOGUE-001 worktree discovery public seam", () => {
  it("adds a worktree-only name and keeps the global definition on a name clash", async () => {
    const repository: AgentCatalogueRepository = {
      async load() {
        return {
          definitions: [{
            name: "reviewer",
            description: "Global reviewer",
            systemPrompt: "Review globally.",
            source: "global",
          }],
          worktreeDefinitions: [
            {
              name: "reviewer",
              description: "Worktree reviewer",
              systemPrompt: "Review locally.",
              source: "project",
            },
            {
              name: "feature-reviewer",
              description: "Worktree only",
              systemPrompt: "Review the feature.",
              source: "project",
            },
          ],
        };
      },
    };
    const catalogue = createAgentCatalogue({
      repository,
      builtInDefinitions: [],
    });
    const command = JSON.parse(JSON.stringify({
      kind: "discover",
      roots: {
        globalDirectory: "C:/agents/global",
        projectDirectory: "C:/project/.pi/agents",
        worktreeDirectory: "C:/worktree/.pi/agents",
      },
      configuration: {},
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
          definitions: [
            {
              name: "reviewer",
              description: "Global reviewer",
              systemPrompt: "Review globally.",
              source: "global",
            },
            {
              name: "feature-reviewer",
              description: "Worktree only",
              systemPrompt: "Review the feature.",
              source: "project",
            },
          ],
        },
      },
      resultValid: true,
    });
  });
});
