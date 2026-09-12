import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentModelAccess, AgentSettings, ProviderModelAccess, SubagentsConfig } from "./types.js";

const CONFIG_DIR = getAgentDir();
export const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite-v3.json");
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

/** Parse the current configuration at the file boundary; invalid files fail visibly. */
export function parseConfig(input: unknown): SubagentsConfig {
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!isPlainObject(value)) throw new Error(`Invalid config object: ${field}`);
    return value;
  };
  const keys = (value: Record<string, unknown>, allowed: readonly string[], field: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown config field: ${field}.${key}`);
  };
  const strings = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`Invalid config string list: ${field}`);
    return [...new Set(value.map(item => item.trim()))];
  };
  const limit = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid concurrency limit: ${field}`);
    return value;
  };
  const root = object(input, "root");
  keys(root, ["agent", "concurrency", "modelRouting"], "root");
  const rawAgent = object(root.agent === undefined ? {} : root.agent, "agent");
  keys(rawAgent, AGENT_SETTING_KEYS, "agent");
  for (const [key, value] of Object.entries(rawAgent)) {
    if (key === "graceTurns") validateGraceTurns(value as number);
    else if (key === "systemPromptMode") {
      if (typeof value !== "string" || !VALID_SYSTEM_PROMPT_MODES.has(value)) throw new Error("Invalid system prompt mode");
    } else if (key === "defaultThinking") {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)) throw new Error("Invalid default thinking level");
    } else if (typeof value !== "boolean") throw new Error(`Invalid boolean setting: agent.${key}`);
  }
  const concurrency = object(root.concurrency === undefined ? {} : root.concurrency, "concurrency");
  keys(concurrency, ["default", "providers", "models"], "concurrency");
  const overrides = (field: "providers" | "models") => concurrency[field] === undefined ? undefined
    : Object.fromEntries(Object.entries(object(concurrency[field], `concurrency.${field}`)).map(([key, value]) => [key, limit(value, key)]));
  const routing = object(root.modelRouting === undefined ? {} : root.modelRouting, "modelRouting");
  keys(routing, ["enabled", "enabledProviders", "agentAccess"], "modelRouting");
  if (routing.enabled !== undefined && typeof routing.enabled !== "boolean") throw new Error("Invalid model routing switch");
  const agentAccess: Record<string, AgentModelAccess> = {};
  for (const [type, rawAccess] of Object.entries(object(routing.agentAccess === undefined ? {} : routing.agentAccess, "agentAccess"))) {
    if (!type.trim()) throw new Error("Empty agent access key");
    const access = object(rawAccess, type);
    keys(access, ["providers"], type);
    const providers: Record<string, ProviderModelAccess> = {};
    for (const [provider, rawRule] of Object.entries(object(access.providers, `${type}.providers`))) {
      if (!provider.trim()) throw new Error("Empty provider access key");
      const rule = object(rawRule, provider);
      keys(rule, ["models"], provider);
      const models = rule.models === undefined ? undefined : strings(rule.models, provider);
      if (models?.length === 0) throw new Error(`Empty model allowlist: ${provider}`);
      setOwn(providers, provider, models ? { models } : {});
    }
    setOwn(agentAccess, type, { providers });
  }
  return {
    agent: { ...DEFAULT_AGENT, ...rawAgent },
    concurrency: { default: concurrency.default === undefined ? DEFAULT_CONCURRENCY.default : limit(concurrency.default, "default"),
      providers: overrides("providers"), models: overrides("models") },
    modelRouting: { enabled: routing.enabled === true,
      enabledProviders: routing.enabledProviders === undefined ? [] : strings(routing.enabledProviders, "enabledProviders"), agentAccess },
  };
}

export function loadConfig(configPath = CONFIG_PATH): SubagentsConfig {
  let content: string;
  try { content = fs.readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw error;
  }
  try { return parseConfig(JSON.parse(content)); } catch (error) {
    throw new Error(`Invalid subagent configuration ${configPath}: ${error}`, { cause: error });
  }
}

/** Write config to disk with atomic rename. */
export function saveConfigAtomic(config: SubagentsConfig, configPath = CONFIG_PATH): void {
  const content = JSON.stringify(parseConfig(config), null, 2);
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTemporary = false;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fd = fs.openSync(tmpPath, "wx");
    ownsTemporary = true;
    fs.writeFileSync(fd, content, "utf-8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, configPath);
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
