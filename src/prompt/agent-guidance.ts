import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoutingConfig } from "../config/types.js";
import {
  effectiveAlternateModelKeys,
  resolveThinkingAccess,
  type ThinkingAccessPolicy,
  type ThinkingLevel,
} from "../modules/model-access/public.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../models/model-scope.js";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export interface GuidanceAgent {
  name: string;
  description: string;
  registeredTools?: string[];
  maxTurns?: number;
}

export interface AgentGuidanceOptions {
  agents: readonly GuidanceAgent[];
  parentModel: Model<any> | undefined;
  parentThinkingLevel: ThinkingLevel | undefined;
  routing: Readonly<ModelRoutingConfig>;
  availableModels: readonly Model<any>[];
  scopedModels: ExtensionContext["scopedModels"];
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function thinkingSummary(policy: ThinkingAccessPolicy): string {
  return `allowed: ${policy.allowed.join(", ")}; default: ${policy.default}`;
}

/** Deterministic per-run guidance for the schema-stealth Agent tool. */
export function buildCurrentAgentGuidance(options: AgentGuidanceOptions): string {
  const agents = [...options.agents].sort((a, b) => a.name.localeCompare(b.name));
  const parentModelKey = options.parentModel ? modelKey(options.parentModel) : "";
  const availableByKey = new Map(options.availableModels.map((model) => [modelKey(model), model]));
  const availableKeys = new Set(availableByKey.keys());
  const scopedKeys = scopedModelKeys(options.scopedModels);
  const callable: string[] = [];
  const unavailable: string[] = [];
  const alternateSections: string[] = [];

  for (const agent of agents) {
    const access = ownValue(options.routing.agentAccess, agent.name);
    const parentPolicy = options.parentModel && access?.parentModelAccess !== false
      ? resolveThinkingAccess({
          modelKey: parentModelKey,
          parentModelKey,
          parentThinkingLevel: options.parentThinkingLevel,
          scopedThinkingLevel: scopedThinkingLevel(options.scopedModels, options.parentModel),
          supportedLevels: getSupportedThinkingLevels(options.parentModel) as ThinkingLevel[],
          fallbackLevel: clampThinkingLevel(options.parentModel, "high") as ThinkingLevel,
          override: access?.thinking?.[parentModelKey],
        })
      : null;
    const alternates = effectiveAlternateModelKeys(
      agent.name,
      options.routing,
      [...availableKeys],
      scopedKeys ? [...scopedKeys] : null,
      parentModelKey,
    ).flatMap((key) => {
      const model = availableByKey.get(key);
      if (!model) return [];
      const policy = resolveThinkingAccess({
        modelKey: key,
        parentModelKey,
        parentThinkingLevel: options.parentThinkingLevel,
        scopedThinkingLevel: scopedThinkingLevel(options.scopedModels, model),
        supportedLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
        fallbackLevel: clampThinkingLevel(model, "high") as ThinkingLevel,
        override: access?.thinking?.[key],
      });
      return policy ? [{ key, policy }] : [];
    });

    const details: string[] = [];
    if (agent.registeredTools?.length) details.push(`tools: ${[...agent.registeredTools].sort().join(", ")}`);
    if (agent.maxTurns) details.push(`max turns: ${agent.maxTurns}`);
    if (parentPolicy) {
      details.push(`parent default: ${parentModelKey}; ${thinkingSummary(parentPolicy)}`);
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
    "- A background Agent error is final. Do not spawn a replacement unless the user explicitly asks to retry.",
    "- Prefer background for independent work; use foreground when the result gates the next parent action.",
    "- `worktree_path` must be the parent repository's main checkout or a linked worktree.",
    "- Omit `model` only when the chosen Agent type has an authorized parent default.",
    "- For an alternate, pass one exact model key listed below; do not invent or abbreviate model IDs.",
    "- Never silently replace a rejected model or Thinking level.",
  );
  lines.push(...alternateSections);
  return lines.join("\n");
}
