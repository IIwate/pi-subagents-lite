import type { ModelRoutingConfig } from "../config/types.js";
import { effectiveAlternateModelKeys } from "../models/model-access.js";

export interface GuidanceAgent {
  name: string;
  description: string;
  registeredTools?: string[];
  maxTurns?: number;
}

export interface AgentGuidanceOptions {
  agents: readonly GuidanceAgent[];
  parentModelKey: string;
  routing: Readonly<ModelRoutingConfig>;
  registryKeys: ReadonlySet<string>;
  scopedKeys: ReadonlySet<string> | null;
}

/** Deterministic per-run guidance for the schema-stealth Agent tool. */
export function buildCurrentAgentGuidance(options: AgentGuidanceOptions): string {
  const { parentModelKey, routing, registryKeys, scopedKeys } = options;
  const agents = [...options.agents].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const lines = ["[Subagent access]", "", "Available agent types:"];

  for (const agent of agents) {
    const details: string[] = [];
    if (agent.registeredTools?.length) details.push(`tools: ${[...agent.registeredTools].sort().join(", ")}`);
    if (agent.maxTurns) details.push(`max turns: ${agent.maxTurns}`);
    const suffix = details.length ? ` (${details.join("; ")})` : "";
    lines.push(`- ${agent.name}: ${agent.description}${suffix}`);
  }

  lines.push(
    "",
    "Agent tool rules:",
    "- Agents start with a fresh conversation.",
    "- For background work, set `run_in_background: true`; results are delivered automatically. Do not poll, sleep, or timeout-wait.",
    "- `worktree_path` must be the parent repository's main checkout or a linked worktree.",
    "- Omit `model` to use the exact parent model. Pass `model` only for an authorized alternate.",
    "- Never silently replace a rejected explicit model.",
    "",
    "Model access:",
  );

  if (parentModelKey) {
    lines.push("Default for every agent:", `- ${parentModelKey}`);
  } else {
    lines.push("No parent default is active; omitting `model` cannot start an Agent.");
  }

  if (!routing.enabled) {
    lines.push("", "Model routing is OFF. Other models are not authorized.");
    return lines.join("\n");
  }

  let advertised = false;
  for (const agent of agents) {
    const agentAccess = Object.hasOwn(routing.agentAccess, agent.name)
      ? routing.agentAccess[agent.name]
      : undefined;
    const rules = agentAccess?.providers;
    if (!rules) continue;
    const entries: string[] = [];
    for (const provider of Object.keys(rules).sort()) {
      if (!routing.enabledProviders.includes(provider)) continue;
      const rule = rules[provider];
      if (!rule.models) {
        const active = [...registryKeys].some((key) =>
          key.startsWith(`${provider}/`)
          && key !== parentModelKey
          && (!scopedKeys || scopedKeys.has(key)),
        );
        if (active) entries.push(`${provider}/*`);
        continue;
      }
      entries.push(...effectiveAlternateModelKeys(
        agent.name,
        {
          enabled: routing.enabled,
          enabledProviders: routing.enabledProviders,
          agentAccess: {
            [agent.name]: { providers: { [provider]: rule } },
          },
        },
        registryKeys,
        scopedKeys,
        parentModelKey,
      ));
    }
    if (entries.length === 0) continue;
    advertised = true;
    lines.push("", `${agent.name} alternate access:`, ...[...new Set(entries)].sort().map((key) => `- ${key}`));
  }

  lines.push("", advertised
    ? "All unlisted agents are parent-model only."
    : "No effective alternate model access is currently available.");
  return lines.join("\n");
}
