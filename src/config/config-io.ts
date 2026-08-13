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
import type { AgentSettings, ModelRoutingConfig, SubagentsConfig } from "./types.js";
import { parseModelAccessFragment } from "../modules/model-access/public.js";

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

function normalizeModelRouting(raw: unknown): ModelRoutingConfig {
  return parseModelAccessFragment(raw);
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
