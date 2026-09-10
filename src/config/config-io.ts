/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to an exclusively created sibling file, then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * New-schema only: assignment-era routing shapes (allowCrossProvider,
 * allowedProviders, agentModels, dynamic agent[type] keys, agent.default) are not migrated. A
 * missing or malformed modelRouting block falls back to the defaults below;
 * the next explicit save writes the canonical schema.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentModelAccess, AgentSettings, ModelRoutingConfig, ProviderModelAccess, SubagentsConfig } from "./types.js";

const CONFIG_DIR = getAgentDir();
export const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Valid system prompt modes. */
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

export function normalizeConcurrencyLimit(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Concurrency limit must be a finite number.");
  return Math.max(1, Math.ceil(value));
}

export function validateGraceTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Grace turns must be a non-negative safe integer.");
  }
  return value;
}

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
  "defaultThinking",
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

function invalidValue(field: string, fallback: unknown): void {
  console.warn(`[subagents] Invalid config field ${JSON.stringify(field)}; using ${JSON.stringify(fallback)}.`);
}

function readConcurrencyLimit(raw: unknown, fallback: number, field: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return normalizeConcurrencyLimit(raw);
  if (raw !== undefined) invalidValue(field, fallback);
  return fallback;
}

function readConcurrencyOverrides(raw: unknown, field: string): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    invalidValue(field, {});
    return undefined;
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [
    key, readConcurrencyLimit(value, 1, `${field}.${key}`),
  ]));
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
  if (isPlainObject(raw.agentAccess)) {
    for (const [rawType, rawAccess] of Object.entries(raw.agentAccess)) {
      const type = rawType.trim();
      if (!type || !isPlainObject(rawAccess) || !isPlainObject(rawAccess.providers)) continue;

      const providers: Record<string, ProviderModelAccess> = {};
      for (const [rawProvider, rawProviderAccess] of Object.entries(rawAccess.providers)) {
        const provider = rawProvider.trim();
        if (!provider || !isPlainObject(rawProviderAccess)) continue;
        if (!Object.hasOwn(rawProviderAccess, "models")) {
          if (Object.keys(rawProviderAccess).length === 0) setOwn(providers, provider, {});
          continue;
        }
        if (!Array.isArray(rawProviderAccess.models)) continue;
        const models = [...new Set(rawProviderAccess.models
          .filter((model): model is string => typeof model === "string")
          .map((model) => model.trim())
          .filter(Boolean))];
        if (models.length > 0) setOwn(providers, provider, { models });
      }
      if (Object.keys(providers).length > 0) setOwn(agentAccess, type, { providers });
    }
  }

  return { enabled: raw.enabled === true, enabledProviders, agentAccess };
}

/**
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to
 * handle. Numeric ceilings are normalized at this external boundary; legacy
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
  if (agent.graceTurns !== undefined) {
    try {
      agent.graceTurns = validateGraceTurns(agent.graceTurns);
    } catch {
      invalidValue("agent.graceTurns", DEFAULT_GRACE_TURNS);
      agent.graceTurns = DEFAULT_GRACE_TURNS;
    }
  }
  return {
    modelRouting: normalizeModelRouting(raw.modelRouting),
    agent: { ...DEFAULT_AGENT, ...agent },
    concurrency: {
      default: readConcurrencyLimit(concurrencyRaw.default, DEFAULT_CONCURRENCY.default, "concurrency.default"),
      providers: readConcurrencyOverrides(concurrencyRaw.providers, "concurrency.providers"),
      models: readConcurrencyOverrides(concurrencyRaw.models, "concurrency.models"),
    },
  };
}

/** Write config to disk with atomic rename. */
export function saveConfigAtomic(config: SubagentsConfig): void {
  const content = JSON.stringify(config, null, 2);
  const tmpPath = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTemporary = false;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fd = fs.openSync(tmpPath, "wx");
    ownsTemporary = true;
    fs.writeFileSync(fd, content, "utf-8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, CONFIG_PATH);
    ownsTemporary = false;
  } finally {
    // Cleanup diagnostics must not replace the write or rename error.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (error) {
        console.error(`[subagents] Failed to close config temporary file: ${error}`);
      }
    }
    if (ownsTemporary) {
      try { fs.unlinkSync(tmpPath); } catch (error) {
        console.error(`[subagents] Failed to remove config temporary file: ${error}`);
      }
    }
  }
}
