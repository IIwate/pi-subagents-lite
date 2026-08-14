import {
  effectiveAlternateModelKeys,
  isParentModelAllowed,
  resolveThinkingAccess,
  type ThinkingAccessPolicy,
} from "../../model-access/public.js";
import type { AgentGuidanceRequest } from "../contracts/prompt-contracts.js";

function thinkingSummary(policy: ThinkingAccessPolicy): string {
  return `allowed: ${policy.allowed.join(", ")}; default: ${policy.default}`;
}

export function assembleGuidanceText(request: AgentGuidanceRequest): string {
  const agents = [...request.agents].sort((a, b) => a.name.localeCompare(b.name));
  const availableByKey = new Map(request.availableModels.map((model) => [model.key, model]));
  const callable: string[] = [];
  const unavailable: string[] = [];
  const alternateSections: string[] = [];

  for (const agent of agents) {
    const parentPolicy = request.parentModelKey && isParentModelAllowed(request.routing, agent.name)
      ? resolveThinkingAccess({
          routing: request.routing,
          agentType: agent.name,
          modelKey: request.parentModelKey,
          parentModelKey: request.parentModelKey,
          parentThinkingLevel: request.parentThinkingLevel ?? undefined,
          scopedThinkingLevel: request.parentScopedThinkingLevel ?? undefined,
          supportedLevels: request.parentSupportedLevels,
          fallbackLevel: request.parentFallbackLevel,
        })
      : null;
    const alternates = effectiveAlternateModelKeys(
      agent.name,
      request.routing,
      request.availableModels.map((model) => model.key),
      request.scopedKeys,
      request.parentModelKey,
    ).flatMap((key) => {
      const model = availableByKey.get(key);
      if (!model) return [];
      const policy = resolveThinkingAccess({
        routing: request.routing,
        agentType: agent.name,
        modelKey: key,
        parentModelKey: request.parentModelKey,
        parentThinkingLevel: request.parentThinkingLevel ?? undefined,
        scopedThinkingLevel: model.scopedThinkingLevel ?? undefined,
        supportedLevels: model.supportedLevels,
        fallbackLevel: model.fallbackLevel,
      });
      return policy ? [{ key, policy }] : [];
    });

    const details: string[] = [];
    if (agent.registeredTools?.length) details.push(`tools: ${[...agent.registeredTools].sort().join(", ")}`);
    if (agent.maxTurns) details.push(`max turns: ${agent.maxTurns}`);
    if (parentPolicy) {
      details.push(`parent default: ${request.parentModelKey}; ${thinkingSummary(parentPolicy)}`);
    } else if (alternates.length > 0) {
      details.push("`model` is required");
    }
    const suffix = details.length ? ` (${details.join("; ")})` : "";

    if (parentPolicy || alternates.length > 0) {
      callable.push(`- ${agent.name}: ${agent.description}${suffix}`);
    } else {
      unavailable.push(`- ${agent.name}: no authorized model`);
    }
    if (alternates.length > 0) {
      alternateSections.push(
        "",
        `${agent.name} alternate models:`,
        ...alternates.map(({ key, policy }) => `- ${key} (${thinkingSummary(policy)})`),
      );
    }
  }

  const lines = ["[Subagent access]", "", "Available agent types:", ...callable];
  if (unavailable.length > 0) lines.push("", "Unavailable agent types:", ...unavailable);
  lines.push(
    "",
    "Agent tool rules:",
    "- Agents start with a fresh conversation.",
    "- For background work, set `run_in_background: true`; results are delivered automatically. Do not poll, sleep, or timeout-wait.",
    "- A background Agent error is final. Do not spawn a replacement unless the user explicitly asks to retry. The user can continue it from the Child screen; a successful continue delivers a new result and does not retract the first delivery.",
    "- Prefer background for independent work; use foreground when the result gates the next parent action.",
    "- `worktree_path` must be the parent repository's main checkout or a linked worktree.",
    "- Omit `model` only when the chosen Agent type has an authorized parent default.",
    "- For an alternate, pass one exact model key listed below; do not invent or abbreviate model IDs.",
    "- Never silently replace a rejected model or Thinking level.",
  );
  lines.push(...alternateSections);
  return lines.join("\n");
}
