/**
 * utils.ts — Security helpers and general utilities.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";
import { CANONICAL_THINKING_LEVELS } from "./config/types.js";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Normalize a raw Pi canonical thinking value.
 */
export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return (CANONICAL_THINKING_LEVELS as readonly string[]).includes(trimmed)
    ? trimmed as ThinkingLevel
    : undefined;
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
  if (slashIdx <= 0 || slashIdx === modelStr.length - 1) return null;
  return { provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
}

/** Minimal registry surface used for model lookup. */
export interface ModelLookupRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
}

/**
 * Resolve an explicit model ref with exact matching only (no silent fallback).
 *
 * Only canonical "provider/id" keys are accepted.
 */
export function resolveExactModel(
  modelRef: string,
  registry: ModelLookupRegistry,
): Model<any> | undefined {
  const parsed = parseModelKey(modelRef.trim());
  return parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
}

/** Build a helpful error when an explicit model ref cannot be resolved. */
export function unknownModelError(modelRef: string): string {
  return (
    `Unknown model id: "${modelRef}". ` +
    `Use an exact canonical provider/model key (e.g. "cpa-responses/grok-4.5"). ` +
    "List available models first, then retry with a valid key."
  );
}

/** Timeout for git commands (ms). Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;
