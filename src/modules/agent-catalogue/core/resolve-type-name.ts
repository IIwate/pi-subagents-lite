/**
 * resolve-type-name.ts — Deterministic Agent type name resolution.
 *
 * Truth table (REQ-AGENT-004): exact canonical > unique case-folded canonical
 * > unique display-name alias; any collision is reported as `ambiguous` with
 * candidates instead of silently picking Map insertion order. Canonical
 * matching completes before display names are consulted, so an alias can
 * never shadow a later-registered canonical name.
 *
 * Candidate ordering is plain code-unit sort, not locale collation: guidance
 * and tool errors must be byte-stable across platforms.
 */

import { Check } from "typebox/value";
import {
  AgentTypeResolutionSchema,
  ResolveAgentTypeNameQuerySchema,
  type AgentTypeResolution,
} from "../contracts/catalogue-contracts.js";

export function resolveAgentTypeName(query: unknown): AgentTypeResolution {
  if (!Check(ResolveAgentTypeNameQuerySchema, query)) {
    throw new TypeError("Agent type resolution query is invalid.");
  }
  return outbound(resolve(query.name, query.entries));
}

function outbound(resolution: AgentTypeResolution): AgentTypeResolution {
  if (!Check(AgentTypeResolutionSchema, resolution)) {
    throw new TypeError("Agent type resolution violates its contract.");
  }
  return resolution;
}

function resolve(
  name: string,
  entries: ReadonlyArray<{ name: string; displayName?: string }>,
): AgentTypeResolution {
  if (name === "") return { kind: "not-found" };

  for (const entry of entries) {
    if (entry.name === name) return { kind: "resolved", name: entry.name, matchedBy: "exact" };
  }

  const folded = name.toLowerCase();
  const canonicalHits = entries
    .filter((entry) => entry.name.toLowerCase() === folded)
    .map((entry) => entry.name);
  if (canonicalHits.length === 1) {
    return { kind: "resolved", name: canonicalHits[0], matchedBy: "case-folded" };
  }
  if (canonicalHits.length > 1) {
    return { kind: "ambiguous", candidates: sortedUnique(canonicalHits) };
  }

  const displayHits = entries
    .filter((entry) => (entry.displayName ?? "").toLowerCase() === folded && folded !== "")
    .map((entry) => entry.name);
  const uniqueTargets = sortedUnique(displayHits);
  if (uniqueTargets.length === 1) {
    return { kind: "resolved", name: uniqueTargets[0], matchedBy: "display-name" };
  }
  if (uniqueTargets.length > 1) {
    return { kind: "ambiguous", candidates: uniqueTargets };
  }

  return { kind: "not-found" };
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}
