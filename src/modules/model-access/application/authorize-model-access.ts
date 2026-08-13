import { Check } from "typebox/value";
import {
  AuthorizeModelCommandSchema,
  type AuthorizeModelResult,
} from "../contracts/model-access-contracts.js";
import { decideModelAuthorization } from "../core/authorize-model.js";

export function authorizeModelAccess(command: unknown): AuthorizeModelResult {
  if (!Check(AuthorizeModelCommandSchema, command)) {
    return {
      ok: false,
      error: { code: "invalid-command", message: "Model access command is invalid." },
    };
  }
  return decideModelAuthorization(command);
}
