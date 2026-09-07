/**
 * utils.ts — Security helpers and general utilities.
 */
import type { Model } from "@earendil-works/pi-ai";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** Normalize input before model-aware validation at the Agent entry point. */
export function parseThinkingLevel(raw: string | undefined): string | undefined {
  return raw?.trim().toLowerCase() || undefined;
}

/**
 * Safely extract a human-readable error message from an unknown exception.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a "provider/model-id" string into { provider, modelId }.
 * Returns null if the format is invalid (no slash or empty provider).
 */
export function parseModelKey(modelStr: string): { provider: string; modelId: string } | null {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx <= 0) return null;
  return { provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
}

/** Minimal registry surface used for model lookup. */
export interface ModelLookupRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  /** Full loaded catalogue, used for exact bare-ID resolution before authorization. */
  getAll?: () => Array<Model<any>>;
  /** Compatibility fallback for minimal registries in tests/integrations. */
  getAvailable?: () => Array<Model<any>>;
}

/**
 * Resolve an explicit model ref with exact matching only (no silent fallback).
 *
 * - "provider/id" → registry.find(provider, id)
 * - bare id → available models where model.id === bare id (exact)
 *
 * When multiple providers share the same id, prefer preferredProvider if set,
 * otherwise the first match.
 */
export function resolveExactModel(
  modelRef: string,
  registry: ModelLookupRegistry,
  preferredProvider?: string,
): Model<any> | undefined {
  const trimmed = modelRef.trim();
  if (!trimmed) return undefined;

  const parsed = parseModelKey(trimmed);
  if (parsed) {
    return registry.find(parsed.provider, parsed.modelId);
  }

  const registered = registry.getAll?.() ?? registry.getAvailable?.() ?? [];
  const exact = registered.filter((m) => m.id === trimmed);
  if (exact.length === 0) return undefined;
  if (exact.length === 1) return exact[0];
  if (preferredProvider) {
    const sameProvider = exact.find((m) => m.provider === preferredProvider);
    if (sameProvider) return sameProvider;
  }
  return exact[0];
}

/** Build a helpful error when an explicit model ref cannot be resolved. */
export function unknownModelError(modelRef: string): string {
  return (
    `Unknown model id: "${modelRef}". ` +
    `Use a bare model id that exactly matches an available model (e.g. "grok-4.5"), ` +
    `or "provider/model-id" (e.g. "cpa-responses/grok-4.5"). ` +
    `Set thinking with the separate "thinking" parameter (e.g. "low"). ` +
    `List available models first (e.g. via your model list / list-models), then retry with a valid id.`
  );
}

/** Timeout for git commands (ms). Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;
