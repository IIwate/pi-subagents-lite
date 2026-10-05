export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
}

export type TaskThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Note: see .agents/notes/implemented/architecture/2026-09-30-native-pi-tool-host-and-source-grants.md
export interface ToolSourceGrant {
  readonly source: string;
  readonly tools: true | readonly string[];
  readonly exclude: readonly string[];
}

/** Tool patterns recognize only '*'; all other characters are literal. */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);
}

export function permitsSourceTool(grant: ToolSourceGrant, name: string): boolean {
  return !grant.exclude.some(pattern => matchesToolPattern(name, pattern))
    && (grant.tools === true || grant.tools.some(pattern => matchesToolPattern(name, pattern)));
}

/** Resolved execution values supplied after catalogue, model, and input validation. */
export interface TaskPolicy {
  readonly agent: string;
  readonly model: ModelIdentity;
  readonly thinkingLevel: TaskThinkingLevel;
  readonly tools: readonly string[];
  readonly toolSources?: readonly ToolSourceGrant[];
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly limits: {
    readonly maxTurns?: number;
    readonly graceTurns: number;
    readonly maxTokens?: number;
  };
}

/** Own the accepted values without cloning or freezing a host's model object. */
export function freezePolicy(policy: TaskPolicy): TaskPolicy {
  return Object.freeze({
    agent: policy.agent,
    model: Object.freeze({ provider: policy.model.provider, id: policy.model.id }),
    thinkingLevel: policy.thinkingLevel,
    tools: Object.freeze([...policy.tools]),
    ...(policy.toolSources ? { toolSources: Object.freeze(policy.toolSources.map(grant => Object.freeze({
      source: grant.source, tools: grant.tools === true ? true : Object.freeze([...grant.tools]),
      exclude: Object.freeze([...grant.exclude]),
    }))) } : {}),
    cwd: policy.cwd,
    systemPrompt: policy.systemPrompt,
    limits: Object.freeze({
      maxTurns: policy.limits.maxTurns,
      graceTurns: policy.limits.graceTurns,
      maxTokens: policy.limits.maxTokens,
    }),
  });
}
