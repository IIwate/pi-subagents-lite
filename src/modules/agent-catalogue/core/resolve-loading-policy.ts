import type {
  AgentDefinitionSnapshot,
  ResolveAgentPolicyConfiguration,
  ResolvedAgentLoadingPolicy,
} from "../contracts/catalogue-contracts.js";
import { excludeInheritedTools } from "./exclude-inherited-tools.js";

function copySelection(
  value: boolean | readonly string[] | undefined,
  implicit: boolean,
): boolean | string[] {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return [...value];
  return implicit;
}

export function resolveLoadingPolicy(
  definition: AgentDefinitionSnapshot,
  configuration: ResolveAgentPolicyConfiguration,
): ResolvedAgentLoadingPolicy {
  const hasExplicitTools = Boolean(definition.registeredTools?.length);
  const policy: ResolvedAgentLoadingPolicy = {
    definition: structuredClone(definition),
    registeredTools: excludeInheritedTools(
      hasExplicitTools
        ? definition.registeredTools!
        : configuration.defaultRegisteredTools,
    ),
    restrictToRegisteredTools: hasExplicitTools,
    extensions: copySelection(definition.extensions, configuration.loadExtensionsImplicitly),
    skills: copySelection(definition.skills, configuration.loadSkillsImplicitly),
  };
  if (definition.tools !== undefined) {
    policy.tools = Array.isArray(definition.tools)
      ? excludeInheritedTools(definition.tools)
      : definition.tools;
  }
  return policy;
}
