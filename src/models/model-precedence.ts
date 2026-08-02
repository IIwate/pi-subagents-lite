/**
 * model-precedence.ts — Model resolution and authorization, pure functions.
 *
 * No side effects, no file I/O, no pi SDK imports.
 *
 * Resolution chain (highest to lowest), consulted only when routing is ON:
 *   1. sessionOverrides[subagentType]  (session assignment)
 *        - string → that model, stops the chain
 *        - null   → the parent model, stops the chain (explicit session inherit)
 *        - absent → continue
 *   2. modelRouting.agentModels[type]  (persistent assignment)
 *   3. agentConfig?.model              (agent config / frontmatter)
 *   4. parentModelId                   (inherit from parent)
 *
 * When routing is OFF callers use the exact parent model and never consult
 * this chain; authorizeModel enforces that strict boundary (even explicit
 * same-provider models are rejected).
 */

import type { SessionModelOverrides, SubagentsConfig } from "../config/types.js";

export interface ResolvedModelSelection {
  model: string;
  source: "automatic" | "parent";
}

/** Options for resolveModelSelection. */
export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The global subagents-lite.json config (routing + agent settings). */
  config: SubagentsConfig;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only assignments (checked first). */
  sessionOverrides?: SessionModelOverrides;
}

/**
 * Resolve the model candidate under routing. Provenance stays separate from
 * the string value so "automatic" is preserved even when the chosen model
 * spells exactly like the parent's.
 *
 * A session `null` means "this session explicitly inherits the parent" and
 * short-circuits the chain — persistent assignments and frontmatter are not
 * consulted.
 */
export function resolveModelSelection(options: ResolveModelOptions): ResolvedModelSelection {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides } = options;

  const sessionValue = sessionOverrides?.[subagentType];
  // Empty strings are treated as absent; null is a real "inherit parent" value.
  if (sessionValue !== undefined && sessionValue !== "") {
    return sessionValue === null
      ? { model: parentModelId, source: "parent" }
      : { model: sessionValue, source: "automatic" };
  }

  const automaticCandidates: Array<string | null | undefined> = [
    config.modelRouting.agentModels[subagentType],
    agentConfig?.model,
  ];
  const automaticModel = automaticCandidates.find(isValidValue);
  return automaticModel
    ? { model: automaticModel, source: "automatic" }
    : { model: parentModelId, source: "parent" };
}

/** Reason a resolved model failed the routing/scope policy. */
export type ModelAuthorizationVerdict =
  | { ok: true }
  | { ok: false; reason: "out-of-scope" | "routing-disabled" | "provider-not-allowed" };

/** Context needed to authorize a resolved model key. */
export interface ModelAuthorizationContext {
  /** "provider/model" key of the candidate model. */
  modelKey: string;
  /** "provider/model" key of the parent session model; empty when the parent has none. */
  parentModelKey: string;
  /** Provider of the parent session model; empty when the parent has none. */
  parentProvider: string;
  /** Extra allowed providers (the parent provider is implicit). */
  allowedProviders: readonly string[];
  /** Cross-provider routing switch. */
  routingEnabled: boolean;
  /** Active model scope keys; null = unrestricted. */
  scopedKeys: ReadonlySet<string> | null;
}

/**
 * Authorize a resolved model under the routing policy.
 *
 * Order matters: the scope gate applies to every spawn; the exact parent
 * model is always authorized; routing OFF authorizes only the parent model
 * (same-provider lookalikes are rejected); routing ON authorizes the parent
 * provider and the allowlist.
 */
export function authorizeModel(ctx: ModelAuthorizationContext): ModelAuthorizationVerdict {
  const { modelKey, parentModelKey, parentProvider, allowedProviders, routingEnabled, scopedKeys } = ctx;

  if (scopedKeys && !scopedKeys.has(modelKey)) {
    return { ok: false, reason: "out-of-scope" };
  }
  if (parentModelKey && modelKey === parentModelKey) {
    return { ok: true };
  }
  if (!routingEnabled) {
    return { ok: false, reason: "routing-disabled" };
  }
  const slashIdx = modelKey.indexOf("/");
  const provider = slashIdx > 0 ? modelKey.slice(0, slashIdx) : modelKey;
  if (provider === parentProvider || allowedProviders.includes(provider)) {
    return { ok: true };
  }
  return { ok: false, reason: "provider-not-allowed" };
}

/**
 * Check if a value is a valid non-empty model string.
 * Returns true for non-null, non-undefined, non-empty strings.
 */
function isValidValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
