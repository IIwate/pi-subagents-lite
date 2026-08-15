/**
 * optional-roots.test.ts — Discovery without a project root (trust gate seam).
 *
 * Trust is decided in bootstrap; the catalogue only sees its absence as a
 * missing projectDirectory. The repository must therefore never receive a
 * project path when the root was not constructed.
 */

import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AgentCatalogueResultSchema,
  AgentCatalogueRootsSchema,
  DiscoverAgentCatalogueCommandSchema,
  createAgentCatalogue,
  type AgentCatalogueRepository,
} from "../../../src/modules/agent-catalogue/public.js";

describe("REQ-CATALOGUE-003 optional project root", () => {
  it("discovers with no project root and the repository receives no project path", async () => {
    const requests: unknown[] = [];
    const repository: AgentCatalogueRepository = {
      async load(request) {
        requests.push(JSON.parse(JSON.stringify(request)));
        return {
          definitions: [{
            name: "reviewer",
            description: "Global reviewer",
            systemPrompt: "Review globally.",
            source: "global",
          }],
        };
      },
    };
    const catalogue = createAgentCatalogue({ repository, builtInDefinitions: [] });
    const command = JSON.parse(JSON.stringify({
      kind: "discover",
      roots: { globalDirectory: "C:/agents/global" },
      configuration: {},
    }));

    const result = await catalogue.execute(command);

    expect(Check(DiscoverAgentCatalogueCommandSchema, command)).toBe(true);
    expect(Check(AgentCatalogueResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true);
    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual([{ globalDirectory: "C:/agents/global" }]);
  });

  it("round-trips roots without a project directory", () => {
    const roots = { globalDirectory: "C:/agents/global" };
    const revived: unknown = JSON.parse(JSON.stringify(roots));
    expect(Check(AgentCatalogueRootsSchema, revived)).toBe(true);
  });

  it("rejects empty-string roots", async () => {
    expect(Check(AgentCatalogueRootsSchema, { globalDirectory: "" })).toBe(false);
    expect(Check(AgentCatalogueRootsSchema, { globalDirectory: "C:/g", projectDirectory: "" })).toBe(false);

    const catalogue = createAgentCatalogue({
      repository: { async load() { throw new Error("must not be called"); } },
      builtInDefinitions: [],
    });
    const result = await catalogue.execute({
      kind: "discover",
      roots: { globalDirectory: "C:/g", projectDirectory: "" },
      configuration: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });
});
