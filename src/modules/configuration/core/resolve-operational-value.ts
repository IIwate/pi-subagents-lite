import { Check } from "typebox/value";
import {
  OperationalValueCandidatesSchema,
  type OperationalValueCandidates,
} from "../contracts/configuration-contracts.js";

/**
 * Resolve one operational setting with the fixed source precedence:
 * environment variable > `.env` value > configured file value > capability
 * fallback.
 *
 * An empty string counts as absent at every step. This preserves the
 * historical `process.env.HOME || ""` behavior: a set-but-empty variable must
 * not shadow a usable lower-precedence source. Revisit if an operational
 * setting ever needs a deliberately empty override.
 *
 * Inbound Check is fail-closed: a caller that invents a fourth source or
 * drops fallback would otherwise resolve from a shape this contract never
 * named. Throw rather than guess a home directory from garbage.
 */
export function resolveOperationalValue(candidates: OperationalValueCandidates): string {
  if (!Check(OperationalValueCandidatesSchema, candidates)) {
    throw new TypeError("Operational value candidates do not match their contract.");
  }
  for (const candidate of [candidates.environment, candidates.dotEnv, candidates.configured]) {
    if (candidate !== undefined && candidate !== "") return candidate;
  }
  return candidates.fallback;
}
