export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
}

export type TaskThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Resolved execution values supplied after catalogue, model, and input validation. */
export interface TaskPolicy {
  readonly agent: string;
  readonly model: ModelIdentity;
  readonly thinkingLevel: TaskThinkingLevel;
  readonly tools: readonly string[];
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
    cwd: policy.cwd,
    systemPrompt: policy.systemPrompt,
    limits: Object.freeze({
      maxTurns: policy.limits.maxTurns,
      graceTurns: policy.limits.graceTurns,
      maxTokens: policy.limits.maxTokens,
    }),
  });
}
