import { Check } from "typebox/value";
import {
  AgentCatalogueResultSchema,
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

/**
 * The last door a catalogue walks through. Merge can assemble a definition
 * that typechecked in pieces and is not a snapshot — a name that emptied
 * out, a source the schema never named. Callers register whatever `ok`
 * hands them, so a half-valid success is how one bad field becomes a live
 * Agent type. invalid-command is the only failure this schema names for a
 * broken view; repository codes stay reserved for the port.
 */
function outbound(result: AgentCatalogueResult): AgentCatalogueResult {
  return Check(AgentCatalogueResultSchema, result)
    ? result
    : failure("invalid-command", "Agent catalogue result does not match its contract.");
}

export function createAgentCatalogue(options: CreateAgentCatalogueOptions): AgentCatalogue {
  if (!Check(AgentCatalogueSnapshotSchema, { definitions: options.builtInDefinitions })) {
    throw new TypeError("Built-in Agent definitions are invalid.");
  }
  const builtInDefinitions = structuredClone(options.builtInDefinitions);
  return {
    async execute(command: unknown): Promise<AgentCatalogueResult> {
      return outbound(await run(command));
    },
  };

  async function run(command: unknown): Promise<AgentCatalogueResult> {
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
            loaded.worktreeDefinitions ?? [],
          ),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown repository failure.";
      return failure("repository-failure", message);
    }
  }
}
