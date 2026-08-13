import type { OperationalValueCandidates } from "../contracts/configuration-contracts.js";

/**
 * Resolve one operational setting with the fixed source precedence:
 * environment variable > `.env` value > configured file value > capability
 * fallback.
 *
 * An empty string counts as absent at every step. This preserves the
 * historical `process.env.HOME || ""` behavior: a set-but-empty variable must
 * not shadow a usable lower-precedence source. Revisit if an operational
 * setting ever needs a deliberately empty override.
 */
export function resolveOperationalValue(candidates: OperationalValueCandidates): string {
  for (const candidate of [candidates.environment, candidates.dotEnv, candidates.configured]) {
    if (candidate !== undefined && candidate !== "") return candidate;
  }
  return candidates.fallback;
}
