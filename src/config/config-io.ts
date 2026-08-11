/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * New-schema only: assignment-era routing shapes (allowCrossProvider,
 * allowedProviders, agentModels, dynamic agent[type] keys, agent.default) are not migrated. A
 * missing or malformed modelRouting block falls back to the defaults below;
 * the next explicit save writes the canonical schema.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentModelAccess, AgentSettings, ModelRoutingConfig, ProviderModelAccess, SubagentsConfig, ThinkingAccessOverride } from "./types.js";
import { CANONICAL_THINKING_LEVELS } from "./types.js";
import type { ThinkingLevel } from "../types.js";

const CONFIG_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Valid system prompt modes. */
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

/** Fresh fallback routing policy when modelRouting is missing or malformed. */
function defaultModelRouting(): ModelRoutingConfig {
  return { enabled: false, enabledProviders: [], agentAccess: {} };
}

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: AgentSettings = {
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  expandListByDefault: true,
  showTools: true,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
};

/**
 * Known agent setting keys. Unknown keys (legacy dynamic model keys, the
 * retired `default`) are dropped at load, so the next explicit save writes
 * the canonical schema. This is schema hygiene, not migration: old model
 * values are never read or transformed.
 */
const AGENT_SETTING_KEYS: readonly (keyof AgentSettings)[] = [
  "forceBackground",
  "graceTurns",
  "showCost",
  "systemPromptMode",
  "includeContextFiles",
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
  "disableDefaultAgents",
  "expandListByDefault",
  "showTools",
  "showTurns",
  "showInput",
  "showOutput",
  "showContext",
  "showTime",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

const THINKING_LEVELS = new Set<string>(CANONICAL_THINKING_LEVELS);

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.trim();
  return THINKING_LEVELS.has(level) ? level as ThinkingLevel : undefined;
}

function normalizeModelKey(value: string): string | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 ? key : undefined;
}

function mergeThinkingOverride(
  existing: ThinkingAccessOverride,
  incoming: ThinkingAccessOverride,
): ThinkingAccessOverride {
  const incomingAllowed = new Set(incoming.allowed);
  const allowed = existing.allowed.filter((level) => incomingAllowed.has(level));
  if (allowed.length === 0) return existing;
  const defaultLevel = allowed.includes(existing.default)
    ? existing.default
    : allowed.includes(incoming.default)
      ? incoming.default
      : allowed[0];
  return { allowed, default: defaultLevel };
}

function normalizeThinkingOverrides(raw: unknown): Record<string, ThinkingAccessOverride> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const thinking: Record<string, ThinkingAccessOverride> = {};
  for (const [rawKey, rawOverride] of Object.entries(raw)) {
    const key = normalizeModelKey(rawKey);
    if (!key || !isPlainObject(rawOverride) || !Array.isArray(rawOverride.allowed)) continue;
    const allowed = [...new Set(rawOverride.allowed
      .map(normalizeThinkingLevel)
      .filter((level): level is ThinkingLevel => level !== undefined))];
    const defaultLevel = normalizeThinkingLevel(rawOverride.default);
    if (allowed.length === 0 || !defaultLevel || !allowed.includes(defaultLevel)) continue;
    const normalized = { allowed, default: defaultLevel };
    const existing = Object.hasOwn(thinking, key) ? thinking[key] : undefined;
    setOwn(thinking, key, existing ? mergeThinkingOverride(existing, normalized) : normalized);
  }
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

function mergeProviderRule(
  existing: ProviderModelAccess,
  incoming: ProviderModelAccess,
): ProviderModelAccess | undefined {
  if (!existing.models) return incoming.models ? { models: [...incoming.models] } : {};
  if (!incoming.models) return { models: [...existing.models] };
  const incomingModels = new Set(incoming.models);
  const models = existing.models.filter((model) => incomingModels.has(model));
  return models.length > 0 ? { models } : undefined;
}

/**
 * Normalize the persisted routing policy. Omitted models means all models;
 * invalid or empty model arrays remove the provider rule instead of widening
 * it to all-model access.
 */
