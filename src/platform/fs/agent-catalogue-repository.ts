import { scanAgentFilesInDir, type AgentConfigFromMd } from "../../agents/agent-discovery.js";
import { Check } from "typebox/value";
import {
  AgentSourceDefinitionSchema,
  type AgentCatalogueRepository,
  type AgentSourceDefinition,
} from "../../modules/agent-catalogue/public.js";

function compactDefinition(definition: Record<string, unknown>): AgentSourceDefinition {
  return Object.fromEntries(
    Object.entries(definition).filter(([, value]) => value !== undefined),
  ) as AgentSourceDefinition;
}

function toSourceDefinition(definition: AgentConfigFromMd): AgentSourceDefinition | undefined {
  if (!definition.name) return undefined;
  const sourceDefinition = compactDefinition({
    name: definition.name,
    displayName: definition.display_name,
    description: definition.description,
    registeredTools: definition.tools,
    tools: definition.tools,
    excludeTools: definition.exclude_tools,
    extensions: definition.extensions,
    excludeExtensions: definition.exclude_extensions,
    skills: definition.skills,
    preloadSkills: definition.preload_skills,
    maxTurns: definition.max_turns,
    maxTokens: definition.max_tokens,
    hidden: definition.hidden,
    systemPrompt: definition.systemPrompt,
    source: definition.source === "user" ? "global" : "project",
  });
  return Check(AgentSourceDefinitionSchema, sourceDefinition)
    ? sourceDefinition
    : undefined;
}

export function createFileAgentCatalogueRepository(): AgentCatalogueRepository {
  return {
    async load(request) {
      const [globalDefinitions, projectDefinitions, worktreeDefinitions] = await Promise.all([
        scanAgentFilesInDir(request.globalDirectory, "user"),
        scanAgentFilesInDir(request.projectDirectory, "project"),
        request.worktreeDirectory
          ? scanAgentFilesInDir(request.worktreeDirectory, "project")
          : Promise.resolve([]),
      ]);
      const mappedWorktree = worktreeDefinitions
        .map(toSourceDefinition)
        .filter((definition): definition is AgentSourceDefinition => definition !== undefined);
      return {
        definitions: [...globalDefinitions, ...projectDefinitions]
          .map(toSourceDefinition)
          .filter((definition): definition is AgentSourceDefinition => definition !== undefined),
        ...(mappedWorktree.length > 0 ? { worktreeDefinitions: mappedWorktree } : {}),
      };
    },
  };
}
