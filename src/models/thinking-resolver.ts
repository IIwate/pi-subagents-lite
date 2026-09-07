import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types.js";
import { parseThinkingLevel } from "../utils.js";

export const VALID_THINKING_LEVELS = Object.freeze([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly ThinkingLevel[]);

function validateThinkingLevel(level: string): ThinkingLevel {
  const normalized = parseThinkingLevel(level);
  const validated = VALID_THINKING_LEVELS.find(candidate => candidate === normalized);
  if (validated === undefined) {
    throw new Error(`Invalid thinking level "${level}". Valid levels: ${VALID_THINKING_LEVELS.join(", ")}.`);
  }
  return validated;
}

export function validateExplicitThinking(level: string, model: Model<any>): ThinkingLevel {
  const validated = validateThinkingLevel(level);
  if (!model.reasoning && validated !== "off") {
    throw new Error(`Model "${model.id}" does not support reasoning.`);
  }
  if (model.thinkingLevelMap?.[validated] === null || !getSupportedThinkingLevels(model).includes(validated)) {
    throw new Error(`Thinking level "${validated}" is not supported by model "${model.id}".`);
  }
  return validated;
}

export function clampInheritedThinking(level: ThinkingLevel, model: Model<any>): ThinkingLevel | undefined {
  if (!model.reasoning) return undefined;
  const supported = getSupportedThinkingLevels(model);
  return supported.includes(level) ? level : supported.at(-1);
}

interface ThinkingResolutionOptions {
  model: Model<any>;
  thinking?: string;
  agentThinking?: string;
  scopedThinking?: string;
  defaultThinking?: string;
  parentThinking?: ThinkingLevel;
}

export function resolveThinkingLevel(options: ThinkingResolutionOptions): ThinkingLevel | undefined {
  const explicit = parseThinkingLevel(options.thinking) ?? parseThinkingLevel(options.agentThinking);
  if (explicit !== undefined) return validateExplicitThinking(explicit, options.model);

  const inherited = parseThinkingLevel(options.scopedThinking)
    ?? parseThinkingLevel(options.defaultThinking)
    ?? parseThinkingLevel(options.parentThinking);
  return inherited === undefined
    ? undefined
    : clampInheritedThinking(validateThinkingLevel(inherited), options.model);
}
