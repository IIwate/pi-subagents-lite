import { Check } from "typebox/value";
import {
  AcceptedRunPolicySchema,
  type AcceptedRunPolicy,
} from "../contracts/accepted-run-policy.js";

export function isAcceptedRunPolicy(value: unknown): value is AcceptedRunPolicy {
  try {
    return Check(AcceptedRunPolicySchema, JSON.parse(JSON.stringify(value)));
  } catch {
    return false;
  }
}
