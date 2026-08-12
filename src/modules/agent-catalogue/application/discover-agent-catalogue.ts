import { Check } from "typebox/value";
import {
  AgentCatalogueSnapshotSchema,
  AgentSourceLoadResultSchema,
  DiscoverAgentCatalogueCommandSchema,
  type AgentCatalogueResult,
  type AgentDefinitionSnapshot,
} from "../contracts/catalogue-contracts.js";
import { mergeAgentDefinitions } from "../core/merge-agent-definitions.js";
import type { AgentCatalogueRepository } from "../ports/agent-catalogue-repository.js";

export interface AgentCatalogue {
  execute(command: unknown): Promise<AgentCatalogueResult>;
}

export interface CreateAgentCatalogueOptions {
  repository: AgentCatalogueRepository;
  builtInDefinitions: readonly AgentDefinitionSnapshot[];
}

function failure(
  code: "invalid-command" | "repository-failure" | "invalid-repository-result",
  message: string,
): AgentCatalogueResult {
  return { ok: false, error: { code, message } };
}

export function createAgentCatalogue(options: CreateAgentCatalogueOptions): AgentCatalogue {
  if (!Check(AgentCatalogueSnapshotSchema, { definitions: options.builtInDefinitions })) {
    throw new TypeError("Built-in Agent definitions are invalid.");
  }
  const builtInDefinitions = structuredClone(options.builtInDefinitions);
  return {
    async execute(command: unknown): Promise<AgentCatalogueResult> {
      if (!Check(DiscoverAgentCatalogueCommandSchema, command)) {
        return failure("invalid-command", "Agent catalogue command is invalid.");
      }

      try {
        const loaded = await options.repository.load(command.roots);
        if (!Check(AgentSourceLoadResultSchema, loaded)) {
          return failure("invalid-repository-result", "Agent catalogue repository returned invalid data.");
        }
        return {
          ok: true,
          catalogue: {
            definitions: mergeAgentDefinitions(
              builtInDefinitions,
              loaded.definitions,
              command.configuration,
            ),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown repository failure.";
        return failure("repository-failure", message);
      }
    },
  };
}
