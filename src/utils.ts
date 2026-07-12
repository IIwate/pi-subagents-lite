/**
 * utils.ts — Security helpers and general utilities.
 *
 * Security helpers (isUnsafeName, isSymlink, safeReadFile) protect against
 * path traversal and symlink attacks in agent/skill name resolution.
 */

import { lstatSync, readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  try {
    if (isSymlink(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** Common thinking levels shown in menus. Free-form values are also accepted at runtime. */
export const VALID_THINKING_LEVELS: readonly string[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;

/**
 * Normalize a raw thinking value.
 * Accepts any non-empty string (not restricted to VALID_THINKING_LEVELS),
 * so provider-specific levels can pass through.
 */
export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  /** Optional; used to resolve bare model ids (no provider prefix). */
  getAvailable?: () => Array<Model<any>>;
}

/**
 * Parse a model tool argument that may embed thinking as `model:thinking`.
 *
 * Supported forms:
 *   - "grok-4.5"
 *   - "cpa-responses/grok-4.5"
 *   - "grok-4.5:low"
 *   - "cpa-responses/grok-4.5:low"
 *   - "grok-4.5:custom-level"  (free-form thinking, not restricted to known levels)
 *
 * When a `:` is present and both sides are non-empty, the suffix after the
 * last `:` is always treated as thinking (no allowlist check).
 */
export function parseModelSpec(raw: string | undefined): {
  modelRef: string | undefined;
  thinkingFromModel?: ThinkingLevel;
} {
  if (raw === undefined) return { modelRef: undefined };
  const trimmed = raw.trim();
  if (!trimmed) return { modelRef: undefined };

  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx > 0) {
    const modelRef = trimmed.slice(0, colonIdx).trim();
    const thinkingFromModel = parseThinkingLevel(trimmed.slice(colonIdx + 1));
    if (modelRef && thinkingFromModel !== undefined) {
      return { modelRef, thinkingFromModel };
    }
  }

  return { modelRef: trimmed };
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

  const available = registry.getAvailable?.() ?? [];
  const exact = available.filter((m) => m.id === trimmed);
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
    `Optional thinking shorthand: "grok-4.5:low". ` +
    `List available models first (e.g. via your model list / list-models), then retry with a valid id.`
  );
}

/**
 * Find a model in the registry by "provider/model-id" or bare model id.
 * Returns the found model, or the fallback if not found / empty input.
 *
 * Prefer resolveExactModel() for explicit LLM-provided model args (no silent fallback).
 */
export function findModelInRegistry(
  modelStr: string | undefined,
  registry: ModelLookupRegistry,
  fallback: Model<any> | undefined,
): Model<any> | undefined {
  if (!modelStr) return fallback;

  const trimmed = modelStr.trim();
  if (!trimmed) return fallback;

  return resolveExactModel(trimmed, registry, fallback?.provider) ?? fallback;
}
/** Timeout for git commands (ms). Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;
