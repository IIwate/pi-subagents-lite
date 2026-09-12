import type { Model } from "@earendil-works/pi-ai";

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
  /** Available catalogue when the registry has no full-catalogue query. */
  getAvailable?: () => Array<Model<any>>;
}

/**
 * Resolve an explicit model ref with exact matching only (no silent fallback).
 *
 * - "provider/id" → registry.find(provider, id)
 * - bare id → catalogue models where model.id === bare id (exact)
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
