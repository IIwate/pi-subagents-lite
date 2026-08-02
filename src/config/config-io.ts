/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Legacy migration (one-time, no long-lived compat branches): the pre-1.2
 * shape (allowCrossProvider + dynamic agent[type] model keys + agent.default)
 * is normalized to modelRouting at load. Old model fields are dropped from
 * the file on the next explicit save via key pruning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseModelKey } from "../utils.js";
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

/**
 * Known agent setting keys. Anything else on agent (legacy dynamic model
 * keys, the retired `default`) is pruned on load and on every save.
 */
export const AGENT_SETTING_KEYS: readonly (keyof AgentSettings)[] = [
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
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to handle.
 */
export function loadConfig(): SubagentsConfig {
  let raw: SubagentsConfig;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as SubagentsConfig;
  } catch {
    raw = {} as SubagentsConfig;
  }

  const legacy = raw as SubagentsConfig & {
    allowCrossProvider?: boolean;
    modelRouting?: Partial<ModelRoutingConfig>;
    agent?: Record<string, unknown>;
  };

  // @ts-expect-error TS2783: spread may override 'default', which is intentional (loaded value wins)
  const concurrency = { default: 4, ...(raw.concurrency ?? {}) } as SubagentsConfig["concurrency"];
  return {
    modelRouting: migrateModelRouting(legacy),
    agent: pickAgentSettings({ ...DEFAULT_AGENT, ...legacy.agent }),
    concurrency,
  };
}

/**
 * Normalize the persisted routing policy, migrating the pre-1.2 shape:
 *   - allowCrossProvider → modelRouting.enabled
 *   - dynamic agent[type] model strings → modelRouting.agentModels[type],
 *     with their provider joining the allowlist
 *   - agent.default has no successor — it is dropped with a warning; agents
 *     without an assignment inherit the parent model.
 */
function migrateModelRouting(raw: SubagentsConfig & {
  allowCrossProvider?: boolean;
  modelRouting?: Partial<ModelRoutingConfig>;
  agent?: Record<string, unknown>;
}): ModelRoutingConfig {
  const routing = raw.modelRouting ?? {};

  const allowedProviders = new Set<string>();
  for (const provider of routing.allowedProviders ?? []) {
    if (typeof provider === "string" && provider.length > 0) allowedProviders.add(provider);
  }

  const agentModels: Record<string, string> = {};
  for (const [type, model] of Object.entries(routing.agentModels ?? {})) {
    if (typeof model === "string" && model.length > 0) agentModels[type] = model;
  }

  // Legacy dynamic model keys: any agent key that is not a real setting.
  // The retired `default` key is explicitly excluded — it is dropped with a
  // warning, never migrated into an assignment for an agent type named default.
  for (const [key, value] of Object.entries(raw.agent ?? {})) {
    if ((AGENT_SETTING_KEYS as readonly string[]).includes(key)) continue;
    if (key === "default") continue;
    if (typeof value === "string" && value.length > 0) {
      agentModels[key] = value;
      const parsed = parseModelKey(value);
      if (parsed) allowedProviders.add(parsed.provider);
    }
  }

  if (raw.agent?.default != null) {
    console.warn(
      "[pi-subagents-lite] Legacy agent.default model is retired and ignored; "
      + "agents without an assignment now inherit the parent model.",
    );
  }

  return {
    enabled: routing.enabled ?? raw.allowCrossProvider === true,
    allowedProviders: [...allowedProviders],
    agentModels,
  };
}

/** Keep only known agent settings; drops legacy model fields and retired keys. */
function pickAgentSettings(agent: Record<string, unknown>): AgentSettings {
  const out: Partial<AgentSettings> = {};
  for (const key of AGENT_SETTING_KEYS) {
    if (agent[key] !== undefined) (out as Record<string, unknown>)[key] = agent[key];
  }
  return out as AgentSettings;
}

/** Write config to disk with atomic rename. Legacy model fields are pruned. */
export function saveConfigAtomic(config: SubagentsConfig): void {
  const tmpPath = CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const pruned: SubagentsConfig = {
      ...config,
      agent: pickAgentSettings(config.agent as unknown as Record<string, unknown>),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(pruned, null, 2), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${err}`);
  }
}
