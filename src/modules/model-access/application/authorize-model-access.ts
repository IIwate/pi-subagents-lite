import { Check } from "typebox/value";
import {
  AuthorizeModelCommandSchema,
  AuthorizeModelResultSchema,
  type AuthorizeModelResult,
} from "../contracts/model-access-contracts.js";
import { decideModelAuthorization } from "../core/authorize-model.js";

function failure(message: string): AuthorizeModelResult {
  return { ok: false, error: { code: "invalid-command", message } };
}

function outbound(result: AuthorizeModelResult): AuthorizeModelResult {
  return Check(AuthorizeModelResultSchema, result)
    ? result
    : failure("Model access result does not match its contract.");
}

export function authorizeModelAccess(command: unknown): AuthorizeModelResult {
  if (!Check(AuthorizeModelCommandSchema, command)) {
    return outbound(failure("Model access command is invalid."));
  }
  return outbound(decideModelAuthorization(command));
}