function normalizeModelRouting(raw: unknown): ModelRoutingConfig {
  if (!isPlainObject(raw)) return defaultModelRouting();

  const enabledProviders: string[] = [];
  if (Array.isArray(raw.enabledProviders)) {
    const seen = new Set<string>();
    for (const value of raw.enabledProviders) {
      if (typeof value !== "string") continue;
      const provider = value.trim();
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);
      enabledProviders.push(provider);
    }
  }

  const agentAccess: Record<string, AgentModelAccess> = {};
  const blockedProviders = new Map<string, Set<string>>();
  if (isPlainObject(raw.agentAccess)) {
    for (const [rawType, rawAccess] of Object.entries(raw.agentAccess)) {
      const type = rawType.trim();
      if (!type || !isPlainObject(rawAccess)) continue;

      const existing = Object.hasOwn(agentAccess, type) ? agentAccess[type] : undefined;
      const access = existing ?? { providers: {} };
      const blocked = blockedProviders.get(type) ?? new Set<string>();
      blockedProviders.set(type, blocked);

      if (isPlainObject(rawAccess.providers)) {
        for (const [rawProvider, rawProviderAccess] of Object.entries(rawAccess.providers)) {
          const provider = rawProvider.trim();
          if (!provider || blocked.has(provider) || !isPlainObject(rawProviderAccess)) continue;
          let normalized: ProviderModelAccess | undefined;
          if (!Object.hasOwn(rawProviderAccess, "models")) {
            if (Object.keys(rawProviderAccess).length === 0) normalized = {};
          } else if (Array.isArray(rawProviderAccess.models)) {
            const models = [...new Set(rawProviderAccess.models
              .filter((model): model is string => typeof model === "string")
              .map((model) => model.trim())
              .filter(Boolean))];
            if (models.length > 0) normalized = { models };
          }
          if (!normalized) continue;
          if (!Object.hasOwn(access.providers, provider)) {
            setOwn(access.providers, provider, normalized);
            continue;
          }
          const merged = mergeProviderRule(access.providers[provider], normalized);
          if (merged) {
            setOwn(access.providers, provider, merged);
          } else {
            delete access.providers[provider];
            blocked.add(provider);
          }
        }
      }
      if (rawAccess.parentModelAccess === false) access.parentModelAccess = false;
      const thinking = normalizeThinkingOverrides(rawAccess.thinking);
      if (thinking) {
        const mergedThinking = access.thinking ?? {};
        for (const [key, override] of Object.entries(thinking)) {
          const saved = Object.hasOwn(mergedThinking, key) ? mergedThinking[key] : undefined;
          setOwn(mergedThinking, key, saved ? mergeThinkingOverride(saved, override) : override);
        }
        access.thinking = mergedThinking;
      }
      if (
        Object.keys(access.providers).length > 0
        || access.parentModelAccess === false
        || Object.keys(access.thinking ?? {}).length > 0
      ) {
        if (!existing) setOwn(agentAccess, type, access);
      } else if (existing) {
        delete agentAccess[type];
      }
    }
  }

  return { enabled: raw.enabled === true, enabledProviders, agentAccess };
}

/**
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to
 * handle. Non-model agent and concurrency fields are read normally; legacy
 * model fields on agent are ignored.
 */
export function loadConfig(): SubagentsConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  // The literal JSON value `null` parses without throwing — guard it like
  // any other malformed shape so startup can never break.
  if (!isPlainObject(raw)) raw = {};

  const agentRaw = isPlainObject(raw.agent) ? raw.agent : {};
  const concurrencyRaw = isPlainObject(raw.concurrency) ? raw.concurrency : {};
  const agent: AgentSettings = {} as AgentSettings;
  for (const key of AGENT_SETTING_KEYS) {
    const value = agentRaw[key];
    if (value !== undefined) (agent as unknown as Record<string, unknown>)[key] = value;
  }
  return {
    modelRouting: normalizeModelRouting(raw.modelRouting),
    agent: { ...DEFAULT_AGENT, ...agent },
    concurrency: {
      ...concurrencyRaw,
      default: typeof concurrencyRaw.default === "number" ? concurrencyRaw.default : 4,
    } as SubagentsConfig["concurrency"],
  };
}

/** Write config to disk with atomic rename. */
export function saveConfigAtomic(config: SubagentsConfig): void {
  const tmpPath = CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${err}`);
  }
}
