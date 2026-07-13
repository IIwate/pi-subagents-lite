/**
 * model-scope.ts — Constrain subagent models to the active pi Model scope.
 *
 * Source of patterns (same precedence as pi startup):
 *   1. CLI `--models` (comma-separated patterns)
 *   2. settings.json `enabledModels` (from `/scoped-models` + Ctrl+S)
 *
 * When no patterns are set (or none resolve), there is no scope restriction.
 *
 * Pattern matching is intentionally local (exact + simple globs) so we do not
 * depend on pi SDK exports that vary across 0.80.x minor versions.
 *
 * Note: session-only `/scoped-models` changes that were not saved with Ctrl+S
 * are not visible to extensions (AgentSession.scopedModels is not on ExtensionContext).
 */

import {
  getAgentDir,
  SettingsManager,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { VALID_THINKING_LEVELS } from "../utils.js";

/** Canonical model key used in scope sets and menu options. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Parse CLI `--models <patterns>` from argv.
 * Returns undefined when the flag is absent or empty.
 */
export function parseCliModelPatterns(argv: string[] = process.argv): string[] | undefined {
  const idx = argv.indexOf("--models");
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const parts = argv[idx + 1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Load model-scope patterns using pi's startup precedence:
 * CLI `--models` wins over settings `enabledModels`.
 */
export function loadModelScopePatterns(
  cwd: string,
  argv: string[] = process.argv,
): string[] | undefined {
  const fromCli = parseCliModelPatterns(argv);
  if (fromCli) return fromCli;
  return SettingsManager.create(cwd, getAgentDir()).getEnabledModels();
}

/**
 * Strip a known thinking-level suffix (`model:high`) from a scope pattern.
 * Leaves colons that are part of a model id alone when the suffix is not a
 * known thinking level.
 */
export function stripThinkingSuffix(pattern: string): string {
  const colonIdx = pattern.lastIndexOf(":");
  if (colonIdx <= 0) return pattern;
  const suffix = pattern.slice(colonIdx + 1).trim();
  if ((VALID_THINKING_LEVELS as readonly string[]).includes(suffix)) {
    return pattern.slice(0, colonIdx);
  }
  return pattern;
}

/** Convert a simple glob (`*`, `?`) to a case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * True when a scope pattern matches a model (full `provider/id` or bare id).
 * Supports exact match and `*` / `?` globs (pi `--models` / enabledModels style).
 */
export function patternMatchesModel(
  pattern: string,
  model: { provider: string; id: string },
): boolean {
  const normalized = stripThinkingSuffix(pattern.trim());
  if (!normalized) return false;

  const fullId = modelKey(model);
  const hasGlob = normalized.includes("*") || normalized.includes("?");

  if (!hasGlob) {
    return fullId === normalized || model.id === normalized;
  }

  const re = globToRegExp(normalized);
  return re.test(fullId) || re.test(model.id);
}

/**
 * Resolve patterns against available models into a set of `provider/id` keys.
 * Returns null when there is no active scope (all models allowed).
 */
export function resolveScopedModelKeysFromPatterns(
  patterns: string[] | undefined | null,
  available: ReadonlyArray<{ provider: string; id: string }>,
): Set<string> | null {
  if (!patterns || patterns.length === 0) return null;

  const keys = new Set<string>();
  for (const pattern of patterns) {
    for (const model of available) {
      if (patternMatchesModel(pattern, model)) {
        keys.add(modelKey(model));
      }
    }
  }
  return keys.size > 0 ? keys : null;
}

/**
 * Resolve the active Model scope for the current session context.
 * Returns null when unrestricted.
 */
export function getActiveScopedModelKeys(
  modelRegistry: ModelRegistry,
  cwd: string,
  argv: string[] = process.argv,
): Set<string> | null {
  const patterns = loadModelScopePatterns(cwd, argv);
  return resolveScopedModelKeysFromPatterns(patterns, modelRegistry.getAvailable());
}

/** True when model is allowed (always true when scopedKeys is null). */
export function isModelInScope(
  model: { provider: string; id: string },
  scopedKeys: ReadonlySet<string> | null,
): boolean {
  if (!scopedKeys) return true;
  return scopedKeys.has(modelKey(model));
}

/** Build a clear LLM/user-facing error for an out-of-scope model. */
export function outOfScopeModelError(
  modelRef: string,
  scopedKeys: ReadonlySet<string>,
): string {
  const allowed = [...scopedKeys].sort();
  const preview =
    allowed.length <= 8
      ? allowed.join(", ")
      : `${allowed.slice(0, 8).join(", ")}, ... (${allowed.length} total)`;
  return (
    `Model "${modelRef}" is not in the active model scope. ` +
    `Allowed: ${preview}. ` +
    `Adjust with /scoped-models (and Ctrl+S to persist) or pick a model from the scope list.`
  );
}

/**
 * List model options for menus, filtered to the active scope when present.
 * Falls back to all available models when unrestricted.
 */
export function listModelOptionsForMenus(
  modelRegistry: ModelRegistry,
  cwd: string,
): string[] {
  const available = modelRegistry.getAvailable();
  const all = available.map((m: Model<any>) => modelKey(m));
  const scopedKeys = getActiveScopedModelKeys(modelRegistry, cwd);
  if (!scopedKeys) return all;
  return all.filter((key) => scopedKeys.has(key));
}

/**
 * Resolve scoped Model objects for createAgentSession (inherits parent scope).
 * Returns undefined when unrestricted so createAgentSession keeps an empty scope.
 */
export function getActiveScopedModels(
  modelRegistry: ModelRegistry,
  cwd: string,
  argv: string[] = process.argv,
): Array<{ model: Model<any> }> | undefined {
  const scopedKeys = getActiveScopedModelKeys(modelRegistry, cwd, argv);
  if (!scopedKeys) return undefined;

  return modelRegistry
    .getAvailable()
    .filter((m: Model<any>) => scopedKeys.has(modelKey(m)))
    .map((m: Model<any>) => ({ model: m }));
}
