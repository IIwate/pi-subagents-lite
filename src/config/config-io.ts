/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * New-schema only: pre-2.0 routing shapes (allowCrossProvider, dynamic
 * agent[type] model keys, agent.default) are not migrated and not read. A
 * missing or malformed modelRouting block falls back to the defaults below;
 * the next explicit save writes the canonical schema.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSettings, ModelRoutingConfig, SubagentsConfig } from "./types.js";

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

/** Fallback routing policy when modelRouting is missing or malformed. */
const DEFAULT_MODEL_ROUTING: ModelRoutingConfig = {
  enabled: false,
  allowedProviders: [],
  agentModels: {},
};

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: AgentSettings = {
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
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

/**
 * Normalize the persisted routing policy. Malformed shapes are ignored
 * field-by-field: modelRouting must be a plain object, enabled only accepts
 * true, allowedProviders must be an array of trim-nonempty unique strings,
 * and agentModels must be a plain object of nonempty string pairs. Anything
 * else falls back to defaults — a bad config can never break startup.
 */
function normalizeModelRouting(raw: unknown): ModelRoutingConfig {
  if (!isPlainObject(raw)) return { ...DEFAULT_MODEL_ROUTING };

  const enabled = raw.enabled === true;

  const allowedProviders: string[] = [];
  if (Array.isArray(raw.allowedProviders)) {
    const seen = new Set<string>();
    for (const provider of raw.allowedProviders) {
      if (typeof provider !== "string") continue;
      const trimmed = provider.trim();
      if (trimmed === "" || seen.has(trimmed)) continue;
      seen.add(trimmed);
      allowedProviders.push(trimmed);
    }
  }

  const agentModels: Record<string, string> = {};
  if (isPlainObject(raw.agentModels)) {
    for (const [type, model] of Object.entries(raw.agentModels)) {
      const trimmedType = type.trim();
      if (trimmedType === "") continue;
      if (typeof model !== "string") continue;
      const trimmedModel = model.trim();
      if (trimmedModel === "") continue;
      agentModels[trimmedType] = trimmedModel;
    }
  }

  return { enabled, allowedProviders, agentModels };
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
